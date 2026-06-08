/**
 * test-webscrapingapi.ts — Self-contained live test for the "webscrapingapi" web-scraping API.
 *
 * WHAT IT TESTS
 *   Fetches 20 frozen benchmark target URLs (amazon, bestbuy, google, zillow, ...)
 *   through WebScrapingAPI (api.webscrapingapi.com/v2) and verifies the returned HTML
 *   contains the expected per-domain marker substrings. Produces a per-domain PASS/FAIL
 *   table and a results JSON you can diff against the frozen 2026 numbers.
 *
 * HOW TO RUN
 *   1. Get a WebScrapingAPI access key (https://www.webscrapingapi.com) and export it:
 *          export WSA_TOKEN=your_token_here          # Windows: set WSA_TOKEN=...
 *   2. Run with Node 18+ (global fetch), zero npm deps, via tsx:
 *          npx tsx test-webscrapingapi.ts            # 3 trials per domain (default)
 *          npx tsx test-webscrapingapi.ts --trials 5 # custom trial count
 *
 * WHAT IT WRITES
 *   ../../test-results/webscrapingapi.run.json  (relative to this file's location:
 *   test-scripts/webscrapingapi/ -> ../../test-results/). Same schema as the frozen file:
 *   {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}.
 *
 * REQUEST RECIPE (webscrapingapi)
 *   GET https://api.webscrapingapi.com/v2?api_key=<KEY>&url=<targetUrl>[&<tier params>]
 *   - Transport is GET. Auth is a querystring param "api_key" (NOT a header).
 *   - The base endpoint is always the same (v2); there are NO per-domain endpoint
 *     overrides for this provider.
 *   - Per-domain tier params (render_js, country) are merged into the query.
 *   - Response body IS the target's raw HTML directly — there is no JSON envelope
 *     to unwrap.
 *
 * PROVIDER QUIRKS (from slice)
 *   - Credit pricing: T1=1cr (basic), T2=5cr (render_js), T3=10cr (render_js+country);
 *     1cr = $0.00245, so $2.45 / $12.25 / $24.50 per 1k requests respectively.
 *   - A 4-min per-domain wall-time budget caps some batches early; frozen partial
 *     bulks may show <100 trials — irrelevant to this small live test.
 *   - Occasional 52-byte stub 200 responses (trustpilot, walmart): a 502 served as a
 *     200 with a tiny body. We do NOT special-case HTTP status; verify_keys naturally
 *     catches these (a 52-byte stub contains none of the markers -> FAIL).
 *   - walmart shows only ~24.7% yield even at T3 (low-yield CONFIG); expect FAILs there.
 *   - Cost is reported via credits, not measured live; cost numbers are copied from the
 *     frozen slice (null where the frozen slice left it null).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "webscrapingapi";
const ENDPOINT = "https://api.webscrapingapi.com/v2";
const AUTH_ENV = "WSA_TOKEN";

// Frozen avg per-1k cost (copied from the slice; cost is NOT measured live).
const AVG_COST_PER_1K_USD = 4.9;

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
  cost_per_1k_usd: number | null;
  reason_code: string | null;
}

// ---------------------------------------------------------------------------
// DOMAINS table — literal values embedded from the slice (NOT read at runtime).
// cost_per_1k_usd is null where the frozen slice left it null.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainSpec> = {
  "amazon.com": {
    status: "operational",
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    // T1 basic (1cr).
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "bestbuy.com": {
    status: "operational",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    // T2 render (5cr); 13 x 502 out of 100 in the frozen bulk.
    tier: { params: { render_js: "true" }, endpoint_override: null },
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 12.25,
    reason_code: null,
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    // T1 basic; 51% selector match (intermittent content drift).
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "booking.com": {
    status: "operational",
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    // T2 render.
    tier: { params: { render_js: "true" }, endpoint_override: null },
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: null,
  },
  "capterra.com": {
    status: "operational",
    url: "https://www.capterra.com/p/135003/Slack/",
    // T1 basic; partial bulk (43/100).
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    // T3 render+country; 26 x 502 out of 91; partial bulk.
    tier: { params: { render_js: "true", country: "us" }, endpoint_override: null },
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 24.5,
    reason_code: null,
  },
  "g2.com": {
    status: "operational",
    url: "https://www.g2.com/products/slack/reviews",
    // T1 basic; partial bulk (49/100).
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "github.com": {
    status: "operational",
    url: "https://github.com/microsoft/vscode",
    // T1 basic.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "google.com": {
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    // T1 basic.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "idealista.com": {
    status: "operational",
    url: "https://www.idealista.com/inmueble/110715434/",
    // T1 basic + country=es; partial bulk (89/100).
    tier: { params: { country: "es" }, endpoint_override: null },
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "indeed.com": {
    status: "operational",
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    // T2 render; 59% selector matches (intermittent rendering).
    tier: { params: { render_js: "true" }, endpoint_override: null },
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 12.25,
    reason_code: null,
  },
  "instagram.com": {
    status: "operational",
    url: "https://www.instagram.com/nike/",
    // T3 render+country — recovered with stable selectors.
    tier: { params: { render_js: "true", country: "us" }, endpoint_override: null },
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: null,
  },
  "linkedin.com": {
    status: "operational",
    url: "https://www.linkedin.com/company/microsoft/",
    // T1 basic.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Microsoft | LinkedIn</title>",
      '"@type":"Organization"',
      "urn:li:organization",
      "/company/microsoft",
      "_org_guest_company_overview",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "reddit.com": {
    status: "operational",
    // old.reddit.com URL (server-rendered, easier to parse). T1 basic (1cr).
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
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "tripadvisor.com": {
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    // T1 basic.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "trustpilot.com": {
    status: "operational",
    url: "https://www.trustpilot.com/review/amazon.com",
    // T1 basic; partial bulk (99/100); 11 x 502 + occasional 52-byte stubs.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    // T3 render+country; 24.7% yield (60 fetch-failed/81); partial bulk (low-yield CONFIG).
    tier: { params: { render_js: "true", country: "us" }, endpoint_override: null },
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    // T1 basic; 3 x 502.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "elonmusk",
      "Elon Musk",
      "44196397",
      "react-root",
      'data-testid="tweet"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    // T1 basic.
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.45,
    reason_code: null,
  },
  "zillow.com": {
    status: "operational",
    url: "https://www.zillow.com/columbus-oh/",
    // T2 render — recovered with stable selectors.
    tier: { params: { render_js: "true" }, endpoint_override: null },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: null,
  },
};

const DEFAULT_TRIALS = 3;
// Pace between requests (ms). WebScrapingAPI enforces a 4-min per-domain wall-time
// budget and plan concurrency limits; a small inter-request delay keeps us well
// under the rate limit on smaller plans.
const PACE_MS = 1000;
// HTTP timeout per request (ms). render_js T2/T3 tiers can be very slow
// (capterra/g2 ~46-50s, booking/ebay ~24-26s in the frozen run).
const REQUEST_TIMEOUT_MS = 120000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the WebScrapingAPI GET request URL following the recipe EXACTLY.
 * - Transport: GET. Base is always ENDPOINT (this provider has no endpoint
 *   overrides; tier.endpoint_override is honored defensively but is always null).
 * - Auth = querystring "api_key" (NOT a header). Required params: api_key, url.
 *   Tier params (render_js, country) are merged in.
 * - The WebScrapingAPI recipe does NOT require cache-busting, so cacheBustCounter
 *   is accepted for signature parity but unused.
 */
