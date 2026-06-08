/**
 * test-zyte.ts -- self-contained reachability/verification test for the Zyte API.
 *
 * WHAT IT TESTS
 *   Runs Zyte's /v1/extract endpoint against 20 frozen target domains (18 operational,
 *   2 genuine-fail) and checks whether the returned HTML contains the expected per-domain
 *   "verify keys". A domain PASSES a trial when at least `need_at_least` of its verify keys
 *   appear as substrings in the unwrapped response body.
 *
 * HOW TO RUN
 *   export ZYTE_API_KEY=...            # your Zyte API key
 *   npx tsx test-zyte.ts               # 3 trials per operational domain (default)
 *   npx tsx test-zyte.ts --trials 5    # custom trial count
 *
 *   If ZYTE_API_KEY is unset the script prints a hint and exits 0 (it never crashes).
 *
 * WHAT IT WRITES
 *   ../../test-results/zyte.run.json  (relative to this script's own location:
 *   test-scripts/zyte/ -> ../../test-results/). Same schema as the frozen file:
 *   {provider, report_date(today), frozen:false, endpoint, auth_env, summary, domains}.
 *   Cost numbers are copied from the frozen slice (cost is not measured live) and tagged
 *   "cost_source":"frozen"; success_rate and avg_latency_ms are measured this run.
 *
 * ZYTE QUIRKS (baked into this script)
 *   * Transport is POST JSON to https://api.zyte.com/v1/extract.
 *   * Auth is HTTP Basic with the API key as the USERNAME and an EMPTY password, i.e.
 *     Authorization: Basic base64("<ZYTE_API_KEY>:")  -- note the trailing colon.
 *   * Tier params come straight from the slice: httpResponseBody (t1, $0.0006/req),
 *     browserHtml (t2, $0.003/req), or extractor flags (product/article).
 *   * httpResponseBody is returned BASE64-ENCODED and MUST be decoded before verifying.
 *     browserHtml is plain text. Any other extractor output is JSON-stringified.
 *   * linkedin (451 Domain Forbidden, account-policy) and g2 (520 Website Ban) are
 *     genuine_fail: the script SKIPS them and makes no request.
 *
 * Node 18+ built-ins + global fetch ONLY. Zero npm deps. Run via "npx tsx <file>".
 */

import { Buffer } from "node:buffer";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "zyte";
const ENDPOINT = "https://api.zyte.com/v1/extract";
const AUTH_ENV = "ZYTE_API_KEY";

// Frozen summary cost figure, copied verbatim from the slice (cost is not measured live).
const FROZEN_AVG_COST_PER_1K_USD = 1.11;

// Per-provider pacing. Zyte's API is generous but the heavy browserHtml/extractor
// domains run long; a small inter-trial sleep keeps us well under any burst limit.
const PACE_MS = 1000;

// Request timeout. Zyte's browserHtml p90 can hit ~60s (zillow), so give it room.
const REQUEST_TIMEOUT_MS = 90_000;

type Tier = { params: Record<string, unknown>; endpoint_override: string | null };
type Domain = {
  status: "operational" | "genuine_fail";
  tier: Tier;
  url: string;
  cost_per_1k_usd: number | null;
  verify_keys: string[];
  need_at_least: number;
  reason_code?: string;
  note?: string;
};

