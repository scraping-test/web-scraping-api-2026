/**
 * test-scrape-do.ts — Self-contained live test for the "scrape-do" web-scraping API.
 *
 * WHAT IT TESTS
 *   Fetches 20 frozen benchmark target URLs (amazon, bestbuy, google, zillow, ...)
 *   through Scrape.do and verifies the returned HTML/JSON contains the expected
 *   per-domain marker substrings. Produces a per-domain PASS/FAIL table and a
 *   results JSON you can diff against the frozen 2026 numbers.
 *
 * HOW TO RUN
 *   1. Get a Scrape.do API token (https://scrape.do) and export it:
 *          export SCRAPE_DO_TOKEN=your_token_here   # Windows: set SCRAPE_DO_TOKEN=...
 *   2. Run with Node 18+ (global fetch), zero npm deps, via tsx:
 *          npx tsx test-scrape-do.ts                 # 3 trials per domain (default)
 *          npx tsx test-scrape-do.ts --trials 5      # custom trial count
 *
 * WHAT IT WRITES
 *   ../../test-results/scrape-do.run.json  (relative to this file's location:
 *   test-scripts/scrape-do/ -> ../../test-results/). Same schema as the frozen file:
 *   {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}.
 *
 * REQUEST RECIPE (scrape-do)
 *   GET https://api.scrape.do?token=<KEY>&url=<targetUrl>[&<tier params>]
 *   - Auth is a querystring param "token" (NOT a header).
 *   - When a domain has an endpoint_override (google/youtube plugins), that override
 *     is the base URL; token+url are still passed as query params.
 *   - Per-domain tier params (super, render, geoCode, customWait) are merged in.
 *   - Response body IS the target's content directly (HTML, or structured JSON for
 *     plugin endpoints) — no envelope to unwrap.
 *
 * PROVIDER QUIRKS (from slice)
 *   - Credit-based pricing; tiers: basic(1cr), render(5cr), super(10cr), super+render(25cr).
 *   - render=true can 502 on amazon -> use super=true instead (we follow the frozen tier).
 *   - super=true auto-rotates residential + handles anti-bot for tough tier-2 domains.
 *   - Cost is reported via "scrape.do-request-cost" response header (not measured here;
 *     cost numbers are copied from the frozen slice).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "scrape-do";
const ENDPOINT = "https://api.scrape.do";
const AUTH_ENV = "SCRAPE_DO_TOKEN";

// Frozen per-1k cost numbers (copied from the slice; cost is NOT measured live).
const AVG_COST_PER_1K_USD = 0.23;

interface Tier {
  params: Record<string, string>;
  endpoint_override: string | null;
}
interface DomainSpec {
  status: string;
  url: string;
  tier: Tier;
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number;
  reason_code: string | null;
}

// ---------------------------------------------------------------------------
// DOMAINS table — literal values embedded from the slice (NOT read at runtime).
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainSpec> = {
  "amazon.com": {
    status: "operational",
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "bestbuy.com": {
    status: "operational",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    // tier=super (10cr); T1 basic fails (anti-bot).
    tier: { params: { super: "true" }, endpoint_override: null },
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 1.1,
    reason_code: null,
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "booking.com": {
    status: "operational",
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "capterra.com": {
    status: "operational",
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "g2.com": {
    status: "operational",
    url: "https://www.g2.com/products/slack/reviews",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "github.com": {
    status: "operational",
    url: "https://github.com/microsoft/vscode",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "google.com": {
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    // tier=basic (1cr); /plugin/google/search returns structured JSON at same cost.
    tier: {
      params: {},
      endpoint_override: "https://api.scrape.do/plugin/google/search",
    },
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "idealista.com": {
    status: "operational",
    url: "https://www.idealista.com/inmueble/110715434/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "indeed.com": {
    status: "operational",
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "instagram.com": {
    status: "operational",
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
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "linkedin.com": {
    status: "operational",
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
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "reddit.com": {
    status: "operational",
    // old.reddit.com URL (server-rendered, easier to parse).
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
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "tripadvisor.com": {
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "trustpilot.com": {
    status: "operational",
    url: "https://www.trustpilot.com/review/amazon.com",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    // tier=render+customWait=5000 (5cr) — JS-heavy SPA needs a render wait.
    tier: { params: { render: "true", customWait: "5000" }, endpoint_override: null },
    verify_keys: [
      "elonmusk",
      "Elon Musk",
      "44196397",
      "react-root",
      'data-testid="tweet"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.55,
    reason_code: null,
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    // tier=basic (1cr); /plugin/google/youtube structured JSON.
    tier: {
      params: {},
      endpoint_override: "https://api.scrape.do/plugin/google/youtube",
    },
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.11,
    reason_code: null,
  },
  "zillow.com": {
    status: "operational",
    url: "https://www.zillow.com/columbus-oh/",
    // tier=super+geo (10cr).
    tier: { params: { super: "true", geoCode: "us" }, endpoint_override: null },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 1.1,
    reason_code: null,
  },
};

const DEFAULT_TRIALS = 3;
// Pace between requests (ms). Scrape.do has plan-tier concurrency limits;
// a small inter-request delay avoids tripping rate limits on the Hobby plan.
const PACE_MS = 1000;
// HTTP timeout per request (ms). render+super tiers can be slow (x.com ~10s).
const REQUEST_TIMEOUT_MS = 90000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the scrape-do GET request URL following the recipe EXACTLY.
 * Base is ENDPOINT unless tier.endpoint_override (plugin) is set; token+url
 * are passed in both cases. Auth = querystring "token" (NOT a header).
 */