function buildRequest(
  targetUrl: string,
  tier: Tier,
  apiKey: string,
  _cacheBustCounter?: number,
): string {
  const base = tier.endpoint_override || ENDPOINT;
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("url", targetUrl);
  for (const [k, v] of Object.entries(tier.params || {})) {
    params.set(k, v);
  }
  return base + "?" + params.toString();
}

/**
 * Perform the request. Returns [ok, body, latencyMs]. Never throws.
 * WebScrapingAPI returns the target's raw HTML directly (no JSON envelope). We
 * read the body even on non-2xx and on the occasional 52-byte stub 200; the
 * verify_keys substring check decides PASS/FAIL, so a stub/error page fails
 * verification naturally.
 */
async function fetchTarget(
  targetUrl: string,
  tier: Tier,
  apiKey: string,
  cacheBustCounter?: number,
): Promise<[boolean, string, number]> {
  const fullUrl = buildRequest(targetUrl, tier, apiKey, cacheBustCounter);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(fullUrl, {
      headers: { Accept: "*/*" },
      signal: controller.signal,
    });
    const body = await resp.text();
    const latencyMs = Date.now() - start;
    return [resp.ok, body, latencyMs];
  } catch (e) {
    const latencyMs = Date.now() - start;
    return [false, "webscrapingapi request error: " + String(e), latencyMs];
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
  const apiKey = process.env[AUTH_ENV];
  if (!apiKey) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`webscrapingapi live test — ${trials} trial(s) per operational domain\n`);

  const results: Record<string, RunResult> = {};
  let cacheBustCounter = 0;

  for (const domain of Object.keys(DOMAINS).sort()) {
    const spec = DOMAINS[domain];

    // genuine_fail rows: DO NOT make requests — print one SKIP line.
    // (This provider's frozen slice has 0 genuine_fail rows, but we keep the
    //  branch so the script is correct for any future slice.)
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
        apiKey,
        cacheBustCounter,
      );
      latencies.push(latencyMs);
      const [passed] = verify(body, spec.verify_keys, spec.need_at_least);
      if (passed) passes += 1;
      // Pace per the provider's rate-limit / wall-time quirk.
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
