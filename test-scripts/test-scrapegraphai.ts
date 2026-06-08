/**
 * test-scrapegraphai.ts — self-contained live test for the ScrapeGraphAI scraping API.
 *
 * WHAT IT TESTS
 *   Re-runs the frozen 2026 benchmark for one provider (scrapegraphai) against a
 *   fixed table of 20 target domains. 18 are "operational" (we actually fetch them
 *   and check PASS/FAIL); 2 are "genuine_fail" rows that we DO NOT request — we just
 *   print a SKIP line with the recorded reason code. For each operational domain we
 *   run N trials (default 3) and report a per-domain success rate + average latency.
 *
 *   Verification rule (identical to the Python sibling):
 *     - stringify the JSON response,
 *     - count how many of the domain's verify_keys appear as substrings,
 *     - PASS when hits >= need_at_least.
 *
 * PROVIDER QUIRKS (from the slice request_recipe + quirks):
 *   - Transport: POST JSON.
 *   - Auth: HTTP header  "SGAI-APIKEY: <token>"  (NOT a query param, NOT Bearer).
 *   - Endpoint: each domain carries its own endpoint_override, one of
 *       /v1/scrape-markdown            (Tier 1, 1 credit)
 *       /v1/scrape-markdown-stealth-js (Tier 2, 6 credits)
 *       /v1/scrape-stealth-js          (Tier 2, 6 credits)
 *     We POST to that exact override URL.
 *   - Body: {"website_url": "<target url>"}.
 *   - Response: JSON object with a markdown/html content field. The output is
 *     MARKDOWN-FIRST, but verify_keys are still matched as plain substrings against
 *     the stringified JSON body (HTML tokens survive in the embedded content), so we
 *     just JSON.stringify() the whole response and substring-match.
 *
 * HOW TO RUN
 *   export SCRAPEGRAPHAI_TOKEN=sgai-xxxxxxxx        # see .env.example
 *   npx tsx test-scrapegraphai.ts                   # 3 trials per operational domain
 *   npx tsx test-scrapegraphai.ts --trials 5        # custom trial count
 *
 *   If SCRAPEGRAPHAI_TOKEN is unset the script prints a hint and exits 0 (never crashes).
 *
 * WHAT IT WRITES
 *   ../../test-results/scrapegraphai.run.json  (relative to this script's own dir,
 *   i.e. test-scripts/scrapegraphai/ -> test-results/). Same schema as the frozen file:
 *   {provider, report_date(today), frozen:false, endpoint, auth_env, summary, domains}.
 *   avg_cost_per_1k_usd is copied from the frozen slice (cost is not measured live)
 *   and tagged "cost_source":"frozen".
 *
 * Node 18+ built-ins + global fetch only. Zero npm deps. Run via "npx tsx <file>".
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------------------- //
// Provider constants (frozen literals from the slice — do NOT read slice at runtime)
// --------------------------------------------------------------------------- //
const PROVIDER = "scrapegraphai";
const ENDPOINT = "https://api.scrapegraphai.com/v1";
const AUTH_ENV = "SCRAPEGRAPHAI_TOKEN";
// Frozen aggregate cost — cost is not measured live, so we copy this through.
const FROZEN_AVG_COST_PER_1K_USD = 6.44;

// Provider rate-limit / pacing quirk: ScrapeGraphAI requests are heavy (stealth-js
// can take 16-27s) and the API is credit-metered, so we pace politely between calls.
const PACE_MS = 1000;

interface DomainSpec {
  status: "operational" | "genuine_fail";
  url: string;
  tier: { params: Record<string, unknown>; endpoint_override: string | null };
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number | null;
  reason_code?: string;
}

// --------------------------------------------------------------------------- //
// DOMAINS table — embedded literals from the slice "domains" object.
// --------------------------------------------------------------------------- //
const DOMAINS: Record<string, DomainSpec> = {
  "amazon.com": {
    status: "operational",
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ["productTitle", 'id="dp-container"', 'id="centerCol"', 'data-asin="B07FZ8S74R"', "nav-logo-base"],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "bestbuy.com": {
    status: "genuine_fail",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["application/ld+json", '"@type":"Product"', '"sku":"6570601"', '"customerPrice"', "add-to-cart-button"],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "fetch_failed_502",
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ["<title>best laptops 2025 - Search</title>", 'id="b_content"', 'id="sb_form"', 'class="b_algo', 'class="b_attribution'],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "booking.com": {
    status: "operational",
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js" },
    verify_keys: ["hp_hotel_name", "data-capla-component-boundary", '"@type" : "Hotel"', '"hotelId":', '"reviewCount"'],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "capterra.com": {
    status: "operational",
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-stealth-js" },
    verify_keys: ["<title>Slack Software Pricing", '"@type":"SoftwareApplication"', '"name":"Slack"', 'data-testid="hero-section"', "/p/135003/Slack"],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js" },
    verify_keys: ["itm.ebaydesc.com", "ebayLogoTitle", '"product":', "p.ebaystatic.com", '"@type":"Product"'],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "g2.com": {
    status: "operational",
    url: "https://www.g2.com/products/slack/reviews",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js" },
    verify_keys: ["<title>Slack Reviews 2026", 'itemprop="ratingValue"', 'itemprop="reviewBody"', "products/slack/reviews", "Filter 39001 reviews"],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "github.com": {
    status: "operational",
    url: "https://github.com/microsoft/vscode",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ["<title>GitHub - microsoft/vscode", 'data-testid="latest-commit-details"', 'data-testid="view-all-files-row"', 'id="repository-container-header"', "github.com/microsoft/vscode"],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "google.com": {
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ['id="search"', 'id="rso"', 'id="rcnt"', "<title>python tutorial - Google Search</title>", 'itemtype="http://schema.org/SearchResultsPage"'],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "idealista.com": {
    status: "operational",
    url: "https://www.idealista.com/inmueble/110715434/",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js" },
    verify_keys: ['class="main-info__title-main"', 'class="info-data-price"', "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "indeed.com": {
    status: "operational",
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js" },
    verify_keys: ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>", 'data-jk="', 'class="job_seen_beacon', 'data-testid="company-name"', 'id="mosaic-provider-jobcards"'],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "instagram.com": {
    status: "operational",
    url: "https://www.instagram.com/nike/",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ['"username":"nike"', "<title>Nike (&#064;nike)", "instagram://user?username=nike", 'href="https://www.instagram.com/nike/"', 'og:type" content="profile"'],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "linkedin.com": {
    status: "operational",
    url: "https://www.linkedin.com/company/microsoft/",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ["<title>Microsoft | LinkedIn</title>", '"@type":"Organization"', "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "reddit.com": {
    status: "operational",
    url: "https://old.reddit.com/r/programming/",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ['id="siteTable"', 'data-fullname="t3_', 'data-subreddit="programming"', 'data-subreddit-prefixed="r/programming"', "<title>programming</title>"],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "tripadvisor.com": {
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ["Fairmont", "THE PLAZA NEW YORK", '"@type":"LodgingBusiness"', '"aggregateRating"', "data-automation"],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "trustpilot.com": {
    status: "operational",
    url: "https://www.trustpilot.com/review/amazon.com",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js" },
    verify_keys: ["data-service-review-card-paper", "data-service-review-rating", '"@type":"Organization"', '"@type":"AggregateRating"', "data-business-unit-json-ld"],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-stealth-js" },
    verify_keys: ["<title>Apple, AirPods with Charging Case", '"itemId":"604342441"', 'data-testid="price-wrap"', 'id="__NEXT_DATA__"', 'data-testid="hero-image-container"'],
    need_at_least: 2,
    cost_per_1k_usd: 12,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    tier: { params: {}, endpoint_override: "https://api.scrapegraphai.com/v1/scrape-markdown" },
    verify_keys: ['"channelMetadataRenderer"', '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"', "ytInitialData", '"title":"MrBeast"', '"subscriberCountText"'],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "zillow.com": {
    status: "genuine_fail",
    url: "https://www.zillow.com/columbus-oh/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ['data-testid="property-card"', '"zpid":', '"@type":"SingleFamilyResidence"', '"streetAddress"', '"bedrooms"'],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "empty_body",
  },
};

// Short human notes for the SKIP lines on genuine_fail rows.
const GENUINE_FAIL_NOTES: Record<string, string> = {
  fetch_failed_502: "502 fetch_failed on every config (PDP-specific).",
  empty_body: "200 + empty body on /columbus-oh_rb/.",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// Request builder — follows the slice request_recipe EXACTLY.
//   POST JSON {"website_url": url} to the domain's endpoint_override,
//   auth via header SGAI-APIKEY.
// --------------------------------------------------------------------------- //
async function doFetch(
  url: string,
  endpointOverride: string,
  token: string,
): Promise<{ status: number; text: string }> {
  try {
    const resp = await fetch(endpointOverride, {
      method: "POST",
      headers: {
        // Quirk: ScrapeGraphAI auth is a custom header, not Authorization/Bearer.
        "SGAI-APIKEY": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ website_url: url }),
    });
    const text = await resp.text();
    return { status: resp.status, text };
  } catch {
    return { status: 0, text: "" };
  }
}

/**
 * Response unwrapping per recipe: ScrapeGraphAI returns a JSON object whose
 * markdown/html content lives in a field. We stringify the whole JSON response
 * and substring-match verify_keys against it (markdown output, but HTML tokens
 * survive in the embedded content). If the body is not JSON, return it raw.
 */
