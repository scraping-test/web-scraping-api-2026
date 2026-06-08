/**
 * test-serpapi.ts — self-contained SerpApi reachability/verification test.
 *
 * WHAT THIS TESTS
 *   SerpApi is a SERP-only specialist ($0.025/search, ~40x most general scraping
 *   providers). It exposes dedicated structured-JSON "engines" for only a handful
 *   of sites. This script checks the 8 domains that have a dedicated engine and
 *   honestly SKIPs the 12 that do not (no_dedicated_engine), running N trials each
 *   and verifying that the stringified JSON response contains the expected markers.
 *
 * HOW TO RUN
 *   1. Get a SerpApi key and set it:
 *          export SERPAPI_TOKEN=...     (PowerShell: $env:SERPAPI_TOKEN="...")
 *   2. Run (Node 18+, zero npm deps, global fetch):
 *          npx tsx test-serpapi.ts             # 3 trials per operational domain
 *          npx tsx test-serpapi.ts --trials 5  # custom trial count
 *   If SERPAPI_TOKEN is unset the script prints a hint and exits 0 (never crashes).
 *
 * WHAT IT WRITES
 *   ../../test-results/serpapi.run.json  (relative to this file's location)
 *   Same schema as the frozen file:
 *       {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}
 *   success_rate / avg_latency_ms are MEASURED this run; cost is copied from the
 *   frozen slice (cost_source:"frozen") because cost is not measured live.
 *
 * PROVIDER QUIRKS (cited inline where relevant)
 *   - Transport GET; auth is a querystring param `api_key` (NOT a header).
 *   - Response is structured JSON, not HTML — we stringify the whole JSON object
 *     and run substring verification against it.
 *   - Only 8/20 domains have an engine; the other 12 are genuine_fail and skipped.
 *   - Cache-bust by appending a `_t` counter param (recipe note: "vary query or _t").
 */

import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const PROVIDER = "serpapi";
const ENDPOINT = "https://serpapi.com/search.json";
const AUTH_ENV = "SERPAPI_TOKEN";
const REPORT_DATE = "2026-06-08"; // today
const FROZEN_AVG_COST_PER_1K_USD = 25; // from frozen slice summary

// Per-trial pace (ms). SerpApi has generous per-second limits but we keep a small
// courtesy gap between paid searches ($0.025 each) to avoid burst throttling.
const PACE_MS = 1000;

interface Tier {
  params: Record<string, string>;
  endpoint_override: string | null;
}
interface DomainCfg {
  status: "operational" | "genuine_fail";
  url: string | null;
  tier: Tier;
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number | null;
  reason_code?: string;
}

