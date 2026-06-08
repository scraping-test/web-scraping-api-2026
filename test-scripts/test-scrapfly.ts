/**
 * test-scrapfly.ts — Self-contained reachability/verification test for the Scrapfly
 * web-scraping API, frozen against the 2026-06-08 benchmark numbers.
 *
 * WHAT IT TESTS
 *   For each of the 20 target domains in the frozen Scrapfly tier table, it issues
 *   N trials (default 3) through the Scrapfly /scrape endpoint using that domain's
 *   exact tier params (render_js / asp / country / proxy_pool), unwraps the JSON
 *   envelope (result.content holds the rendered HTML), and verifies the HTML contains
 *   at least `need_at_least` of the domain's verify_keys substrings. PASS when
 *   hits >= need_at_least.
 *
 * HOW TO RUN
 *   deps:   none — Node 18+ built-ins + global fetch only, zero npm deps.
 *   auth:   export SCRAPFLY_TOKEN=<your scrapfly api key>   (Windows: set SCRAPFLY_TOKEN=...)
 *   run:    npx tsx test-scrapfly.ts
 *   trials: npx tsx test-scrapfly.ts --trials 5
 *   If SCRAPFLY_TOKEN is unset the script prints a hint and exits 0 (never crashes).
 *
 * WHAT IT WRITES
 *   ../../test-results/scrapfly.run.json  (relative to this file's location)
 *   Same schema as the frozen file: {provider, report_date, frozen:false, endpoint,
 *   auth_env, summary, domains}. success_rate + avg_latency_ms are measured live this
 *   run; avg_cost_per_1k_usd is copied from the frozen slice ("cost_source":"frozen").
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "scrapfly";
const ENDPOINT = "https://api.scrapfly.io/scrape";
const AUTH_ENV = "SCRAPFLY_TOKEN";
const REPORT_DATE = "2026-06-08"; // today

interface DomainCfg {
  status: "operational" | "genuine_fail";
  url: string;
  params: Record<string, string>;
  endpoint_override: string | null;
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number;
  reason_code: string | null;
}

// ---------------------------------------------------------------------------
// DOMAINS table — literal values embedded from the frozen slice. NOT read at runtime.
// Scrapfly's 2026 slice has zero genuine_fail rows — all 20 are operational.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainCfg> = {
  "amazon.com": {
    status: "operational",
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    params: { proxy_pool: "public_residential_pool", country: "us" },
    endpoint_override: null,
    verify_keys: ["productTitle", 'id="dp-container"', 'id="centerCol"',
      'data-asin="B07FZ8S74R"', "nav-logo-base"],
    need_at_least: 2,
    cost_per_1k_usd: 3.75,
    reason_code: null,
  },
  "bestbuy.com": {
    status: "operational",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    params: { proxy_pool: "public_residential_pool" },
    endpoint_override: null,
    verify_keys: ["application/ld+json", '"@type":"Product"', '"sku":"6570601"',
      '"customerPrice"', "add-to-cart-button"],
    need_at_least: 2,
    cost_per_1k_usd: 3.375,
    reason_code: null,
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    params: {},
    endpoint_override: null,
    verify_keys: ["<title>best laptops 2025 - Search</title>", 'id="b_content"',
      'id="sb_form"', 'class="b_algo', 'class="b_attribution'],
    need_at_least: 2,
    cost_per_1k_usd: 0.15,
    reason_code: null,
  },
  "booking.com": {
    status: "operational",
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    // T5: asp+render+residential — lower tiers return upstream 202.
    params: { asp: "true", render_js: "true", proxy_pool: "public_residential_pool" },
    endpoint_override: null,
    verify_keys: ["hp_hotel_name", "data-capla-component-boundary", '"@type" : "Hotel"',
      '"hotelId":', '"reviewCount"'],
    need_at_least: 2,
    cost_per_1k_usd: 4.065,
    reason_code: null,
  },
  "capterra.com": {
    status: "operational",
    url: "https://www.capterra.com/p/135003/Slack/",
    params: { asp: "true", country: "us" },
    endpoint_override: null,
    verify_keys: ["<title>Slack Software Pricing", '"@type":"SoftwareApplication"',
      '"name":"Slack"', 'data-testid="hero-section"', "/p/135003/Slack"],
    need_at_least: 2,
    cost_per_1k_usd: 6.757,
    reason_code: null,
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    params: { render_js: "true" },
    endpoint_override: null,
    verify_keys: ["itm.ebaydesc.com", "ebayLogoTitle", '"product":',
      "p.ebaystatic.com", '"@type":"Product"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.825,
    reason_code: null,
  },
  "g2.com": {
    status: "operational",
    url: "https://www.g2.com/products/slack/reviews",
    // ASP shield = 40cr (datadome). asp=true is required for shielded g2.
    params: { asp: "true" },
    endpoint_override: null,
    verify_keys: ["<title>Slack Reviews 2026", 'itemprop="ratingValue"',
      'itemprop="reviewBody"', "products/slack/reviews", "Filter 39001 reviews"],
    need_at_least: 2,
    cost_per_1k_usd: 6.0,
    reason_code: null,
  },
  "github.com": {
    status: "operational",
    url: "https://github.com/microsoft/vscode",
    // T1 basic params, but Scrapfly auto-routes github through residential (25cr).
    params: {},
    endpoint_override: null,
    verify_keys: ["<title>GitHub - microsoft/vscode", 'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"', 'id="repository-container-header"',
      "github.com/microsoft/vscode"],
    need_at_least: 2,
    cost_per_1k_usd: 3.75,
    reason_code: null,
  },
  "google.com": {
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    // Pin country=us to defeat geo-routing roulette on the datacenter pool.
    params: { render_js: "true", country: "us" },
    endpoint_override: null,
    verify_keys: ['id="search"', 'id="rso"', 'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.9,
    reason_code: null,
  },
  "idealista.com": {
    status: "operational",
    url: "https://www.idealista.com/inmueble/110715434/",
    params: { asp: "true" },
    endpoint_override: null,
    verify_keys: ['class="main-info__title-main"', 'class="info-data-price"',
      "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
    need_at_least: 2,
    cost_per_1k_usd: 3.075,
    reason_code: null,
  },
  "indeed.com": {
    status: "operational",
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    // Use residential; avoid asp here (cloudflare_indeed shield surcharge → 80cr).
    params: { proxy_pool: "public_residential_pool" },
    endpoint_override: null,
    verify_keys: ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="', 'class="job_seen_beacon', 'data-testid="company-name"',
      'id="mosaic-provider-jobcards"'],
    need_at_least: 2,
    cost_per_1k_usd: 3.75,
    reason_code: null,
  },
  "instagram.com": {
    status: "operational",
    url: "https://www.instagram.com/nike/",
    params: {},
    endpoint_override: null,
    verify_keys: ['"username":"nike"', "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.15,
    reason_code: null,
  },
  "linkedin.com": {
    status: "operational",
    url: "https://www.linkedin.com/company/microsoft/",
    // T1 basic but LinkedIn carries a +25cr domain surcharge (26cr/req).
    params: {},
    endpoint_override: null,
    verify_keys: ["<title>Microsoft | LinkedIn</title>", '"@type":"Organization"',
      "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
    need_at_least: 2,
    cost_per_1k_usd: 3.9,
    reason_code: null,
  },
  "reddit.com": {
    status: "operational",
    url: "https://old.reddit.com/r/programming/",
    params: { asp: "true" },
    endpoint_override: null,
    verify_keys: ['id="siteTable"', 'data-fullname="t3_', 'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"', "<title>programming</title>"],
    need_at_least: 2,
    cost_per_1k_usd: 3.675,
    reason_code: null,
  },
  "tripadvisor.com": {
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    // residential; tripadvisor carries a +10cr domain surcharge.
    params: { proxy_pool: "public_residential_pool" },
    endpoint_override: null,
    verify_keys: ["Fairmont", "THE PLAZA NEW YORK", '"@type":"LodgingBusiness"',
      '"aggregateRating"', "data-automation"],
    need_at_least: 2,
    cost_per_1k_usd: 4.515,
    reason_code: null,
  },
  "trustpilot.com": {
    status: "operational",
    url: "https://www.trustpilot.com/review/amazon.com",
    params: { asp: "true" },
    endpoint_override: null,
    verify_keys: ["data-service-review-card-paper", "data-service-review-rating",
      '"@type":"Organization"', '"@type":"AggregateRating"', "data-business-unit-json-ld"],
    need_at_least: 2,
    cost_per_1k_usd: 3.75,
    reason_code: null,
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    params: { asp: "true", country: "us" },
    endpoint_override: null,
    verify_keys: ["<title>Apple, AirPods with Charging Case", '"itemId":"604342441"',
      'data-testid="price-wrap"', 'id="__NEXT_DATA__"', 'data-testid="hero-image-container"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.15,
    reason_code: null,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    params: {},
    endpoint_override: null,
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.15,
    reason_code: null,
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    params: {},
    endpoint_override: null,
    verify_keys: ['"channelMetadataRenderer"', '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData", '"title":"MrBeast"', '"subscriberCountText"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.15,
    reason_code: null,
  },
  "zillow.com": {
    status: "operational",
    url: "https://www.zillow.com/columbus-oh/",
    // render+us; pinning country=us stabilizes geo-routing.
    params: { render_js: "true", country: "us" },
    endpoint_override: null,
    verify_keys: ['data-testid="property-card"', '"zpid":',
      '"@type":"SingleFamilyResidence"', '"streetAddress"', '"bedrooms"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.9,
    reason_code: null,
  },
};

// Frozen summary cost — copied from slice; cost is NOT measured live.
const FROZEN_AVG_COST_PER_1K_USD = 2.69;

// Scrapfly rate-limit quirk: credit-based API, generous concurrency but be polite
// between requests so we don't trip the per-account concurrency cap during a burst.
const PACING_MS = 1000;

const REQUEST_TIMEOUT_MS = 90_000; // asp+render_js domains can take >7s server-side.

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Build the full request URL following Scrapfly's recipe EXACTLY.
 * Recipe: transport=GET, auth=querystring 'key', base=https://api.scrapfly.io/scrape.
 * Query = key=<KEY>, url=<targetUrl>, plus the domain's tier params verbatim.
 * endpoint_override, when set, replaces the base URL (always null for scrapfly here).
 */