// ---------------------------------------------------------------------------
// DOMAINS table -- literal values lifted from the slice. Each operational row keeps
// url, tier (params + endpoint_override), verify_keys, need_at_least, status, plus the
// frozen cost_per_1k_usd. genuine_fail rows additionally carry a reason_code + note.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, Domain> = {
  "amazon.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
  },
  "bestbuy.com": {
    status: "operational",
    tier: { params: { product: true }, endpoint_override: null },
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    cost_per_1k_usd: null,
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
  },
  "bing.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.bing.com/search?q=best+laptops+2025",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
  },
  "booking.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
  },
  "capterra.com": {
    status: "operational",
    // GB geolocation per the slice -- capterra serves a US interstitial otherwise.
    tier: { params: { httpResponseBody: true, geolocation: "GB" }, endpoint_override: null },
    url: "https://www.capterra.com/p/135003/Slack/",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
  },
  "ebay.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.ebay.com/itm/116619563010",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
  },
  "g2.com": {
    status: "genuine_fail",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.g2.com/products/slack/reviews",
    cost_per_1k_usd: null,
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    reason_code: "website_ban_520",
    note: "520 Website Ban every tier including browser actions.",
  },
  "github.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://github.com/microsoft/vscode",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
  },
  "google.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.google.com/search?q=python+tutorial",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
  },
  "idealista.com": {
    status: "operational",
    tier: { params: { product: true }, endpoint_override: null },
    url: "https://www.idealista.com/inmueble/110715434/",
    cost_per_1k_usd: null,
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
  },
  "indeed.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
  },
  "instagram.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.instagram.com/nike/",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
  },
  "linkedin.com": {
    status: "genuine_fail",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.linkedin.com/company/microsoft/",
    cost_per_1k_usd: 0,
    verify_keys: [
      "<title>Microsoft | LinkedIn</title>",
      '"@type":"Organization"',
      "urn:li:organization",
      "/company/microsoft",
      "_org_guest_company_overview",
    ],
    need_at_least: 2,
    reason_code: "domain_forbidden_451",
    note: "451 Domain Forbidden (account-policy block).",
  },
  "reddit.com": {
    status: "operational",
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://old.reddit.com/r/programming/",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      'id="siteTable"',
      'data-fullname="t3_',
      'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"',
      "<title>programming</title>",
    ],
    need_at_least: 2,
  },
  "tripadvisor.com": {
    status: "operational",
    tier: { params: { article: true }, endpoint_override: null },
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    cost_per_1k_usd: null,
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
  },
  "trustpilot.com": {
    status: "operational",
    // t1 returned 520, escalated to browserHtml ($0.003/req).
    tier: { params: { browserHtml: true }, endpoint_override: null },
    url: "https://www.trustpilot.com/review/amazon.com",
    cost_per_1k_usd: 3,
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
  },
  "walmart.com": {
    status: "operational",
    tier: { params: { product: true }, endpoint_override: null },
    url: "https://www.walmart.com/ip/604342441",
    cost_per_1k_usd: null,
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
  },
  "x.com": {
    status: "operational",
    // t1 returns login-wall HTML; browserHtml needed for real content.
    tier: { params: { browserHtml: true }, endpoint_override: null },
    url: "https://x.com/elonmusk",
    cost_per_1k_usd: 3,
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
  },
  "youtube.com": {
    status: "operational",
    // t1 httpResponseBody. Frozen note: lenient verifier; t2 browserHtml is the strict
    // alternative, but the slice's canonical tier here is httpResponseBody, so we keep it.
    tier: { params: { httpResponseBody: true }, endpoint_override: null },
    url: "https://www.youtube.com/@MrBeast",
    cost_per_1k_usd: 0.6,
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
  },
  "zillow.com": {
    status: "operational",
    // t2 browserHtml; p90 hits the 60s timeout (hence REQUEST_TIMEOUT_MS=90s).
    tier: { params: { browserHtml: true }, endpoint_override: null },
    url: "https://www.zillow.com/columbus-oh/",
    cost_per_1k_usd: 3,
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
  },
};

/**
 * Count how many verify_keys appear as substrings in body; PASS when hits >= need_at_least.
 * This rule is byte-for-byte identical to the Python implementation.
 */
function verify(body: string, verifyKeys: string[], needAtLeast: number): { passed: boolean; hits: number } {
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return { passed: hits >= needAtLeast, hits };
}

/**
 * Build the Zyte /v1/extract POST request following the slice's request_recipe EXACTLY.
 *
 * Recipe:
 *   transport: POST JSON
 *   auth:      header:Basic-keyonly  -> Authorization: Basic base64("<API_KEY>:")
 *              (API key as username, EMPTY password, trailing colon)
 *   body:      {url: targetUrl, <tier params...>}  e.g. {url, httpResponseBody:true}
 */
