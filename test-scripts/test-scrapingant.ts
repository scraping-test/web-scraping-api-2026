/**
 * test-scrapingant.ts — self-contained reachability/extraction test for the ScrapingAnt
 * web-scraping API, frozen against the 2026-06-08 benchmark numbers.
 *
 * WHAT IT TESTS
 *   For each of the 20 target domains in the frozen 2026 slice it issues N trials
 *   (default 3) against ScrapingAnt, unwraps the response, and verifies that the
 *   returned HTML contains at least `need_at_least` of the domain's `verify_keys`
 *   substrings. A domain PASSES a trial when hits >= need_at_least.
 *
 *   Five domains (g2, idealista, linkedin, tripadvisor, trustpilot) are documented
 *   GENUINE FAILS — target-side anti-bot returns 423 on every config. We DO NOT
 *   spend credits on them; each is printed as a SKIP line with its reason_code.
 *
 * HOW TO RUN
 *   export SCRAPINGANT_TOKEN=your_api_key        # Windows: set SCRAPINGANT_TOKEN=...
 *   npx tsx test-scrapingant.ts                  # 3 trials per operational domain
 *   npx tsx test-scrapingant.ts --trials 5       # custom trial count
 *
 *   If SCRAPINGANT_TOKEN is unset the script prints a hint and exits 0 (no crash).
 *
 * WHAT IT WRITES
 *   ../../test-results/scrapingant.run.json (relative to this file's location), in the
 *   same schema as the frozen file: {provider, report_date, frozen:false, endpoint,
 *   auth_env, summary, domains}. success_rate / avg_latency_ms are MEASURED this run;
 *   avg_cost_per_1k_usd is COPIED from the frozen slice (cost is not measured live).
 *
 * REQUEST RECIPE (per slice request_recipe)
 *   transport : GET
 *   auth      : querystring x-api-key=<KEY>  (NOT a header)
 *   endpoint  : https://api.scrapingant.com/v2/general
 *   params    : x-api-key, url=<targetUrl>, + tier params (browser, proxy_country,
 *               residential). Response is RAW HTML (no JSON envelope to unwrap).
 *   quirk     : PACING >= 6s between calls; per-key cooldown after ANY 4xx — we
 *               DOUBLE the next inter-call interval after a 4xx and reset to the
 *               floor after a clean response (see PACE_FLOOR_SECONDS).
 *
 * Node 18+ built-ins + global fetch only. Zero npm deps.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const PROVIDER = "scrapingant";
// Per the recipe: base is /v2 and the scrape endpoint is /v2/general.
const ENDPOINT = "https://api.scrapingant.com/v2/general";
const AUTH_ENV = "SCRAPINGANT_TOKEN";

// Pacing quirk: >= 6s between calls. After ANY 4xx the per-key cooldown doubles
// the next interval; it resets to the floor after a clean response.
const PACE_FLOOR_SECONDS = 6.0;
const PACE_CEILING_SECONDS = 60.0;
// Generous timeout: booking/capterra/indeed/zillow average 56-58s in the frozen run.
const TIMEOUT_SECONDS = 120;

// avg_cost_per_1k_usd is copied from the frozen slice summary; cost is not measured live.
const FROZEN_AVG_COST_PER_1K_USD = 2.3;

interface Tier {
  params: Record<string, string>;
  endpoint_override: string | null;
}
interface DomainCfg {
  status: "operational" | "genuine_fail";
  url: string;
  tier: Tier;
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number | null;
  reason_code?: string;
}

// ---------------------------------------------------------------------------
// DOMAINS — literal values embedded from the frozen slice (do NOT read slice at runtime).
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainCfg> = {
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
    cost_per_1k_usd: 0.19,
  },
  "bestbuy.com": {
    status: "operational",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    tier: { params: { browser: "true" }, endpoint_override: null },
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 1.9,
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
    cost_per_1k_usd: 0.19,
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
    cost_per_1k_usd: 0.19,
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
    cost_per_1k_usd: 0.19,
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
    cost_per_1k_usd: 0.19,
  },
  "g2.com": {
    // GENUINE FAIL — 423 on every config (target-side anti-bot). Never requested.
    status: "genuine_fail",
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
    cost_per_1k_usd: null,
    reason_code: "browser_detected_423",
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
    cost_per_1k_usd: 0.19,
  },
  "google.com": {
    // T5-v2-deluxe (125cr): browser + residential proxy.
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    tier: { params: { browser: "true", residential: "true" }, endpoint_override: null },
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 23.75,
  },
  "idealista.com": {
    // GENUINE FAIL — 423 on every config (same target-side block). Never requested.
    status: "genuine_fail",
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
    cost_per_1k_usd: null,
    reason_code: "browser_detected_423",
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
    cost_per_1k_usd: 0.19,
  },
  "instagram.com": {
    // T5-browser-resUS: browser + US proxy_country (recovered at 30-trial lock-in).
    status: "operational",
    url: "https://www.instagram.com/nike/",
    tier: { params: { browser: "true", proxy_country: "US" }, endpoint_override: null },
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "linkedin.com": {
    // GENUINE FAIL — 423 on every config. Never requested.
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
    reason_code: "browser_detected_423",
  },
  "reddit.com": {
    // T5-browser-resUS: browser + US proxy_country (recovered).
    status: "operational",
    url: "https://old.reddit.com/r/programming/",
    tier: { params: { browser: "true", proxy_country: "US" }, endpoint_override: null },
    verify_keys: [
      'id="siteTable"',
      'data-fullname="t3_',
      'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"',
      "<title>programming</title>",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "tripadvisor.com": {
    // GENUINE FAIL — 423 on every config. Never requested.
    status: "genuine_fail",
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
    cost_per_1k_usd: null,
    reason_code: "browser_detected_423",
  },
  "trustpilot.com": {
    // GENUINE FAIL — 423 on every config. Never requested.
    status: "genuine_fail",
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
    cost_per_1k_usd: null,
    reason_code: "browser_detected_423",
  },
  "walmart.com": {
    // T5-browser-resUS: browser + US proxy_country (recovered).
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    tier: { params: { browser: "true", proxy_country: "US" }, endpoint_override: null },
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.19,
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.19,
  },
  "zillow.com": {
    status: "operational",
    url: "https://www.zillow.com/columbus-oh/",
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.19,
  },
};

// Short human-readable notes for SKIP lines, keyed by reason_code.
const REASON_NOTES: Record<string, string> = {
  browser_detected_423: "target-side anti-bot returns 423 on every config",
};

interface DomainResult {
  status: "operational" | "genuine_fail";
  success_rate: number;
  avg_latency_ms: number | null;
  pass?: number;
  trials?: number;
  cost_per_1k_usd?: number | null;
  reason_code?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a ScrapingAnt request URL per the slice request_recipe.
 * Auth is querystring x-api-key (NOT a header). The target URL goes in the `url`
 * param, and tier params (browser, proxy_country, residential) are appended as
 * literal strings. Endpoint is /v2/general; endpoint_override is honored if set.
 */
