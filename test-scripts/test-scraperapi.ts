/**
 * Self-contained ScraperAPI provider test (frozen 2026 baseline).
 *
 * WHAT THIS TESTS
 *   Runs ScraperAPI against a fixed set of 20 target domains and checks, per
 *   domain, whether the returned HTML contains enough of the expected "verify
 *   keys" to count as a successful scrape. It reproduces the exact request shape
 *   (tier params, endpoint, auth) that produced the frozen 2026 numbers so you
 *   can diff a fresh run against the baseline.
 *
 * HOW TO RUN
 *   export SCRAPERAPI_TOKEN=<your_key>     # required; without it prints a hint
 *                                          # and exits 0 (never crashes)
 *   npx tsx test-scraperapi.ts             # default 3 trials per domain
 *   npx tsx test-scraperapi.ts --trials 5  # override trial count
 *
 *   Node 18+ built-ins + global fetch ONLY. Zero npm deps. No shared imports.
 *
 * WHAT IT WRITES
 *   ../../test-results/scraperapi.run.json  (relative to this file's own dir,
 *   i.e. test-scripts/scraperapi/ -> ../../test-results/). Same schema as the
 *   frozen file: {provider, report_date, frozen:false, endpoint, auth_env,
 *   summary, domains}. avg_cost_per_1k_usd is copied from the frozen slice
 *   ("cost_source":"frozen") because cost is not measured live; success_rate
 *   and avg_latency_ms ARE measured this run.
 *
 * PROVIDER QUIRKS BAKED IN (from the slice request_recipe + quirks)
 *   - Transport GET, auth via querystring api_key=<KEY>, url=<targetUrl>.
 *   - Endpoint https://api.scraperapi.com (base "/?api_key=&url=").
 *   - Returns RAW HTML (no JSON envelope to unwrap).
 *   - Real credit cost is in the sa-credit-cost response header and often
 *     differs from doc cost (Amazon 5cr, Google 25cr, LinkedIn 30cr, ...). We
 *     do NOT bill on it; cost is taken from the frozen slice.
 *   - T5 ultra_premium is expensive and slow; trials are capped (MAX_TRIALS).
 *   - instagram + x.com are gateway-403 ToS-denylisted: genuine_fail, never
 *     requested (covers twitter.com mirrors too).
 *   - idealista: country_code=es FAILS on Hobby plan, so it is intentionally
 *     omitted from that domain's params.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const PROVIDER = "scraperapi";
const ENDPOINT = "https://api.scraperapi.com";
const AUTH_ENV = "SCRAPERAPI_TOKEN";
const REPORT_DATE = "2026-06-08"; // today (frozen-compatible)

// T5 ultra_premium is expensive + slow per the recipe note; cap trials.
const MAX_TRIALS = 8;

// avg_cost_per_1k_usd from the frozen slice summary; cost is NOT measured live.
const FROZEN_AVG_COST_PER_1K_USD = 12.04;

// Per the recipe note T5 ultra_premium is heavy; pace requests a touch between
// trials to be polite to the gateway and avoid bursty 500s.
const PACING_MS = 1000;

type Tier = { params: Record<string, string>; endpoint_override: string | null };
interface DomainCfg {
  url: string;
  tier: Tier;
  verify_keys: string[];
  need_at_least: number;
  status: "operational" | "genuine_fail";
  cost_per_1k_usd: number | null;
  reason_code?: string;
}

// --- DOMAINS table: literal values embedded from the slice (NOT read at runtime) ---
const DOMAINS: Record<string, DomainCfg> = {
  "amazon.com": {
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["productTitle", 'id="dp-container"', 'id="centerCol"',
      'data-asin="B07FZ8S74R"', "nav-logo-base"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 2.45,
  },
  "bestbuy.com": {
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    tier: { params: { ultra_premium: "true", render: "true" }, endpoint_override: null },
    verify_keys: ["application/ld+json", '"@type":"Product"', '"sku":"6570601"',
      '"customerPrice"', "add-to-cart-button"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 36.75,
  },
  "bing.com": {
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: { params: { ultra_premium: "true" }, endpoint_override: null },
    verify_keys: ["<title>best laptops 2025 - Search</title>", 'id="b_content"',
      'id="sb_form"', 'class="b_algo', 'class="b_attribution'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 26.95,
  },
  "booking.com": {
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    tier: { params: { render: "true" }, endpoint_override: null },
    verify_keys: ["hp_hotel_name", "data-capla-component-boundary", '"@type" : "Hotel"',
      '"hotelId":', '"reviewCount"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 2.45,
  },
  "capterra.com": {
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["<title>Slack Software Pricing", '"@type":"SoftwareApplication"',
      '"name":"Slack"', 'data-testid="hero-section"', "/p/135003/Slack"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 4.9,
  },
  "ebay.com": {
    url: "https://www.ebay.com/itm/116619563010",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["itm.ebaydesc.com", "ebayLogoTitle", '"product":',
      "p.ebaystatic.com", '"@type":"Product"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 0.49,
  },
  "g2.com": {
    url: "https://www.g2.com/products/slack/reviews",
    // T5: ultra_premium+render+wait_for_selector=.product-head per the quirk note.
    tier: {
      params: { ultra_premium: "true", render: "true", wait_for_selector: ".product-head" },
      endpoint_override: null,
    },
    verify_keys: ["<title>Slack Reviews 2026", 'itemprop="ratingValue"',
      'itemprop="reviewBody"', "products/slack/reviews", "Filter 39001 reviews"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 36.75,
  },
  "github.com": {
    url: "https://github.com/microsoft/vscode",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["<title>GitHub - microsoft/vscode", 'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"', 'id="repository-container-header"',
      "github.com/microsoft/vscode"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 0.49,
  },
  "google.com": {
    url: "https://www.google.com/search?q=python+tutorial",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ['id="search"', 'id="rso"', 'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 12.25,
  },
  "idealista.com": {
    url: "https://www.idealista.com/inmueble/110715434/",
    // NOTE: country_code=es FAILS on Hobby plan, so it is deliberately omitted.
    tier: { params: {}, endpoint_override: null },
    verify_keys: ['class="main-info__title-main"', 'class="info-data-price"',
      "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: null,
  },
  "indeed.com": {
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="', 'class="job_seen_beacon', 'data-testid="company-name"',
      'id="mosaic-provider-jobcards"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 4.9,
  },
  "instagram.com": {
    url: "https://www.instagram.com/nike/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ['"username":"nike"', "<title>Nike (&#064;nike)",
      "instagram://user?username=nike", 'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"'],
    need_at_least: 2,
    status: "genuine_fail",
    reason_code: "tos_denylist",
    cost_per_1k_usd: null,
  },
  "linkedin.com": {
    url: "https://www.linkedin.com/company/microsoft/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["<title>Microsoft | LinkedIn</title>", '"@type":"Organization"',
      "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 14.7,
  },
  "reddit.com": {
    url: "https://old.reddit.com/r/programming/",
    tier: { params: { premium: "true", render: "true" }, endpoint_override: null },
    verify_keys: ['id="siteTable"', 'data-fullname="t3_', 'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"', "<title>programming</title>"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 19.6,
  },
  "tripadvisor.com": {
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: { params: { premium: "true", render: "true" }, endpoint_override: null },
    verify_keys: ["Fairmont", "THE PLAZA NEW YORK", '"@type":"LodgingBusiness"',
      '"aggregateRating"', "data-automation"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 12.25,
  },
  "trustpilot.com": {
    url: "https://www.trustpilot.com/review/amazon.com",
    tier: { params: { premium: "true", render: "true" }, endpoint_override: null },
    verify_keys: ["data-service-review-card-paper", "data-service-review-rating",
      '"@type":"Organization"', '"@type":"AggregateRating"', "data-business-unit-json-ld"],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 12.25,
  },
  "walmart.com": {
    url: "https://www.walmart.com/ip/604342441",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["<title>Apple, AirPods with Charging Case", '"itemId":"604342441"',
      'data-testid="price-wrap"', 'id="__NEXT_DATA__"', 'data-testid="hero-image-container"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: null,
  },
  "x.com": {
    url: "https://x.com/elonmusk",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    status: "genuine_fail",
    reason_code: "tos_denylist",
    cost_per_1k_usd: null,
  },
  "youtube.com": {
    url: "https://www.youtube.com/@MrBeast",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ['"channelMetadataRenderer"', '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData", '"title":"MrBeast"', '"subscriberCountText"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 4.9,
  },
  "zillow.com": {
    url: "https://www.zillow.com/columbus-oh/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ['data-testid="property-card"', '"zpid":',
      '"@type":"SingleFamilyResidence"', '"streetAddress"', '"bedrooms"'],
    need_at_least: 2,
    status: "operational",
    cost_per_1k_usd: 0.49,
  },
};

// Short human-readable notes for SKIP lines on genuine_fail domains.
const REASON_NOTES: Record<string, string> = {
  tos_denylist: "gateway 403 ToS denylist (instagram + x.com / twitter mirrors)",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build the request URL following the recipe EXACTLY.
 * Transport GET. Auth = querystring api_key. Query: api_key=<KEY>,
 * url=<targetUrl>, plus tier params. Base https://api.scraperapi.com.
 * Returns RAW HTML — no envelope.
 */