function unwrap(_status: number, text: string): string {
  if (!text) return "";
  try {
    const obj = JSON.parse(text);
    // Re-serialize the entire parsed object so every nested content field is
    // available to the substring matcher.
    return JSON.stringify(obj);
  } catch {
    return text;
  }
}

// --------------------------------------------------------------------------- //
// verify() — IDENTICAL rule across both languages.
// Count how many verify_keys appear as substrings; PASS when hits >= need_at_least.
// --------------------------------------------------------------------------- //
function verify(body: string, verifyKeys: string[], needAtLeast: number): { ok: boolean; hits: number } {
  if (!body) return { ok: false, hits: 0 };
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return { ok: hits >= needAtLeast, hits };
}

interface DomainResult {
  status: "operational" | "genuine_fail";
  success_rate: number;
  avg_latency_ms: number | null;
  pass?: number;
  trials?: number;
  reason_code?: string;
}

// --------------------------------------------------------------------------- //
// Runner
// --------------------------------------------------------------------------- //
async function run(trials: number, token: string): Promise<Record<string, DomainResult>> {
  const results: Record<string, DomainResult> = {};
  for (const [domain, spec] of Object.entries(DOMAINS)) {
    // genuine_fail rows: DO NOT request. Print a SKIP line and record the row.
    if (spec.status === "genuine_fail") {
      const reason = spec.reason_code ?? "genuine_fail";
      const note = GENUINE_FAIL_NOTES[reason] ?? "";
      console.log(`SKIP ${domain}: ${reason} — ${note}`);
      results[domain] = { status: "genuine_fail", success_rate: 0, avg_latency_ms: null, reason_code: reason };
      continue;
    }

    const endpointOverride = spec.tier.endpoint_override as string;
    let passes = 0;
    const latencies: number[] = [];
    for (let i = 0; i < trials; i++) {
      const t0 = Date.now();
      const { status, text } = await doFetch(spec.url, endpointOverride, token);
      latencies.push(Date.now() - t0);
      const body = unwrap(status, text);
      const { ok } = verify(body, spec.verify_keys, spec.need_at_least);
      if (ok) passes += 1;
      // Pace per provider rate-limit quirk (heavy/credit-metered calls).
      await sleep(PACE_MS);
    }

    const sr = trials ? passes / trials : 0;
    const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    results[domain] = { status: "operational", success_rate: sr, avg_latency_ms: avgMs, pass: passes, trials };
    console.log(
      `  ${domain.padEnd(18)} ${sr > 0 ? "PASS" : "FAIL"}  SR=${sr.toFixed(2)}  ${passes}/${trials}  avg=${avgMs}ms`,
    );
  }
  return results;
}