function buildRequestUrl(cfg: DomainCfg, apiKey: string): string {
  const base = cfg.tier.endpoint_override ?? ENDPOINT;
  const params = new URLSearchParams();
  params.set("x-api-key", apiKey);
  params.set("url", cfg.url);
  // Tier params are literal strings ("true" / "US") exactly as the API expects them.
  for (const [k, v] of Object.entries(cfg.tier.params)) params.set(k, v);
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + params.toString();
}

/** ScrapingAnt's /v2/general returns raw HTML directly — no JSON envelope to unwrap. */
function unwrap(raw: string): string {
  return raw;
}

/**
 * Count substring hits among verify_keys; PASS when hits >= need_at_least.
 * IDENTICAL rule across the Python and TypeScript scripts.
 */
function verify(body: string, verifyKeys: string[], needAtLeast: number): { passed: boolean; hits: number } {
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return { passed: hits >= needAtLeast, hits };
}

/**
 * Execute one request. Returns {passed, latencyMs, hits, got4xx}.
 * got4xx drives the per-key cooldown (the runner doubles the next interval).
 */
async function runTrial(
  cfg: DomainCfg,
  apiKey: string,
): Promise<{ passed: boolean; latencyMs: number; hits: number; got4xx: boolean }> {
  const url = buildRequestUrl(cfg, apiKey);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  try {
    const resp = await fetch(url, { method: "GET", signal: controller.signal });
    const raw = await resp.text();
    const latencyMs = Date.now() - start;
    const got4xx = resp.status >= 400 && resp.status < 500;
    // Verify even on a 4xx body — some error pages still leak useful HTML, and
    // the verify rule is the single source of truth for PASS/FAIL.
    const { passed, hits } = verify(unwrap(raw), cfg.verify_keys, cfg.need_at_least);
    return { passed, latencyMs, hits, got4xx };
  } catch (err) {
    // network error, abort/timeout — counts as a failed trial (not a 4xx).
    const latencyMs = Date.now() - start;
    process.stderr.write(`    ! request error: ${(err as Error).message}\n`);
    return { passed: false, latencyMs, hits: 0, got4xx: false };
  } finally {
    clearTimeout(timer);
  }
}