function buildRequest(
  targetUrl: string,
  tier: Tier,
  token: string,
  _cacheBustCounter?: number,
): string {
  const base = tier.endpoint_override || ENDPOINT;
  const params = new URLSearchParams();
  params.set("token", token);
  params.set("url", targetUrl);
  for (const [k, v] of Object.entries(tier.params || {})) {
    params.set(k, v);
  }
  // Scrape.do does not require cache-busting per the recipe; the counter is
  // accepted for signature parity with cache-busting providers but unused here.
  return base + "?" + params.toString();
}

/** Perform the request. Returns [ok, body, latencyMs]. Never throws. */
async function fetchTarget(
  targetUrl: string,
  tier: Tier,
  token: string,
  cacheBustCounter?: number,
): Promise<[boolean, string, number]> {
  const fullUrl = buildRequest(targetUrl, tier, token, cacheBustCounter);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(fullUrl, {
      headers: { Accept: "*/*" },
      signal: controller.signal,
    });
    // scrape-do returns the target content directly (HTML or plugin JSON);
    // there is no JSON envelope to unwrap. Read body even on non-2xx so verify()
    // can still inspect any passthrough HTML.
    const body = await resp.text();
    const latencyMs = Date.now() - start;
    return [resp.ok, body, latencyMs];
  } catch (e) {
    const latencyMs = Date.now() - start;
    return [false, "scrape-do request error: " + String(e), latencyMs];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Count how many verify_keys appear as substrings in body.
 * PASS when hits >= need_at_least. IDENTICAL rule to the Python version.
 */
function verify(
  body: string,
  verifyKeys: string[],
  needAtLeast: number,
): [boolean, number] {
  if (!body) return [false, 0];
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return [hits >= needAtLeast, hits];
}

function parseTrials(argv: string[]): number {
  const idx = argv.indexOf("--trials");
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = parseInt(argv[idx + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return DEFAULT_TRIALS;
}

interface RunResult {
  status: string;
  success_rate: number;
  avg_latency_ms: number;
  pass_count?: number;
  trials?: number;
  reason_code?: string | null;
}

async function run(): Promise<void> {
  const trials = parseTrials(process.argv.slice(2));

  // --- Auth gate (BEFORE any request). Never crash if the token is missing. ---
  const token = process.env[AUTH_ENV];
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`scrape-do live test — ${trials} trial(s) per operational domain\n`);

  const results: Record<string, RunResult> = {};
  let cacheBustCounter = 0;

  for (const domain of Object.keys(DOMAINS).sort()) {
    const spec = DOMAINS[domain];

    // genuine_fail rows: DO NOT make requests — print one SKIP line.
    if (spec.status !== "operational") {
      const reason = spec.reason_code || "genuine_fail";
      console.log(
        `SKIP ${domain}: ${reason} — not operational in frozen run; no request made`,
      );
      results[domain] = {
        status: spec.status,
        success_rate: 0,
        avg_latency_ms: 0,
        reason_code: reason,
      };
      continue;
    }

    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      cacheBustCounter += 1;
      const [, body, latencyMs] = await fetchTarget(
        spec.url,
        spec.tier,
        token,
        cacheBustCounter,
      );
      latencies.push(latencyMs);
      const [passed] = verify(body, spec.verify_keys, spec.need_at_least);
      if (passed) passes += 1;
      // Pace per the provider's concurrency limit quirk.
      await sleep(PACE_MS);
    }

    const successRate = Math.round((passes / trials) * 10000) / 10000;
    const avgLatency =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
    results[domain] = {
      status: "operational",
      success_rate: successRate,
      avg_latency_ms: avgLatency,
      pass_count: passes,
      trials,
    };

    const verdict = passes >= 1 ? "PASS" : "FAIL";
    console.log(
      `  ${domain.padEnd(16)} ${verdict.padEnd(4)} ${passes}/${trials}  ${avgLatency}ms`,
    );
  }

  // --- Summary (same computation rules as the frozen file) ---
  const operational = Object.keys(results).filter(
    (d) => DOMAINS[d].status === "operational",
  );
  const opResults = operational.map((d) => results[d]);
  const total = Object.keys(DOMAINS).length;
  const reachabilityPct =
    total > 0 ? Math.round((10000 * operational.length) / total) / 100 : 0;
  const avgSuccessRate =
    opResults.length > 0
      ? Math.round(
          (opResults.reduce((a, r) => a + r.success_rate, 0) / opResults.length) *
            10000,
        ) / 10000
      : 0;
  const avgLatencyMs =
    opResults.length > 0
      ? Math.round(
          opResults.reduce((a, r) => a + r.avg_latency_ms, 0) / opResults.length,
        )
      : 0;

  const summary = {
    domains_total: total,
    operational: operational.length,
    genuine_fail: total - operational.length,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    // Cost is NOT measured live — copied from the frozen slice.
    avg_cost_per_1k_usd: AVG_COST_PER_1K_USD,
    cost_source: "frozen",
    avg_latency_ms: avgLatencyMs,
  };

  // --- Build output domains in frozen schema ---
  const outDomains: Record<string, unknown> = {};
  for (const [domain, spec] of Object.entries(DOMAINS)) {
    const r = results[domain];
    const entry: Record<string, unknown> = {
      status: r.status,
      success_rate: r.success_rate,
      avg_latency_ms: r.avg_latency_ms,
      cost_per_1k_usd: spec.cost_per_1k_usd,
      cost_source: "frozen",
    };
    if (spec.status === "operational") {
      entry.pass_count = r.pass_count ?? 0;
      entry.trials = r.trials ?? trials;
    } else {
      entry.reason_code = r.reason_code;
    }
    outDomains[domain] = entry;
  }

  const output = {
    provider: PROVIDER,
    report_date: today,
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: outDomains,
  };

  // --- Write results relative to THIS file's location ---
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "..", "..", "test-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(
    `\nsummary: reachability=${reachabilityPct.toFixed(2)}%  avg_success_rate=${avgSuccessRate.toFixed(4)}  avg_latency=${avgLatencyMs}ms`,
  );
  console.log(`wrote ${outPath}`);
}

run();
