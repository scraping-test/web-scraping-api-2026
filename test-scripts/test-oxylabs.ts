/**
 * test-oxylabs.ts — self-contained live test for the Oxylabs Web Scraper API.
 *
 * WHAT THIS TESTS
 *   Fetches 20 real-world target pages (amazon, google, linkedin, zillow, ...) through
 *   Oxylabs' Web Scraper API (Realtime endpoint /v1/queries) and checks that the returned
 *   content actually contains domain-specific markers (verify_keys). A trial only PASSes
 *   when at least `need_at_least` of the verify_keys are present in the body. We run N
 *   trials per domain (default 3) and report a per-domain success rate.
 *
 *   Two domains (booking.com, idealista.com) use Oxylabs' separate Web Unblocker product,
 *   an HTTPS forward proxy on unblock.oxylabs.io:60000. Node.js HTTP CONNECT tunneling has
 *   a masked bug, so per the slice request_recipe this TS port routes those two through the
 *   SAME realtime JSON endpoint instead (source=universal). The Web Unblocker control
 *   headers (x-oxylabs-render / x-oxylabs-geo-location) are mapped onto the equivalent
 *   realtime body params (render / geo_location) so behaviour matches. The Python script is
 *   the reference path and uses the real HTTPS proxy for those two.
 *
 * HOW TO RUN
 *   export OXYLABS_TOKEN="username:password"   # Windows: set OXYLABS_TOKEN=user:pass
 *       Oxylabs auth is HTTP Basic with your sub-user credentials. Provide raw "user:pass"
 *       — this script base64-encodes them for you (do NOT pre-encode).
 *   npx tsx test-oxylabs.ts                     # 3 trials per domain (default)
 *   npx tsx test-oxylabs.ts --trials 5          # custom trial count
 *
 *   Node 18+ built-ins + global fetch ONLY. Zero npm dependencies.
 *
 * WHAT IT WRITES
 *   ../../test-results/oxylabs.run.json  (relative to this script's own location)
 *   Same schema as the frozen 2026 file so you can diff measured-vs-frozen numbers.
 *   Cost is NOT measured live — it is copied from the frozen slice and tagged
 *   "cost_source":"frozen".
 *
 * REQUEST SHAPE (per slice request_recipe — Oxylabs realtime /v1/queries)
 *   POST https://realtime.oxylabs.io/v1/queries
 *   Authorization: Basic base64(user:pass)
 *   Content-Type: application/json
 *   Body: the per-domain params verbatim (source, url, parse, render, geo_location, query)
 *   Response: a JSON envelope; the page is at results[0].content. When parse:true
 *   (amazon_product) content is a structured object — we JSON.stringify it for verify.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Provider constants (embedded literally from the slice — NOT read at runtime).
// ---------------------------------------------------------------------------
const PROVIDER = "oxylabs";
const ENDPOINT = "https://realtime.oxylabs.io/v1/queries"; // slice.endpoint
const AUTH_ENV = "OXYLABS_TOKEN"; // slice.auth_env
const REPORT_DATE = "2026-06-08"; // today (frozen run date for this tool)

// Frozen summary cost figure — cost is not measurable live, copied verbatim.
const FROZEN_AVG_COST_PER_1K_USD = 7;

// The Web Unblocker proxy endpoint from the slice. In Python this is a live HTTPS proxy;
// in this TS port we detect it and reroute to the realtime endpoint (Node CONNECT bug).
const UNBLOCKER_ENDPOINT = "https://unblock.oxylabs.io:60000";

// Oxylabs realtime calls are slow + per-sub-user rate-limited (bestbuy ~34s, booking ~31s,
// indeed ~28s). Run strictly sequentially with a short pace and a generous timeout.
const PACE_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000;

interface Tier {
  params: Record<string, unknown>;
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
  // Web Unblocker control headers (Python path); mapped to realtime body params here.
  unblocker_headers: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// DOMAINS table — literal values lifted from the slice "domains" object.
// oxylabs has 0 genuine_fail rows, so reason_code is null everywhere here.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainCfg> = {
  "amazon.com": {
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    // Dedicated amazon_product parser with parse:true → results[0].content is structured JSON.
    tier: {
      params: { source: "amazon_product", url: "https://www.amazon.com/dp/B07FZ8S74R", parse: true },
      endpoint_override: "https://realtime.oxylabs.io/v1/queries",
    },
    verify_keys: ["productTitle", 'id="dp-container"', 'id="centerCol"', 'data-asin="B07FZ8S74R"', "nav-logo-base"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "bestbuy.com": {
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    tier: {
      params: {
        source: "universal",
        url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        render: "html",
        geo_location: "United States",
      },
      endpoint_override: "https://realtime.oxylabs.io/v1/queries",
    },
    verify_keys: ["application/ld+json", '"@type":"Product"', '"sku":"6570601"', '"customerPrice"', "add-to-cart-button"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "bing.com": {
    url: "https://www.bing.com/search?q=best+laptops+2025",
    // Dedicated bing engine — query goes in instead of url.
    tier: { params: { source: "bing", query: "best laptops 2025" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>best laptops 2025 - Search</title>", 'id="b_content"', 'id="sb_form"', 'class="b_algo', 'class="b_attribution'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "booking.com": {
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    // Web Unblocker in the frozen slice; rerouted to realtime here (Node CONNECT bug).
    // x-oxylabs-render:html → render:"html" body param so JS still renders.
    tier: { params: { url: "https://www.booking.com/hotel/us/the-plaza.html" }, endpoint_override: "https://unblock.oxylabs.io:60000" },
    verify_keys: ["hp_hotel_name", "data-capla-component-boundary", '"@type" : "Hotel"', '"hotelId":', '"reviewCount"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7,
    unblocker_headers: { "x-oxylabs-render": "html" },
  },
  "capterra.com": {
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: { params: { source: "universal", url: "https://www.capterra.com/p/135003/Slack/", render: "html" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>Slack Software Pricing", '"@type":"SoftwareApplication"', '"name":"Slack"', 'data-testid="hero-section"', "/p/135003/Slack"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "ebay.com": {
    url: "https://www.ebay.com/itm/116619563010",
    tier: { params: { source: "universal", url: "https://www.ebay.com/itm/116619563010" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["itm.ebaydesc.com", "ebayLogoTitle", '"product":', "p.ebaystatic.com", '"@type":"Product"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "g2.com": {
    url: "https://www.g2.com/products/slack/reviews",
    tier: { params: { source: "universal", url: "https://www.g2.com/products/slack/reviews", render: "html" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>Slack Reviews 2026", 'itemprop="ratingValue"', 'itemprop="reviewBody"', "products/slack/reviews", "Filter 39001 reviews"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "github.com": {
    url: "https://github.com/microsoft/vscode",
    tier: { params: { source: "universal", url: "https://github.com/microsoft/vscode" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>GitHub - microsoft/vscode", 'data-testid="latest-commit-details"', 'data-testid="view-all-files-row"', 'id="repository-container-header"', "github.com/microsoft/vscode"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "google.com": {
    url: "https://www.google.com/search?q=python+tutorial",
    // Dedicated google_search engine — query goes in instead of url.
    tier: { params: { source: "google_search", query: "python tutorial" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ['id="search"', 'id="rso"', 'id="rcnt"', "<title>python tutorial - Google Search</title>", 'itemtype="http://schema.org/SearchResultsPage"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "idealista.com": {
    url: "https://www.idealista.com/inmueble/110715434/",
    // Web Unblocker in the frozen slice; rerouted to realtime here (Node CONNECT bug).
    // x-oxylabs-geo-location:Spain → geo_location:"Spain" body param.
    tier: { params: { url: "https://www.idealista.com/inmueble/110715434/" }, endpoint_override: "https://unblock.oxylabs.io:60000" },
    verify_keys: ['class="main-info__title-main"', 'class="info-data-price"', "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7,
    unblocker_headers: { "x-oxylabs-geo-location": "Spain" },
  },
  "indeed.com": {
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: { params: { source: "universal", url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>", 'data-jk="', 'class="job_seen_beacon', 'data-testid="company-name"', 'id="mosaic-provider-jobcards"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "instagram.com": {
    url: "https://www.instagram.com/nike/",
    tier: { params: { source: "universal", url: "https://www.instagram.com/nike/" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ['"username":"nike"', "<title>Nike (&#064;nike)", "instagram://user?username=nike", 'href="https://www.instagram.com/nike/"', 'og:type" content="profile"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "linkedin.com": {
    url: "https://www.linkedin.com/company/microsoft/",
    tier: { params: { source: "universal", url: "https://www.linkedin.com/company/microsoft/" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>Microsoft | LinkedIn</title>", '"@type":"Organization"', "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "reddit.com": {
    url: "https://old.reddit.com/r/programming/",
    tier: { params: { source: "universal", url: "https://old.reddit.com/r/programming/" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ['id="siteTable"', 'data-fullname="t3_', 'data-subreddit="programming"', 'data-subreddit-prefixed="r/programming"', "<title>programming</title>"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "tripadvisor.com": {
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: {
      params: { source: "universal", url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html" },
      endpoint_override: "https://realtime.oxylabs.io/v1/queries",
    },
    verify_keys: ["Fairmont", "THE PLAZA NEW YORK", '"@type":"LodgingBusiness"', '"aggregateRating"', "data-automation"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "trustpilot.com": {
    url: "https://www.trustpilot.com/review/amazon.com",
    tier: { params: { source: "universal", url: "https://www.trustpilot.com/review/amazon.com", render: "html" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["data-service-review-card-paper", "data-service-review-rating", '"@type":"Organization"', '"@type":"AggregateRating"', "data-business-unit-json-ld"],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "walmart.com": {
    url: "https://www.walmart.com/ip/604342441",
    // Dedicated walmart_product parser.
    tier: { params: { source: "walmart_product", url: "https://www.walmart.com/ip/604342441" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["<title>Apple, AirPods with Charging Case", '"itemId":"604342441"', 'data-testid="price-wrap"', 'id="__NEXT_DATA__"', 'data-testid="hero-image-container"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "x.com": {
    url: "https://x.com/elonmusk",
    tier: { params: { source: "universal", url: "https://x.com/elonmusk" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "youtube.com": {
    url: "https://www.youtube.com/@MrBeast",
    tier: { params: { source: "universal", url: "https://www.youtube.com/@MrBeast" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ['"channelMetadataRenderer"', '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"', "ytInitialData", '"title":"MrBeast"', '"subscriberCountText"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
  "zillow.com": {
    url: "https://www.zillow.com/columbus-oh/",
    tier: { params: { source: "universal", url: "https://www.zillow.com/columbus-oh/" }, endpoint_override: "https://realtime.oxylabs.io/v1/queries" },
    verify_keys: ['data-testid="property-card"', '"zpid":', '"@type":"SingleFamilyResidence"', '"streetAddress"', '"bedrooms"'],
    need_at_least: 2, status: "operational", reason_code: null, cost_per_1k_usd: 7, unblocker_headers: null,
  },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Oxylabs auth is HTTP Basic with raw "user:pass" — base64-encode it ourselves.
function basicAuthHeader(token: string): string {
  return "Basic " + Buffer.from(token, "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// Build the realtime JSON body for a domain. Web Unblocker domains are rerouted
// here: we drop the proxy endpoint, force source=universal, and translate the
// x-oxylabs-* control headers into the equivalent realtime body params so the
// behaviour matches the Python proxy path.
// ---------------------------------------------------------------------------
function buildRealtimeBody(cfg: DomainCfg): Record<string, unknown> {
  const isUnblocker = cfg.tier.endpoint_override === UNBLOCKER_ENDPOINT;
  if (!isUnblocker) {
    return { ...cfg.tier.params }; // per-domain params verbatim
  }
  // Reroute: build a universal realtime query for the same target URL.
  const body: Record<string, unknown> = { source: "universal", url: cfg.url };
  const hdrs = cfg.unblocker_headers || {};
  if (hdrs["x-oxylabs-render"]) body.render = hdrs["x-oxylabs-render"]; // render JS
  if (hdrs["x-oxylabs-geo-location"]) body.geo_location = hdrs["x-oxylabs-geo-location"]; // geo-pin
  return body;
}

// ---------------------------------------------------------------------------
// Request builder + fetch — POST JSON to the realtime endpoint with Basic auth.
// Response is a JSON envelope: results[0].content. When parse:true (amazon),
// content is structured JSON (object) — JSON.stringify it so substring verify works.
// ---------------------------------------------------------------------------
async function fetchOne(token: string, cfg: DomainCfg): Promise<{ body: string | null; latencyMs: number; error: string | null }> {
  const requestBody = buildRealtimeBody(cfg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(token), // auth: header Basic base64(user:pass)
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await resp.text();
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return { body: null, latencyMs, error: `HTTP ${resp.status}` };
    }
    // Unwrap the realtime envelope: results[0].content (string HTML or structured object).
    let content = "";
    try {
      const payload = JSON.parse(text) as { results?: Array<{ content?: unknown }> };
      const first = payload.results && payload.results[0];
      if (first && first.content !== undefined) {
        content = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
      }
    } catch {
      return { body: null, latencyMs, error: "unparseable JSON envelope" };
    }
    if (!content) return { body: null, latencyMs, error: "no results[0].content" };
    return { body: content, latencyMs, error: null };
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
    if (i !== trials - 1) await sleep(PACE_MS); // sequential pacing per provider quirk
  }
  const successRate = trials ? Math.round((passes / trials) * 10000) / 10000 : 0;
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

  console.log(`Oxylabs Web Scraper API — live test (${trials} trials/domain)`);
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

  // Write ../../test-results/oxylabs.run.json relative to THIS script's location.
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