function buildUrl(apiKey: string, cfg: DomainCfg): string {
  const base = cfg.endpoint_override || ENDPOINT;
  const qs = new URLSearchParams();
  qs.set("key", apiKey);
  qs.set("url", cfg.url);
  for (const [k, v] of Object.entries(cfg.params)) {
    qs.set(k, v);
  }
  return `${base}?${qs.toString()}`;
}

/**
 * Unwrap Scrapfly's JSON envelope: the HTML lives at result.content.
 * Returns the HTML string, or "" if the envelope is missing/malformed.
 */
function unwrapResponse(rawText: string): string {
  let env: unknown;
  try {
    env = JSON.parse(rawText);
  } catch {
    return "";
  }
  if (env && typeof env === "object" && "result" in env) {
    const result = (env as Record<string, unknown>).result;
    if (result && typeof result === "object" && "content" in result) {
      const content = (result as Record<string, unknown>).content;
      if (typeof content === "string") return content;
    }
  }
  return "";
}

/**
 * Count how many verify_keys appear as substrings of body.
 * PASS when hits >= need_at_least. IDENTICAL rule to the Python port.
 */
function verify(body: string, verifyKeys: string[], needAtLeast: number): { ok: boolean; hits: number } {
  if (!body) return { ok: false, hits: 0 };
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return { ok: hits >= needAtLeast, hits };
}