function buildRequest(apiKey: string, url: string, params: Record<string, unknown>): { body: string; headers: Record<string, string> } {
  const payload: Record<string, unknown> = { url, ...params };
  // Basic auth, key-only: username = API key, password = "" -> base64("<key>:").
  const token = Buffer.from(`${apiKey}:`, "utf-8").toString("base64");
  return {
    body: JSON.stringify(payload),
    headers: {
      Authorization: "Basic " + token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
}

/**
 * Turn a Zyte JSON response into a single string body for verification.
 *   * httpResponseBody is BASE64 -> decode to UTF-8 text.
 *   * browserHtml is plain text -> use as-is.
 *   * Any other extractor output (product/article/etc.) -> JSON-stringify the whole object
 *     so structured fields are still substring-searchable.
 */
function unwrap(respJson: Record<string, unknown>, params: Record<string, unknown>): string {
  if (params.httpResponseBody) {
    const b64 = respJson.httpResponseBody as string | undefined;
    return b64 ? Buffer.from(b64, "base64").toString("utf-8") : "";
  }
  if (params.browserHtml) {
    return (respJson.browserHtml as string | undefined) ?? "";
  }
  // Extractor tiers (product/article/...) or anything else: stringify the JSON payload.
  return JSON.stringify(respJson);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One request. Returns { passed, latencyMs }. */
async function runTrial(apiKey: string, dom: Domain): Promise<{ passed: boolean; latencyMs: number }> {
  const params = dom.tier.params;
  // endpoint_override is null for every Zyte domain, but honor it if ever present.
  const target = dom.tier.endpoint_override ?? ENDPOINT;
  const { body, headers } = buildRequest(apiKey, dom.url, params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(target, { method: "POST", headers, body, signal: controller.signal });
    const raw = await resp.text();
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      // Surface the HTTP status (e.g. 451/520/429) without crashing the run.
      process.stderr.write(`  HTTP ${resp.status} on request\n`);
      return { passed: false, latencyMs };
    }
    const respJson = JSON.parse(raw) as Record<string, unknown>;
    const unwrapped = unwrap(respJson, params);
    const { passed } = verify(unwrapped, dom.verify_keys, dom.need_at_least);
    return { passed, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - start;
    process.stderr.write(`  error: ${(e as Error).message}\n`);
    return { passed: false, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

function parseTrials(argv: string[]): number {
  const i = argv.indexOf("--trials");
  if (i !== -1 && i + 1 < argv.length) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isNaN(n)) return Math.max(1, n);
  }
  return 3; // default
}

async function main(): Promise<void> {
  const trials = parseTrials(process.argv.slice(2));

  // Auth check BEFORE any request. Never crash on a missing key.
  const apiKey = process.env[AUTH_ENV];
  if (!apiKey) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`zyte test -- ${trials} trials/domain -- ${today}\n`);

  const results: Record<string, unknown> = {};
  const opSuccessRates: number[] = [];
  const opLatencies: number[] = [];
  let reachable = 0;

  for (const [name, dom] of Object.entries(DOMAINS)) {
    if (dom.status === "genuine_fail") {
      // No request for genuine failures -- one explanatory SKIP line.
      console.log(`SKIP ${name}: ${dom.reason_code} -- ${dom.note}`);
      results[name] = {
        status: "genuine_fail",
        tier: dom.tier,
        url: dom.url,
        success_rate: 0,
        avg_latency_ms: null,
        cost_per_1k_usd: dom.cost_per_1k_usd,
        cost_source: "frozen",
        reason_code: dom.reason_code,
        verify_keys: dom.verify_keys,
        need_at_least: dom.need_at_least,
      };
      continue;
    }

    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      const { passed, latencyMs } = await runTrial(apiKey, dom);
      if (passed) passes += 1;
      latencies.push(latencyMs);
      if (t < trials - 1) await sleep(PACE_MS); // pace between trials
    }

    const successRate = passes / trials;
    const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    opSuccessRates.push(successRate);
    opLatencies.push(avgLatency);
    if (successRate > 0) reachable += 1;

    console.log(`  ${name.padEnd(16)} ${String(passes).padStart(4)}/${String(trials).padEnd(2)} SR=${successRate.toFixed(3)}  ${avgLatency} ms`);

    results[name] = {
      status: "operational",
      tier: dom.tier,
      url: dom.url,
      success_rate: successRate,
      pass_count: passes,
      trials,
      avg_latency_ms: avgLatency,
      cost_per_1k_usd: dom.cost_per_1k_usd,
      cost_source: "frozen",
      verify_keys: dom.verify_keys,
      need_at_least: dom.need_at_least,
    };
  }

  const total = Object.keys(DOMAINS).length;
  const operational = Object.values(DOMAINS).filter((d) => d.status === "operational").length;
  const genuineFail = total - operational;
  // reachability_pct = operational domains that produced >=1 passing trial, over total.
  const reachabilityPct = total ? Math.round((100 * reachable) / total) : 0;
  const avgSuccessRate = opSuccessRates.length
    ? Math.round((opSuccessRates.reduce((a, b) => a + b, 0) / opSuccessRates.length) * 1000) / 1000
    : 0;
  const avgLatencyMs = opLatencies.length ? Math.round(opLatencies.reduce((a, b) => a + b, 0) / opLatencies.length) : 0;

  const summary = {
    domains_total: total,
    operational,
    genuine_fail: genuineFail,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // frozen; cost isn't measured live
    avg_latency_ms: avgLatencyMs,
  };

  const out = {
    provider: PROVIDER,
    report_date: today,
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: results,
  };

  // Write ../../test-results/zyte.run.json relative to THIS file's location.
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "..", "..", "test-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  console.log(`\nsummary: reachability=${reachabilityPct}%  avg_SR=${avgSuccessRate}  avg_latency=${avgLatencyMs} ms`);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