function buildSummary(results: Record<string, DomainResult>) {
  const all = Object.values(results);
  const operational = all.filter((r) => r.status === "operational");
  const genuineFail = all.filter((r) => r.status === "genuine_fail");
  const total = all.length;
  const reachabilityPct = total ? Math.round((100 * operational.length) / total) : 0;
  const avgSr = operational.length
    ? Math.round((operational.reduce((a, r) => a + r.success_rate, 0) / operational.length) * 10000) / 10000
    : 0;
  const opLat = operational.map((r) => r.avg_latency_ms).filter((v): v is number => v !== null);
  const avgLatencyMs = opLat.length ? Math.round(opLat.reduce((a, b) => a + b, 0) / opLat.length) : null;
  return {
    domains_total: total,
    operational: operational.length,
    genuine_fail: genuineFail.length,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSr,
    // Cost is not measured live — copy frozen aggregate and tag the source.
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD,
    cost_source: "frozen",
    avg_latency_ms: avgLatencyMs,
  };
}

function buildDomainsOutput(results: Record<string, DomainResult>) {
  const out: Record<string, unknown> = {};
  for (const [domain, spec] of Object.entries(DOMAINS)) {
    const r = results[domain];
    const row: Record<string, unknown> = {
      status: r.status,
      success_rate: r.success_rate,
      avg_latency_ms: r.avg_latency_ms,
      // Cost copied from frozen slice; not measured live.
      cost_per_1k_usd: spec.cost_per_1k_usd,
      cost_source: "frozen",
    };
    if (r.status === "operational") {
      row.pass = r.pass;
      row.trials = r.trials;
    } else {
      row.reason_code = r.reason_code;
    }
    out[domain] = row;
  }
  return out;
}