interface DomainResult {
  status: DomainCfg["status"];
  passes: number;
  trials: number;
  success_rate: number;
  avg_latency_ms: number;
  cost_per_1k_usd: number;
  cost_source: "frozen";
  last_error: string | null;
  reason_code?: string | null;
}

async function runDomain(apiKey: string, cfg: DomainCfg, trials: number): Promise<DomainResult> {
  let passes = 0;
  const latencies: number[] = [];
  let lastErr: string | null = null;

  for (let i = 0; i < trials; i++) {
    const url = buildUrl(apiKey, cfg);
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: "GET", signal: controller.signal });
      const rawText = await resp.text(); // Scrapfly returns the envelope even on some error statuses.
      latencies.push(Date.now() - start);
      const html = unwrapResponse(rawText);
      const { ok } = verify(html, cfg.verify_keys, cfg.need_at_least);
      if (ok) passes += 1;
      else if (!resp.ok) lastErr = `HTTP ${resp.status}`;
    } catch (e) {
      latencies.push(Date.now() - start);
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    await sleep(PACING_MS); // pace per credit-based concurrency quirk
  }

  const successRate = trials ? passes / trials : 0;
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  return {
    status: cfg.status,
    passes,
    trials,
    success_rate: successRate,
    avg_latency_ms: avgLatency,
    cost_per_1k_usd: cfg.cost_per_1k_usd,
    cost_source: "frozen",
    last_error: lastErr,
  };
}