// ---------------------------------------------------------------------------
// DOMAINS table — literal values embedded from serpapi.json (do NOT read at runtime).
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainCfg> = {
  "amazon.com": {
    status: "operational",
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    tier: {
      params: { engine: "amazon", k: "wireless headphones", amazon_domain: "amazon.com" },
      endpoint_override: null,
    },
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "bestbuy.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: {
      params: { engine: "bing", q: "python tutorial" },
      endpoint_override: null,
    },
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "booking.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
  "capterra.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    tier: {
      params: { engine: "ebay", _nkw: "macbook pro", ebay_domain: "ebay.com" },
      endpoint_override: null,
    },
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "g2.com": {
    status: "genuine_fail",
    url: null,
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
    reason_code: "no_dedicated_engine",
  },
  "github.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
  "google.com": {
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    tier: {
      params: { engine: "google", q: "python tutorial" },
      endpoint_override: null,
    },
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "idealista.com": {
    status: "genuine_fail",
    url: null,
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
    reason_code: "no_dedicated_engine",
  },
  "indeed.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
  "instagram.com": {
    status: "operational",
    url: "https://www.instagram.com/nike/",
    tier: {
      params: { engine: "instagram_profile", username: "natgeo" },
      endpoint_override: null,
    },
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "linkedin.com": {
    status: "genuine_fail",
    url: null,
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
    reason_code: "no_dedicated_engine",
  },
  "reddit.com": {
    status: "genuine_fail",
    url: null,
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
    reason_code: "no_dedicated_engine",
  },
  "tripadvisor.com": {
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: {
      params: { engine: "tripadvisor", q: "hotels in new york" },
      endpoint_override: null,
    },
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "trustpilot.com": {
    status: "genuine_fail",
    url: null,
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
    reason_code: "no_dedicated_engine",
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    tier: {
      params: { engine: "walmart", query: "laptop" },
      endpoint_override: null,
    },
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "x.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
  "youtube.com": {
    status: "operational",
    url: "https://www.youtube.com/@MrBeast",
    tier: {
      params: { engine: "youtube", search_query: "python tutorial" },
      endpoint_override: null,
    },
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 25,
  },
  "zillow.com": {
    status: "genuine_fail",
    url: null,
    tier: { params: {}, endpoint_override: null },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
    reason_code: "no_dedicated_engine",
  },
};

// Short human-readable note keyed by reason_code, for the SKIP line.
const REASON_NOTES: Record<string, string> = {
  no_dedicated_engine: "SerpApi is SERP-only; no dedicated engine for this site",
};

// ---------------------------------------------------------------------------
// Request builder — follows request_recipe EXACTLY.
//   transport: GET
//   auth: querystring param `api_key`
//   base: https://serpapi.com/search.json (no endpoint_override is ever set)
//   query: api_key + per-domain params verbatim, plus a _t cache-bust counter.
// ---------------------------------------------------------------------------
function buildUrl(cfg: DomainCfg, apiKey: string, trialCounter: number): string {
  const base = cfg.tier.endpoint_override || ENDPOINT;
  const qs = new URLSearchParams();
  // per-domain params verbatim (engine, q/k/etc.)
  for (const [k, v] of Object.entries(cfg.tier.params)) qs.set(k, v);
  qs.set("api_key", apiKey); // auth = querystring:api_key (NOT a header)
  // Cache-bust per recipe note ("vary query or _t param"); deterministic counter.
  qs.set("_t", String(trialCounter));
  return base + "?" + qs.toString();
}

async function fetchBody(url: string): Promise<{ text: string; ok: boolean }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const resp = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "wsa2026-serpapi-test/1.0" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await resp.text();
    return { text, ok: resp.ok };
  } catch (e) {
    return { text: "error: " + String(e), ok: false };
  }
}

/**
 * Response unwrapping for serpapi: the response is structured JSON.
 * Per recipe: stringify the WHOLE JSON response and verify substrings against it.
 * If parsing fails (e.g. an HTML error page), fall back to the raw text.
 */
function unwrap(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** Count substring hits; PASS when hits >= need_at_least. IDENTICAL in both langs. */
function verify(body: string, verifyKeys: string[], needAtLeast: number): { ok: boolean; hits: number } {
  let hits = 0;
  for (const key of verifyKeys) if (body.includes(key)) hits++;
  return { ok: hits >= needAtLeast, hits };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface DomainResult {
  status: string;
  reason_code?: string;
  pass?: number;
  trials?: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  cost_per_1k_usd: number | null;
  cost_source: string;
}

async function run(trials: number): Promise<number> {
  const apiKey = process.env[AUTH_ENV];
  // Auth check BEFORE any request — never crash if unset.
  if (!apiKey) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    return 0;
  }

  console.log(`SerpApi test — ${trials} trial(s) per operational domain\n`);

  const results: Record<string, DomainResult> = {};
  let trialCounter = 0; // global deterministic cache-bust counter

  // Stable ordering so output and JSON are reproducible.
  for (const domain of Object.keys(DOMAINS).sort()) {
    const cfg = DOMAINS[domain];

    if (cfg.status === "genuine_fail") {
      // genuine_fail domains: DO NOT make requests. Print one SKIP line.
      const reason = cfg.reason_code || "genuine_fail";
      const note = REASON_NOTES[reason] || "no dedicated engine";
      console.log(`SKIP ${domain}: ${reason} — ${note}`);
      results[domain] = {
        status: "genuine_fail",
        reason_code: reason,
        success_rate: 0,
        avg_latency_ms: null,
        cost_per_1k_usd: cfg.cost_per_1k_usd,
        cost_source: "frozen",
      };
      continue;
    }

    // operational domain — run N trials
    let passes = 0;
    const latencies: number[] = [];
    for (let i = 0; i < trials; i++) {
      trialCounter++;
      const url = buildUrl(cfg, apiKey, trialCounter);
      const t0 = Date.now();
      const { text, ok } = await fetchBody(url);
      latencies.push(Date.now() - t0);
      const body = unwrap(text);
      const { ok: okVerify } = verify(body, cfg.verify_keys, cfg.need_at_least);
      if (ok && okVerify) passes++;
      if (PACE_MS) await sleep(PACE_MS);
    }

    const sr = trials ? passes / trials : 0;
    const avgMs = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    console.log(
      `RUN  ${domain.padEnd(16)} PASS ${passes}/${trials}  SR ${Math.round(sr * 100)}%  avg ${avgMs}ms`,
    );
    results[domain] = {
      status: "operational",
      pass: passes,
      trials,
      success_rate: Math.round(sr * 10000) / 10000,
      avg_latency_ms: avgMs,
      cost_per_1k_usd: cfg.cost_per_1k_usd,
      cost_source: "frozen",
    };
  }

  writeResults(results);
  printTable(results);
  return 0;
}

function writeResults(results: Record<string, DomainResult>): void {
  const entries = Object.entries(results);
  const operational = entries.filter(([, r]) => r.status === "operational");
  const genuineFail = entries.filter(([, r]) => r.status === "genuine_fail");

  const opSrs = operational.map(([, r]) => r.success_rate ?? 0);
  const opLats = operational
    .map(([, r]) => r.avg_latency_ms)
    .filter((v): v is number => v !== null);

  const reachabilityPct = entries.length
    ? Math.round((100 * operational.length) / entries.length)
    : 0;
  const avgSuccessRate = opSrs.length
    ? Math.round((opSrs.reduce((a, b) => a + b, 0) / opSrs.length) * 10000) / 10000
    : null;
  const avgLatencyMs = opLats.length
    ? Math.round(opLats.reduce((a, b) => a + b, 0) / opLats.length)
    : null;

  const summary = {
    domains_total: entries.length,
    operational: operational.length,
    genuine_fail: genuineFail.length,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    // cost not measured live — copied from frozen slice.
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD,
    avg_cost_source: "frozen",
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

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(here, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, PROVIDER + ".run.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`\nWrote ${outPath}`);
}

function printTable(results: Record<string, DomainResult>): void {
  console.log(
    `\n${"DOMAIN".padEnd(16)} ${"STATUS".padEnd(13)} ${"SR".padStart(6)} ${"AVG MS".padStart(9)}`,
  );
  console.log("-".repeat(48));
  for (const domain of Object.keys(results).sort()) {
    const r = results[domain];
    const srStr = r.success_rate !== null ? `${Math.round(r.success_rate * 100)}%` : "-";
    const avgStr = r.avg_latency_ms !== null ? String(r.avg_latency_ms) : "-";
    console.log(
      `${domain.padEnd(16)} ${r.status.padEnd(13)} ${srStr.padStart(6)} ${avgStr.padStart(9)}`,
    );
  }
}

function parseTrials(argv: string[]): number {
  const idx = argv.indexOf("--trials");
  if (idx !== -1 && argv[idx + 1]) {
    const n = parseInt(argv[idx + 1], 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 3;
}

run(parseTrials(process.argv)).then((code) => process.exit(code));