function parseTrials(argv: string[]): number {
  const idx = argv.indexOf("--trials");
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = parseInt(argv[idx + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3;
}

async function main() {
  const trials = parseTrials(process.argv);

  // Auth check BEFORE any request. Never crash on missing env.
  const token = process.env[AUTH_ENV];
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  console.log(`== ${PROVIDER} live test ==  trials=${trials}`);
  const results = await run(trials, token);

  const summary = buildSummary(results);
  const report = {
    provider: PROVIDER,
    report_date: new Date().toISOString().slice(0, 10),
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: buildDomainsOutput(results),
  };

  // Write ../../test-results/<provider>.run.json relative to THIS script's dir.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(scriptDir, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  // Clean per-domain table to stdout.
  console.log();
  console.log(`${"domain".padEnd(18)} ${"status".padEnd(13)} ${"SR".padStart(5)} ${"avg ms".padStart(8)}`);
  console.log("-".repeat(48));
  for (const domain of Object.keys(DOMAINS)) {
    const r = results[domain];
    const sr = r.success_rate.toFixed(2);
    const avg = r.avg_latency_ms === null ? "-" : String(r.avg_latency_ms);
    console.log(`${domain.padEnd(18)} ${r.status.padEnd(13)} ${sr.padStart(5)} ${avg.padStart(8)}`);
  }
  console.log("-".repeat(48));
  const s = summary;
  console.log(
    `reachability=${s.reachability_pct}%  avg_SR=${s.avg_success_rate}  ` +
      `avg_latency=${s.avg_latency_ms}ms  avg_cost/1k=$${s.avg_cost_per_1k_usd} (frozen)`,
  );
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