function parseTrials(argv: string[]): number {
  const idx = argv.indexOf("--trials");
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = parseInt(argv[idx + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3;
}

async function main(): Promise<void> {
  const trials = parseTrials(process.argv);

  // AUTH: read env BEFORE any request. Unset -> hint + exit 0 (never crash).
  const apiKey = process.env[AUTH_ENV];
  if (!apiKey) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  const domainNames = Object.keys(DOMAINS);
  console.log(`scrapfly — ${domainNames.length} domains, ${trials} trial(s) each`);
  console.log("-".repeat(64));

  const results: Record<string, DomainResult> = {};
  let operationalCount = 0;
  let skippedCount = 0;

  for (const domain of domainNames) {
    const cfg = DOMAINS[domain];
    if (cfg.status !== "operational") {
      // genuine_fail: DO NOT request. One SKIP line. (None present for scrapfly.)
      skippedCount += 1;
      const reason = cfg.reason_code || "genuine_fail";
      console.log(`SKIP ${domain}: ${reason} — not requested (frozen genuine_fail)`);
      results[domain] = {
        status: cfg.status,
        passes: 0,
        trials: 0,
        success_rate: 0,
        avg_latency_ms: 0,
        cost_per_1k_usd: cfg.cost_per_1k_usd,
        cost_source: "frozen",
        last_error: null,
        reason_code: cfg.reason_code,
      };
      continue;
    }

    operationalCount += 1;
    const res = await runDomain(apiKey, cfg, trials);
    results[domain] = res;
    const verdict = res.passes === trials ? "PASS" : res.passes > 0 ? "PARTIAL" : "FAIL";
    console.log(
      `${domain.padEnd(16)} ${verdict.padEnd(7)} ${res.passes}/${trials}  ` +
        `SR=${res.success_rate.toFixed(2)}  ${res.avg_latency_ms} ms`,
    );
  }

  // ----- summary -----
  const opRows = Object.values(results).filter((r) => r.status === "operational");
  const reachabilityPct = domainNames.length
    ? Math.round((1000 * operationalCount) / domainNames.length) / 10
    : 0;
  const avgSuccessRate = opRows.length
    ? Math.round((opRows.reduce((a, r) => a + r.success_rate, 0) / opRows.length) * 10000) / 10000
    : 0;
  const lats = opRows.map((r) => r.avg_latency_ms).filter((x) => x > 0);
  const avgLatencyMs = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;

  const summary = {
    domains_total: domainNames.length,
    operational: operationalCount,
    genuine_fail: skippedCount,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // frozen — cost not measured live
    avg_latency_ms: avgLatencyMs,
  };

  // ----- build domains output block -----
  const outDomains: Record<string, Record<string, unknown>> = {};
  for (const domain of domainNames) {
    const r = results[domain];
    const block: Record<string, unknown> = {
      status: r.status,
      success_rate: r.success_rate,
      avg_latency_ms: r.avg_latency_ms,
      cost_per_1k_usd: r.cost_per_1k_usd,
      cost_source: "frozen",
    };
    if (r.status === "operational") {
      block.passes = r.passes;
      block.trials = r.trials;
    } else {
      block.reason_code = r.reason_code ?? null;
    }
    outDomains[domain] = block;
  }

  const report = {
    provider: PROVIDER,
    report_date: REPORT_DATE,
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: outDomains,
  };

  // ----- write ../../test-results/scrapfly.run.json relative to THIS file -----
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(here, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("-".repeat(64));
  console.log(
    `reachability=${summary.reachability_pct}%  avg_SR=${summary.avg_success_rate.toFixed(4)}  ` +
      `avg_latency=${summary.avg_latency_ms} ms`,
  );
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