function parseTrials(argv: string[]): number {
  const idx = argv.indexOf("--trials");
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = parseInt(argv[idx + 1], 10);
    if (!Number.isNaN(n)) return Math.max(1, n);
  }
  return 3;
}

async function main(): Promise<void> {
  const trials = parseTrials(process.argv.slice(2));

  // Auth check BEFORE any request — never crash on missing key.
  const apiKey = process.env[AUTH_ENV];
  if (!apiKey) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  console.log(
    `ScrapingAnt test — ${trials} trials/domain, pacing >= ${PACE_FLOOR_SECONDS}s (doubles after any 4xx)\n`,
  );

  const results: Record<string, DomainResult> = {};
  let operationalCount = 0;
  let skippedCount = 0;

  // Per-key cooldown state: starts at the floor, doubles after any 4xx, resets
  // to the floor after a clean response.
  let paceSeconds = PACE_FLOOR_SECONDS;
  let firstRequest = true;

  for (const [domain, cfg] of Object.entries(DOMAINS)) {
    if (cfg.status === "genuine_fail") {
      const reason = cfg.reason_code ?? "genuine_fail";
      const note = REASON_NOTES[reason] ?? "documented genuine fail";
      // Do NOT make requests for genuine_fail rows — print one SKIP line.
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
    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      // Pace before every request except the very first. The interval is the
      // current per-key cooldown (>= floor, doubled after a 4xx).
      if (!firstRequest) await sleep(paceSeconds * 1000);
      firstRequest = false;

      const { passed, latencyMs, hits, got4xx } = await runTrial(cfg, apiKey);
      latencies.push(latencyMs);
      if (passed) passes += 1;
      console.log(
        `  ${domain.padEnd(16)} trial ${t + 1}/${trials}: ${passed ? "PASS" : "FAIL"} ` +
          `(${hits} hits, ${latencyMs} ms${got4xx ? ", 4xx" : ""})`,
      );

      // Per-key cooldown: double after a 4xx, otherwise reset to the floor.
      paceSeconds = got4xx ? Math.min(paceSeconds * 2, PACE_CEILING_SECONDS) : PACE_FLOOR_SECONDS;
    }

    const successRate = passes / trials;
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

  writeResults(results, operationalCount, skippedCount);
  printTable(results);
}

/** Write ../../test-results/scrapingant.run.json in the frozen-file schema. */
function writeResults(
  results: Record<string, DomainResult>,
  operationalCount: number,
  skippedCount: number,
): void {
  const opRows = Object.values(results).filter((r) => r.status === "operational");
  const total = Object.keys(results).length;
  const reachabilityPct = total ? Math.round((100 * operationalCount) / total) : 0;
  const avgSuccessRate = opRows.length
    ? Math.round((opRows.reduce((a, r) => a + r.success_rate, 0) / opRows.length) * 10000) / 10000
    : 0;
  const opLatencies = opRows
    .map((r) => r.avg_latency_ms)
    .filter((v): v is number => v !== null && v !== undefined);
  const avgLatencyMs = opLatencies.length
    ? Math.round(opLatencies.reduce((a, b) => a + b, 0) / opLatencies.length)
    : null;

  const payload = {
    provider: PROVIDER,
    report_date: "2026-06-08", // today
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary: {
      domains_total: total,
      operational: operationalCount,
      genuine_fail: skippedCount,
      reachability_pct: reachabilityPct,
      avg_success_rate: avgSuccessRate,
      avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD,
      cost_source: "frozen",
      avg_latency_ms: avgLatencyMs,
    },
    domains: results,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(here, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`\nWrote ${outPath}`);
}

/** Clean per-domain table: domain, status, SR, avg ms. */
function printTable(results: Record<string, DomainResult>): void {
  console.log(`\n${"DOMAIN".padEnd(18)} ${"STATUS".padEnd(14)} ${"SR".padStart(7)} ${"AVG_MS".padStart(10)}`);
  console.log("-".repeat(52));
  for (const [domain, r] of Object.entries(results)) {
    const sr = `${Math.round(r.success_rate * 100)}%`;
    const ms = r.avg_latency_ms === null || r.avg_latency_ms === undefined ? "-" : String(r.avg_latency_ms);
    console.log(`${domain.padEnd(18)} ${r.status.padEnd(14)} ${sr.padStart(7)} ${ms.padStart(10)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
