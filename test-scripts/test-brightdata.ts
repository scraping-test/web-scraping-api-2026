/**
 * test-brightdata.ts — self-contained live test for the Bright Data Web Unlocker API.
 *
 * WHAT THIS TESTS
 *   Fetches 20 real-world target pages (amazon, google, linkedin, zillow, ...) through
 *   Bright Data's Unlocker / SERP product and checks that the returned raw HTML actually
 *   contains domain-specific markers (verify_keys). This catches the well-known failure
 *   mode where Bright Data returns HTTP 200 with an "Access denied" / challenge page that
 *   *looks* successful (see request_recipe note in the slice). A trial only PASSes when
 *   at least `need_at_least` of the verify_keys are present in the body.
 *
 * HOW TO RUN
 *   export BRIGHTDATA_TOKEN=<your-api-token>      # Windows: set BRIGHTDATA_TOKEN=...
 *   npx tsx test-brightdata.ts                    # 3 trials per domain (default)
 *   npx tsx test-brightdata.ts --trials 5         # custom trial count
 *
 *   Node 18+ built-ins + global fetch ONLY. Zero npm dependencies.
 *
 * WHAT IT WRITES
 *   ../../test-results/brightdata.run.json  (relative to this script's own location)
 *   Same schema as the frozen 2026 file so you can diff measured-vs-frozen numbers.
 *   Cost is NOT measured live — it is copied from the frozen slice and tagged
 *   "cost_source":"frozen".
 *
 * REQUEST SHAPE (per slice request_recipe — Bright Data /request endpoint)
 *   POST https://api.brightdata.com/request
 *   Authorization: Bearer <BRIGHTDATA_TOKEN>
 *   Content-Type: application/json
 *   Body: {"zone": <zone>, "url": <targetUrl>, "format": "raw", ...per-domain params}
 *   Response: the raw HTML body of the target page (NOT a JSON envelope).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Provider constants (embedded literally from the slice — NOT read at runtime).
// ---------------------------------------------------------------------------
const PROVIDER = "brightdata";
const ENDPOINT = "https://api.brightdata.com"; // slice.endpoint (top-level identity)
const AUTH_ENV = "BRIGHTDATA_TOKEN"; // slice.auth_env
const REPORT_DATE = "2026-06-08"; // today (frozen run date for this tool)

// Frozen summary cost figure — cost is not measurable live, copied verbatim.
const FROZEN_AVG_COST_PER_1K_USD = 1.55;

// Bright Data Unlocker is per-account-rate-limited and some targets are very slow
// (booking ~31s, capterra ~52s, g2 ~43s). Pace a small gap between trials and use a
// generous per-request timeout so slow domains finish instead of FAILing falsely.
const PACE_MS = 1000;
const REQUEST_TIMEOUT_MS = 90_000;

interface Tier {
  params: Record<string, string>;
  endpoint_override: string;
}
interface DomainCfg {
  url: string;
  tier: Tier;
  verify_keys: string[];
  need_at_least: number;
  status: string;
  reason_code: string | null;
  cost_per_1k_usd: number;
}

// ---------------------------------------------------------------------------
// DOMAINS table — literal values lifted from the slice "domains" object.
// brightdata has 0 genuine_fail rows, so reason_code is null everywhere here.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainCfg> = {
  "amazon.com": {
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    tier: { params: { zone: "unlocker", country: "us" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["productTitle", 'id="dp-container"', 'id="centerCol"', 'data-asin="B07FZ8S74R"', "nav-logo-base"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "bestbuy.com": {
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    tier: { params: { zone: "unlocker", country: "us" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["application/ld+json", '"@type":"Product"', '"sku":"6570601"', '"customerPrice"', "add-to-cart-button"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 2.5,
  },
  "bing.com": {
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>best laptops 2025 - Search</title>", 'id="b_content"', 'id="sb_form"', 'class="b_algo', 'class="b_attribution'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "booking.com": {
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["hp_hotel_name", "data-capla-component-boundary", '"@type" : "Hotel"', '"hotelId":', '"reviewCount"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "capterra.com": {
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: { params: { zone: "unlocker", country: "gb" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>Slack Software Pricing", '"@type":"SoftwareApplication"', '"name":"Slack"', 'data-testid="hero-section"', "/p/135003/Slack"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "ebay.com": {
    url: "https://www.ebay.com/itm/116619563010",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["itm.ebaydesc.com", "ebayLogoTitle", '"product":', "p.ebaystatic.com", '"@type":"Product"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "g2.com": {
    url: "https://www.g2.com/products/slack/reviews",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>Slack Reviews 2026", 'itemprop="ratingValue"', 'itemprop="reviewBody"', "products/slack/reviews", "Filter 39001 reviews"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "github.com": {
    url: "https://github.com/microsoft/vscode",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>GitHub - microsoft/vscode", 'data-testid="latest-commit-details"', 'data-testid="view-all-files-row"', 'id="repository-container-header"', "github.com/microsoft/vscode"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "google.com": {
    url: "https://www.google.com/search?q=python+tutorial",
    // SERP zone (not unlocker) — Bright Data's dedicated search product.
    tier: { params: { zone: "serp" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ['id="search"', 'id="rso"', 'id="rcnt"', "<title>python tutorial - Google Search</title>", 'itemtype="http://schema.org/SearchResultsPage"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "idealista.com": {
    url: "https://www.idealista.com/inmueble/110715434/",
    tier: { params: { zone: "unlocker", country: "es" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ['class="main-info__title-main"', 'class="info-data-price"', "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "indeed.com": {
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>", 'data-jk="', 'class="job_seen_beacon', 'data-testid="company-name"', 'id="mosaic-provider-jobcards"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "instagram.com": {
    url: "https://www.instagram.com/nike/",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ['"username":"nike"', "<title>Nike (&#064;nike)", "instagram://user?username=nike", 'href="https://www.instagram.com/nike/"', 'og:type" content="profile"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "linkedin.com": {
    url: "https://www.linkedin.com/company/microsoft/",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>Microsoft | LinkedIn</title>", '"@type":"Organization"', "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "reddit.com": {
    url: "https://old.reddit.com/r/programming/",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ['id="siteTable"', 'data-fullname="t3_', 'data-subreddit="programming"', 'data-subreddit-prefixed="r/programming"', "<title>programming</title>"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "tripadvisor.com": {
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["Fairmont", "THE PLAZA NEW YORK", '"@type":"LodgingBusiness"', '"aggregateRating"', "data-automation"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "trustpilot.com": {
    url: "https://www.trustpilot.com/review/amazon.com",
    // T2: needs country=us geo-pinning per slice quirk to avoid the challenge page.
    tier: { params: { zone: "unlocker", country: "us" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["data-service-review-card-paper", "data-service-review-rating", '"@type":"Organization"', '"@type":"AggregateRating"', "data-business-unit-json-ld"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "walmart.com": {
    url: "https://www.walmart.com/ip/604342441",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["<title>Apple, AirPods with Charging Case", '"itemId":"604342441"', 'data-testid="price-wrap"', 'id="__NEXT_DATA__"', 'data-testid="hero-image-container"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "x.com": {
    url: "https://x.com/elonmusk",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "youtube.com": {
    url: "https://www.youtube.com/@MrBeast",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ['"channelMetadataRenderer"', '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"', "ytInitialData", '"title":"MrBeast"', '"subscriberCountText"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
  "zillow.com": {
    url: "https://www.zillow.com/columbus-oh/",
    tier: { params: { zone: "unlocker" }, endpoint_override: "https://api.brightdata.com/request" },
    verify_keys: ['data-testid="property-card"', '"zpid":', '"@type":"SingleFamilyResidence"', '"streetAddress"', '"bedrooms"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 1.5,
  },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Request builder + fetch — follows the slice request_recipe EXACTLY:
//   transport POST, auth header Bearer, body {zone, url, format:"raw", ...params}.
// ---------------------------------------------------------------------------
async function fetchOne(token: string, cfg: DomainCfg): Promise<{ body: string | null; latencyMs: number; error: string | null }> {
  const { endpoint_override: endpoint, params } = cfg.tier;
  // Body: zone + target url + raw HTML format, merged with per-domain params
  // (zone, country). 'format: raw' makes Bright Data return the page body directly.
  const body = { url: cfg.url, format: "raw", ...params };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, // auth: header:Bearer
        "Content-Type": "application/json",
        Accept: "*/*",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Bright Data /request with format:raw returns the target page text directly
    // (even on 4xx it usually carries a useful body), so always read text().
    const text = await resp.text();
    const latencyMs = Date.now() - start;
    const error = resp.ok ? null : `HTTP ${resp.status}`;
    return { body: text, latencyMs, error };
  } catch (e) {
    const latencyMs = Date.now() - start;
    return { body: null, latencyMs, error: (e as Error).name || "Error" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// verify(): count substring hits; PASS when hits >= need_at_least.
// IDENTICAL rule to the Python port.
// ---------------------------------------------------------------------------
function verify(body: string | null, verifyKeys: string[], needAtLeast: number): { ok: boolean; hits: number } {
  if (!body) return { ok: false, hits: 0 };
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits++;
  }
  return { ok: hits >= needAtLeast, hits };
}

interface DomainResult {
  status: string;
  tier: Tier;
  url: string;
  success_rate: number;
  pass_count?: number;
  trials?: number;
  avg_latency_ms: number;
  cost_per_1k_usd: number;
  cost_source: string;
  reason_code?: string | null;
  verify_keys: string[];
  need_at_least: number;
}

async function runDomain(token: string, cfg: DomainCfg, trials: number): Promise<DomainResult> {
  let passes = 0;
  const latencies: number[] = [];
  for (let i = 0; i < trials; i++) {
    const { body, latencyMs } = await fetchOne(token, cfg);
    latencies.push(latencyMs);
    const { ok } = verify(body, cfg.verify_keys, cfg.need_at_least);
    if (ok) passes++;
    await sleep(PACE_MS); // rate-limit pacing per provider quirk
  }
  const successRate = trials ? passes / trials : 0;
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return {
    status: "operational",
    tier: cfg.tier,
    url: cfg.url,
    success_rate: successRate,
    pass_count: passes,
    trials,
    avg_latency_ms: avgLatency,
    cost_per_1k_usd: cfg.cost_per_1k_usd,
    cost_source: "frozen",
    verify_keys: cfg.verify_keys,
    need_at_least: cfg.need_at_least,
  };
}

function parseTrials(argv: string[]): number {
  const idx = argv.indexOf("--trials");
  if (idx !== -1 && argv[idx + 1]) {
    const n = parseInt(argv[idx + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3; // default
}

async function main(): Promise<void> {
  const trials = parseTrials(process.argv);

  // Auth check BEFORE any request — never crash on missing key.
  const token = process.env[AUTH_ENV];
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  console.log(`Bright Data Web Unlocker — live test (${trials} trials/domain)`);
  console.log("=".repeat(72));

  const results: Record<string, DomainResult> = {};
  let operationalCount = 0;
  let skippedCount = 0;

  for (const [domain, cfg] of Object.entries(DOMAINS)) {
    if (cfg.status !== "operational") {
      // genuine_fail rows: DO NOT make requests; print one SKIP line.
      const reason = cfg.reason_code || "genuine_fail";
      console.log(`SKIP ${domain}: ${reason} — known failure — not requested live`);
      skippedCount++;
      results[domain] = {
        status: cfg.status,
        tier: cfg.tier,
        url: cfg.url,
        success_rate: 0,
        avg_latency_ms: 0,
        cost_per_1k_usd: cfg.cost_per_1k_usd,
        cost_source: "frozen",
        reason_code: cfg.reason_code,
        verify_keys: cfg.verify_keys,
        need_at_least: cfg.need_at_least,
      };
      continue;
    }

    operationalCount++;
    const res = await runDomain(token, cfg, trials);
    results[domain] = res;
    console.log(
      `  ${domain.padEnd(16)} ${String(res.pass_count).padStart(3)}/${String(res.trials).padEnd(3)} PASS   ` +
        `SR=${res.success_rate.toFixed(3)}   ${String(res.avg_latency_ms).padStart(6)} ms`,
    );
  }

  // ---- summary (same method as the frozen file) ----
  const opRows = Object.values(results).filter((r) => r.status === "operational");
  const domainsTotal = Object.keys(DOMAINS).length;
  const reachabilityPct = domainsTotal ? Math.round((10000 * operationalCount) / domainsTotal) / 100 : 0;
  const avgSuccessRate = opRows.length
    ? Math.round((opRows.reduce((a, r) => a + r.success_rate, 0) / opRows.length) * 10000) / 10000
    : 0;
  const avgLatencyMs = opRows.length
    ? Math.round(opRows.reduce((a, r) => a + r.avg_latency_ms, 0) / opRows.length)
    : 0;

  const summary = {
    domains_total: domainsTotal,
    operational: operationalCount,
    genuine_fail: skippedCount,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // frozen — not measured live
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

  // Write ../../test-results/brightdata.run.json relative to THIS script's location.
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "..", "..", "test-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  // ---- clean per-domain table to stdout ----
  console.log("=".repeat(72));
  console.log(`${"DOMAIN".padEnd(16)} ${"STATUS".padEnd(12)} ${"SR".padStart(7)}  ${"AVG_MS".padStart(9)}`);
  console.log("-".repeat(72));
  for (const [domain, r] of Object.entries(results)) {
    console.log(
      `${domain.padEnd(16)} ${r.status.padEnd(12)} ${r.success_rate.toFixed(3).padStart(7)}  ${String(r.avg_latency_ms).padStart(9)}`,
    );
  }
  console.log("-".repeat(72));
  console.log(`reachability=${summary.reachability_pct}%  avg_SR=${summary.avg_success_rate.toFixed(3)}  avg_ms=${summary.avg_latency_ms}`);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