function buildUrl(targetUrl: string, params: Record<string, string>): string {
  const token = process.env[AUTH_ENV] as string;
  const q = new URLSearchParams();
  q.set("api_key", token);
  q.set("url", targetUrl);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  return `${ENDPOINT}/?${q.toString()}`;
}

/**
 * Response unwrapping for ScraperAPI: the body is RAW HTML, no JSON envelope.
 * fetch().text() already gives us the decoded string.
 */
function unwrap(text: string): string {
  return text;
}

/**
 * Count substring hits in body; PASS when hits >= need_at_least.
 * IDENTICAL rule to the Python port.
 */
function verify(body: string, verifyKeys: string[], needAtLeast: number): [boolean, number] {
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return [hits >= needAtLeast, hits];
}

/** Single request. Returns [okHttp, bodyOrEmpty, latencyMs]. */
async function runTrial(
  targetUrl: string,
  params: Record<string, string>,
): Promise<[boolean, string, number]> {
  const url = buildUrl(targetUrl, params);
  const start = Date.now();
  try {
    // 120s ceiling matches the Python urlopen timeout; heavy render tiers are slow.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    let resp: Response;
    try {
      resp = await fetch(url, { method: "GET", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = unwrap(await resp.text());
    const latencyMs = Date.now() - start;
    // Like the Python port we keep the body even on non-2xx (some gateways
    // return useful HTML on 4xx/5xx); the HTTP-ok flag tracks resp.ok.
    return [resp.ok, body, latencyMs];
  } catch {
    const latencyMs = Date.now() - start;
    return [false, "", latencyMs];
  }
}

function parseTrials(argv: string[]): number {
  const i = argv.indexOf("--trials");
  if (i !== -1 && i + 1 < argv.length) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isNaN(n)) return n;
  }
  return 3;
}

async function main(): Promise<void> {
  let trials = Math.max(1, parseTrials(process.argv));
  if (trials > MAX_TRIALS) {
    // T5 ultra_premium is expensive — cap trials per recipe note.
    console.log(`[note] capping --trials ${trials} -> ${MAX_TRIALS} (ultra_premium is costly)`);
    trials = MAX_TRIALS;
  }

  // AUTH check BEFORE any request: never crash if env var is unset.
  if (!process.env[AUTH_ENV]) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  const results: Record<string, any> = {};
  let operationalCount = 0;
  let skippedCount = 0;

  for (const [domain, cfg] of Object.entries(DOMAINS)) {
    if (cfg.status === "genuine_fail") {
      // genuine_fail: DO NOT make requests. One SKIP line.
      const reason = cfg.reason_code ?? "unknown";
      const note = REASON_NOTES[reason] ?? "";
      console.log(`SKIP ${domain}: ${reason} — ${note}`);
      results[domain] = {
        status: "genuine_fail",
        reason_code: reason,
        success_rate: 0,
        avg_latency_ms: null,
        cost_per_1k_usd: cfg.cost_per_1k_usd,
      };
      skippedCount += 1;
      continue;
    }

    operationalCount += 1;
    const params = cfg.tier.params;
    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      const [okHttp, body, latencyMs] = await runTrial(cfg.url, params);
      latencies.push(latencyMs);
      if (okHttp && body) {
        const [passed] = verify(body, cfg.verify_keys, cfg.need_at_least);
        if (passed) passes += 1;
      }
      // Pace between trials (skip the wait after the final trial).
      if (t < trials - 1) await sleep(PACING_MS);
    }

    const successRate = trials ? passes / trials : 0;
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    results[domain] = {
      status: "operational",
      pass: passes,
      trials,
      success_rate: Math.round(successRate * 10000) / 10000,
      avg_latency_ms: avgLatency,
      cost_per_1k_usd: cfg.cost_per_1k_usd,
    };
  }

  // ---- summary (same method as frozen) ----
  const opRows = Object.values(results).filter((r: any) => r.status === "operational");
  const avgSuccessRate = opRows.length
    ? Math.round((opRows.reduce((a: number, r: any) => a + r.success_rate, 0) / opRows.length) * 10000) / 10000
    : 0;
  const opLatencies = opRows
    .map((r: any) => r.avg_latency_ms)
    .filter((v: number | null): v is number => v !== null);
  const avgLatencyMs = opLatencies.length
    ? Math.round(opLatencies.reduce((a, b) => a + b, 0) / opLatencies.length)
    : null;
  const domainsTotal = Object.keys(DOMAINS).length;
  const reachabilityPct = domainsTotal ? Math.round((operationalCount / domainsTotal) * 100) : 0;

  const summary = {
    domains_total: domainsTotal,
    operational: operationalCount,
    genuine_fail: skippedCount,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD,
    cost_source: "frozen",
    avg_latency_ms: avgLatencyMs,
  };

  const out = {
    provider: PROVIDER,
    report_date: REPORT_DATE,
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: results,
  };

  // ---- write results JSON relative to THIS file: -> ../../test-results/ ----
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(scriptDir, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  // ---- clean per-domain table to stdout ----
  console.log();
  console.log(
    `${"domain".padEnd(18)} ${"status".padEnd(13)} ${"SR".padStart(6)} ${"avg ms".padStart(9)}`,
  );
  console.log("-".repeat(48));
  for (const [domain, r] of Object.entries(results) as [string, any][]) {
    const sr = `${Math.round(r.success_rate * 100)}%`;
    const ms = r.avg_latency_ms === null ? "-" : String(r.avg_latency_ms);
    console.log(
      `${domain.padEnd(18)} ${String(r.status).padEnd(13)} ${sr.padStart(6)} ${ms.padStart(9)}`,
    );
  }
  console.log("-".repeat(48));
  console.log(
    `reachability ${summary.reachability_pct}%  ` +
      `avg SR ${(summary.avg_success_rate * 100).toFixed(1)}%  ` +
      `avg latency ${summary.avg_latency_ms}ms`,
  );
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
