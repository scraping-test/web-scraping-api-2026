/**
 * test-firecrawl.ts — self-contained PASS/FAIL test harness for the Firecrawl scraping provider.
 *
 * WHAT IT TESTS
 *   Runs the frozen 2026 benchmark domain set against Firecrawl's /v1/scrape endpoint and
 *   reports per-domain PASS/FAIL plus an aggregate success rate, so you can diff a live run
 *   against the frozen reference numbers embedded below.
 *
 *   For each OPERATIONAL domain it issues N POST requests (default 3) and counts a trial as a
 *   PASS when:
 *     1. STRICT source check:  data.metadata.sourceURL contains the target domain
 *        (Firecrawl quirk: /search-style URLs can return snippet content from OTHER sites; the
 *         sourceURL gate avoids those false positives), AND
 *     2. verify(): at least `need_at_least` of the domain's verify_keys appear as substrings in
 *        the returned content (data.markdown + data.html).
 *
 *   GENUINE_FAIL domains are NOT requested — they are known dead ends (ToS deny-list 403 or
 *   reCAPTCHA 429). The script prints a single SKIP line per such domain.
 *
 * HOW TO RUN
 *   export FIRECRAWL_TOKEN=fc-xxxxxxxx          # the only required setup (see .env.example)
 *   npx tsx test-firecrawl.ts                   # 3 trials per operational domain
 *   npx tsx test-firecrawl.ts --trials 5        # custom trial count
 *
 *   If FIRECRAWL_TOKEN is unset the script prints a hint and exits 0 (never crashes).
 *
 * WHAT IT WRITES
 *   ../../test-results/firecrawl.run.json  (relative to this script's directory)
 *   Same schema as the frozen reference file:
 *     {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}
 *   Cost figures are copied from the frozen slice (not measured live) and tagged
 *   "cost_source":"frozen"; success_rate and avg_latency_ms are MEASURED this run.
 *
 * QUIRKS BAKED IN (from the request recipe)
 *   - Transport POST, JSON body to the endpoint_override (v1/scrape).
 *   - Auth via "Authorization: Bearer <token>" header.
 *   - Body: {url: target, formats:["markdown"]} plus tier params (waitFor, proxy, mobile...).
 *   - Response unwrap: data.markdown / data.html for content, data.metadata.sourceURL for gate.
 *   - Pace 650ms between calls (Firecrawl plan rate-limit is 100 req/min).
 *   - Cache-bust: append a _t counter param to the target URL each trial.
 *
 * Node 18+ built-ins + global fetch only. Zero npm deps.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "firecrawl";
const ENDPOINT = "https://api.firecrawl.dev/v1";
const AUTH_ENV = "FIRECRAWL_TOKEN";

// Pace between calls in ms. Recipe: "Pace 650ms between calls" — Firecrawl plans cap at
// 100 req/min, so anything faster risks RL misses that look like target blocks.
const PACE_MS = 650;
const REQUEST_TIMEOUT_MS = 90_000; // stealth + waitFor domains (bestbuy ~14s avg) need a generous ceiling.

// Frozen aggregate cost (copied, not measured). Used verbatim in the run summary.
const FROZEN_AVG_COST_PER_1K_USD = 16.7;

type Tier = {
  params: Record<string, unknown>;
  endpoint_override: string | null;
};

type DomainInfo = {
  status: "operational" | "genuine_fail";
  url: string;
  tier: Tier;
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number | null;
  reason_code?: string;
  note?: string;
};

// ---------------------------------------------------------------------------
// DOMAINS — literal values from the frozen slice. Do NOT read the slice at runtime.
// Each operational entry: url, tier{params, endpoint_override}, verify_keys, need_at_least,
// status, cost_per_1k_usd (frozen). genuine_fail entries also carry a reason_code + note.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainInfo> = {
  "amazon.com": {
    status: "operational",
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
  "bestbuy.com": {
    status: "operational",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    tier: {
      params: { formats: ["markdown"], waitFor: 5000, proxy: "stealth" },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
  "booking.com": {
    status: "operational",
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
  "capterra.com": {
    status: "operational",
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth", waitFor: 4000 },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "g2.com": {
    status: "operational",
    url: "https://www.g2.com/products/slack/reviews",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth" },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "github.com": {
    status: "operational",
    url: "https://github.com/microsoft/vscode",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
  "google.com": {
    status: "genuine_fail",
    url: "https://www.google.com/search?q=python+tutorial",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "recaptcha_429",
    note: "reCAPTCHA 429 every tier; FC IP pool is on Google's high-volume rate-limit list.",
  },
  "idealista.com": {
    status: "operational",
    url: "https://www.idealista.com/inmueble/110715434/",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth" },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "indeed.com": {
    status: "operational",
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth" },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "instagram.com": {
    status: "genuine_fail",
    url: "https://www.instagram.com/nike/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "tos_denylist",
    note: '"we do not support this site" 403 block-list.',
  },
  "linkedin.com": {
    status: "genuine_fail",
    url: "https://www.linkedin.com/company/microsoft/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Microsoft | LinkedIn</title>",
      '"@type":"Organization"',
      "urn:li:organization",
      "/company/microsoft",
      "_org_guest_company_overview",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "tos_denylist",
    note: "same block-list 403 as instagram/reddit.",
  },
  "reddit.com": {
    status: "genuine_fail",
    url: "https://old.reddit.com/r/programming/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      'id="siteTable"',
      'data-fullname="t3_',
      'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"',
      "<title>programming</title>",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "tos_denylist",
    note: "same block-list 403; old.reddit.com, np.reddit.com all blocked.",
  },
  "tripadvisor.com": {
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth" },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "trustpilot.com": {
    status: "operational",
    url: "https://www.trustpilot.com/review/amazon.com",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth", waitFor: 4000 },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    tier: {
      params: { formats: ["markdown"], proxy: "stealth" },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 26.65,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    tier: {
      params: { formats: ["markdown"] },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
  "zillow.com": {
    status: "operational",
    url: "https://www.zillow.com/columbus-oh/",
    tier: {
      params: { formats: ["markdown"], mobile: true },
      endpoint_override: "https://api.firecrawl.dev/v1/scrape",
    },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5.33,
  },
};

// ---------------------------------------------------------------------------
// verify() — IDENTICAL rule to the Python file: count verify_key substring hits in the
// content, PASS when hits >= need_at_least.
// ---------------------------------------------------------------------------
function verify(body: string, verifyKeys: string[], needAtLeast: number): boolean {
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return hits >= needAtLeast;
}

// STRICT source gate (Firecrawl quirk): the returned metadata.sourceURL must contain the
// target domain, otherwise a /search-style page could pass on snippet text from another site.
function domainInSource(sourceUrl: string, domain: string): boolean {
  if (!sourceUrl) return false;
  return sourceUrl.toLowerCase().includes(domain.toLowerCase());
}

// Append a deterministic _t counter param (recipe: cache-bust with _t). A counter keeps the
// file deterministic — no wall-clock randomness.
function cacheBust(url: string, counter: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_t=${counter}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Firecrawl response unwrapping per recipe: content lives in data.markdown / data.html,
// and the source gate is data.metadata.sourceURL.
function unwrap(payload: any): { content: string; sourceUrl: string } {
  const data = payload?.data ?? {};
  let content = "";
  if (typeof data.markdown === "string") content += data.markdown;
  if (typeof data.html === "string") content += data.html;
  const sourceUrl = data?.metadata?.sourceURL ?? "";
  return { content, sourceUrl };
}

// Firecrawl request builder, exactly per the recipe:
//   POST JSON to the endpoint_override (v1/scrape).
//   Header: Authorization: Bearer <token>.
//   Body:   {url: <cache-busted target>, formats:["markdown"], ...tier params}.
async function runTrial(
  token: string,
  domain: string,
  info: DomainInfo,
  counter: number,
): Promise<{ passed: boolean; latencyMs: number }> {
  const endpoint = info.tier.endpoint_override ?? `${ENDPOINT}/scrape`;
  const busted = cacheBust(info.url, counter);

  // Tier params already include {formats:["markdown"]}; url goes on top.
  const body = { ...info.tier.params, url: busted };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await resp.text();
    const latencyMs = Date.now() - started;

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { passed: false, latencyMs };
    }

    const { content, sourceUrl } = unwrap(payload);

    // STRICT verify: source gate AND verify_keys.
    if (!domainInSource(sourceUrl, domain)) return { passed: false, latencyMs };
    const passed = verify(content, info.verify_keys, info.need_at_least);
    return { passed, latencyMs };
  } catch {
    // Network error, abort/timeout, or HTTP-level failure (e.g. 403 deny-list, 429 RL).
    return { passed: false, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function parseTrials(argv: string[]): number {
  const i = argv.indexOf("--trials");
  if (i !== -1 && i + 1 < argv.length) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3;
}

function round(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

async function main(): Promise<number> {
  const trials = parseTrials(process.argv);

  // Auth check FIRST — before any request. Exit 0 (never crash) when unset.
  const token = process.env[AUTH_ENV];
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    return 0;
  }

  console.log(`Firecrawl test — ${trials} trials per operational domain, ${PACE_MS}ms pacing\n`);

  // Global cache-bust counter — deterministic, increments across every request issued.
  let counter = 0;
  const results: Record<string, any> = {};

  for (const [domain, info] of Object.entries(DOMAINS)) {
    if (info.status === "genuine_fail") {
      // Recipe: do NOT make requests for genuine_fail rows.
      console.log(`SKIP ${domain}: ${info.reason_code ?? "genuine_fail"} — ${info.note ?? ""}`);
      results[domain] = {
        status: "genuine_fail",
        success_rate: 0.0,
        avg_latency_ms: null,
        reason_code: info.reason_code ?? null,
        cost_per_1k_usd: info.cost_per_1k_usd,
        cost_source: "frozen",
      };
      continue;
    }

    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      counter += 1;
      const { passed, latencyMs } = await runTrial(token, domain, info, counter);
      if (passed) passes += 1;
      latencies.push(latencyMs);
      // Pace between calls (Firecrawl 100 req/min plan limit).
      await sleep(PACE_MS);
    }

    const successRate = passes / trials;
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    results[domain] = {
      status: "operational",
      pass: passes,
      trials,
      success_rate: round(successRate, 3),
      avg_latency_ms: avgLatency,
      cost_per_1k_usd: info.cost_per_1k_usd,
      cost_source: "frozen",
    };
  }

  // --- Summary, computed the same way as the frozen file ---------------------
  const allInfos = Object.values(DOMAINS);
  const domainsTotal = allInfos.length;
  const opKeys = Object.keys(DOMAINS).filter((d) => DOMAINS[d].status === "operational");
  const failCount = allInfos.filter((d) => d.status === "genuine_fail").length;
  const opCount = opKeys.length;

  const reachabilityPct = domainsTotal ? Math.round((opCount / domainsTotal) * 100) : 0;
  const opResults = opKeys.map((d) => results[d]);
  const avgSuccessRate = opResults.length
    ? round(opResults.reduce((a, r) => a + r.success_rate, 0) / opResults.length, 3)
    : 0.0;
  const opLatencies = opResults
    .map((r) => r.avg_latency_ms)
    .filter((v): v is number => v !== null);
  const avgLatencyMs = opLatencies.length
    ? Math.round(opLatencies.reduce((a, b) => a + b, 0) / opLatencies.length)
    : null;

  const summary = {
    domains_total: domainsTotal,
    operational: opCount,
    genuine_fail: failCount,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // copied from frozen; not measured live
    avg_latency_ms: avgLatencyMs,
    cost_source: "frozen",
  };

  const out = {
    provider: PROVIDER,
    report_date: new Date().toISOString().slice(0, 10), // today
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: results,
  };

  // Write to ../../test-results/<provider>.run.json relative to THIS script's location.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(scriptDir, "..", "..", "test-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  // --- Clean per-domain table to stdout --------------------------------------
  const pad = (s: string, w: number) => s.padEnd(w);
  const padL = (s: string, w: number) => s.padStart(w);
  console.log(`\n${pad("DOMAIN", 18)} ${pad("STATUS", 13)} ${padL("SR", 6)} ${padL("AVG_MS", 10)}`);
  console.log("-".repeat(50));
  for (const [domain, info] of Object.entries(DOMAINS)) {
    const r = results[domain];
    if (info.status === "genuine_fail") {
      console.log(`${pad(domain, 18)} ${pad("genuine_fail", 13)} ${padL("-", 6)} ${padL("-", 10)}`);
    } else {
      const sr = `${Math.round(r.success_rate * 100)}%`;
      const ms = r.avg_latency_ms !== null ? String(r.avg_latency_ms) : "-";
      const label = `operational (${r.pass}/${r.trials})`;
      console.log(`${pad(domain, 18)} ${pad(label, 13)} ${padL(sr, 6)} ${padL(ms, 10)}`);
    }
  }

  console.log(
    `\nReachability: ${reachabilityPct}%  |  avg SR: ${Math.round(avgSuccessRate * 1000) / 10}%  |  avg ms: ${
      avgLatencyMs !== null ? avgLatencyMs : "-"
    }`,
  );
  console.log(`Wrote ${outPath}`);
  return 0;
}

main().then((code) => process.exit(code));
