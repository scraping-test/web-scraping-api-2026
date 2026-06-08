/**
 * test-decodo.ts — self-contained PASS/FAIL probe for the Decodo Scraper API.
 *
 * WHAT THIS TESTS
 *   Fires the Decodo Web Scraping API (v2 /scrape endpoint) at 20 real-world target
 *   URLs (amazon, google, zillow, g2, ...). For each domain it counts how many of a
 *   small set of "verify_keys" (substrings known to appear in a good response) are
 *   present in the returned HTML. A domain PASSES a trial when at least need_at_least
 *   keys are found. We run N trials per domain and report a per-domain success rate.
 *
 *   The frozen 2026 reference numbers live in ../../test-results/decodo.json. This
 *   script writes a parallel ../../test-results/decodo.run.json in the SAME schema so
 *   you can diff your live run against the frozen baseline. Behaviorally identical to
 *   the Python port test_decodo.py.
 *
 * HOW TO RUN
 *   1. export DECODO_TOKEN="<your token>"
 *        The Decodo dashboard token is ALREADY base64(user:pass). Use it verbatim —
 *        this script does NOT re-encode it.
 *   2. npx tsx test-decodo.ts                # 3 trials per domain (default)
 *      npx tsx test-decodo.ts --trials 5     # custom trial count
 *
 *   Node 18+ built-ins + global fetch only. Zero npm deps.
 *
 * WHAT IT WRITES
 *   ../../test-results/decodo.run.json  (relative to this file's location)
 *   Schema: {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}.
 *   Each domain row carries status, measured success_rate, avg_latency_ms, and (for
 *   operational rows) the PASS count. Cost is copied from the frozen slice (not measured
 *   live) and tagged "cost_source":"frozen".
 *
 * PROVIDER QUIRKS (baked in)
 *   * Transport is POST JSON to https://scraper-api.decodo.com/v2/scrape.
 *   * Auth header: "Authorization: Basic <DECODO_TOKEN>" — token used verbatim.
 *   * Tier params (headless=html for JS render, country=xx for geo) go INTO the JSON
 *     body alongside {"url": ...}.
 *   * The response is a wrapped envelope: HTML at results[0].content, inner per-target
 *     HTTP status at results[0].status_code. We verify against results[0].content.
 *   * Concurrent load melts the g2 DataDome shield (~60% yield) while single requests
 *     are fine, so the runner is strictly SEQUENTIAL with a short pace between calls.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const PROVIDER = "decodo";
const ENDPOINT = "https://scraper-api.decodo.com/v2/scrape";
const AUTH_ENV = "DECODO_TOKEN";
const REPORT_DATE = "2026-06-08"; // today; frozen baseline shares this date

// Frozen summary cost — cost is NOT measured live, copied from the slice verbatim.
const FROZEN_AVG_COST_PER_1K_USD = 0.68;

// Pace between sequential requests. Decodo's DataDome-shielded targets (g2) collapse
// under concurrency, so we never parallelize and add a small gap between calls.
const PACE_SECONDS = 1.0;
const REQUEST_TIMEOUT_MS = 90_000; // zillow/g2 headless renders run 36-47s.

interface Tier {
  params: Record<string, string>;
  endpoint_override: string | null;
}
interface DomainSpec {
  status: string;
  tier: Tier;
  url: string;
  cost_per_1k_usd: number | null;
  verify_keys: string[];
  need_at_least: number;
  reason_code: string | null;
}

// ---------------------------------------------------------------------------
// DOMAINS — embedded literal values from the frozen slice (do NOT read it at runtime).
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainSpec> = {
  "amazon.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "bestbuy.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "bing.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.bing.com/search?q=best+laptops+2025",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "booking.com": {
    status: "operational",
    tier: { params: { headless: "html" }, endpoint_override: null },
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    cost_per_1k_usd: 1,
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "capterra.com": {
    status: "operational",
    tier: { params: { country: "gb" }, endpoint_override: null },
    url: "https://www.capterra.com/p/135003/Slack/",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "ebay.com": {
    status: "operational",
    tier: { params: { headless: "html" }, endpoint_override: null },
    url: "https://www.ebay.com/itm/116619563010",
    cost_per_1k_usd: 1,
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "g2.com": {
    status: "operational",
    tier: { params: { headless: "html" }, endpoint_override: null },
    url: "https://www.g2.com/products/slack/reviews",
    cost_per_1k_usd: 1,
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "github.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://github.com/microsoft/vscode",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "google.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.google.com/search?q=python+tutorial",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "idealista.com": {
    status: "operational",
    tier: { params: { country: "es" }, endpoint_override: null },
    url: "https://www.idealista.com/inmueble/110715434/",
    cost_per_1k_usd: null, // null in frozen slice
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "indeed.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "instagram.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.instagram.com/nike/",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "linkedin.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.linkedin.com/company/microsoft/",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      "<title>Microsoft | LinkedIn</title>",
      '"@type":"Organization"',
      "urn:li:organization",
      "/company/microsoft",
      "_org_guest_company_overview",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "reddit.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://old.reddit.com/r/programming/",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      'id="siteTable"',
      'data-fullname="t3_',
      'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"',
      "<title>programming</title>",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "tripadvisor.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    cost_per_1k_usd: null, // null in frozen slice
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "trustpilot.com": {
    status: "operational",
    tier: { params: { headless: "html" }, endpoint_override: null },
    url: "https://www.trustpilot.com/review/amazon.com",
    cost_per_1k_usd: 1,
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "walmart.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.walmart.com/ip/604342441",
    cost_per_1k_usd: null, // null in frozen slice
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "x.com": {
    status: "operational",
    tier: { params: { headless: "html" }, endpoint_override: null },
    url: "https://x.com/elonmusk",
    cost_per_1k_usd: 1,
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    reason_code: null,
  },
  "youtube.com": {
    status: "operational",
    tier: { params: {}, endpoint_override: null },
    url: "https://www.youtube.com/@MrBeast",
    cost_per_1k_usd: 0.5,
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
  "zillow.com": {
    status: "operational",
    tier: { params: { headless: "html" }, endpoint_override: null },
    url: "https://www.zillow.com/columbus-oh/",
    cost_per_1k_usd: 1,
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    reason_code: null,
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Request builder — follows the slice request_recipe EXACTLY.
//   transport POST, auth header Basic, body {url} + tier params merged in.
// ---------------------------------------------------------------------------
function buildRequest(token: string, url: string, tier: Tier): { endpoint: string; init: RequestInit } {
  const endpoint = tier.endpoint_override || ENDPOINT;
  // Tier params (headless="html", country="es") go straight into the JSON body.
  const body: Record<string, unknown> = { url, ...tier.params };
  return {
    endpoint,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Token is ALREADY base64(user:pass) — use verbatim, do NOT re-encode.
        Authorization: "Basic " + token,
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Decodo wraps the page in a JSON envelope: results[0].content holds the HTML,
 * results[0].status_code is the inner per-target status. Verify against .content.
 * Returns ["", null] on any shape mismatch.
 */
function unwrapResponse(rawText: string): [string, number | null] {
  let payload: any;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return ["", null];
  }
  const results = payload?.results;
  if (Array.isArray(results) && results.length > 0) {
    const first = results[0];
    if (first && typeof first === "object") {
      let content = first.content ?? "";
      const inner = typeof first.status_code === "number" ? first.status_code : null;
      // Some endpoints return JSON content as an object — stringify so substring
      // verify still works.
      if (typeof content !== "string") content = JSON.stringify(content);
      return [content, inner];
    }
  }
  return ["", null];
}

/**
 * Count substring hits among verify_keys; PASS when hits >= need_at_least.
 * IDENTICAL rule to the Python port.
 */
function verify(body: string, verifyKeys: string[], needAtLeast: number): [boolean, number] {
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return [hits >= needAtLeast, hits];
}

async function runTrial(
  token: string,
  url: string,
  tier: Tier,
): Promise<{ body: string | null; latencyMs: number; note: string }> {
  const start = Date.now();
  const { endpoint, init } = buildRequest(token, url, tier);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, { ...init, signal: controller.signal });
    const rawText = await resp.text();
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return { body: null, latencyMs, note: `HTTP ${resp.status}` };
    }
    const [body, inner] = unwrapResponse(rawText);
    if (!body) {
      return { body: null, latencyMs, note: `empty/unparseable envelope (inner=${inner})` };
    }
    return { body, latencyMs, note: "" };
  } catch (e: any) {
    const latencyMs = Date.now() - start;
    const reason = e?.name === "AbortError" ? "timeout" : `network: ${e?.message ?? e}`;
    return { body: null, latencyMs, note: reason };
  } finally {
    clearTimeout(timer);
  }
}

function parseTrials(argv: string[]): number {
  const i = argv.indexOf("--trials");
  if (i !== -1 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3; // default
}

async function main(): Promise<void> {
  const trials = parseTrials(process.argv);

  // --- Auth check FIRST, before any request. Never crash on missing token. ---
  const token = (process.env[AUTH_ENV] ?? "").trim();
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  console.log(`Decodo probe — ${trials} trial(s)/domain, endpoint ${ENDPOINT}\n`);

  const domainResults: Record<string, any> = {};
  const operationalSrs: number[] = [];
  const operationalLatencies: number[] = [];
  let reachable = 0;
  const total = Object.keys(DOMAINS).length;

  for (const [domain, spec] of Object.entries(DOMAINS)) {
    // genuine_fail rows: DO NOT request. (Decodo slice has none, but honor the rule.)
    if (spec.status !== "operational") {
      const note = spec.reason_code ?? "non-operational";
      console.log(`SKIP ${domain}: ${note} — not requested (genuine_fail in frozen baseline)`);
      domainResults[domain] = {
        status: spec.status,
        tier: spec.tier,
        url: spec.url,
        success_rate: 0,
        avg_latency_ms: 0,
        cost_per_1k_usd: spec.cost_per_1k_usd,
        cost_source: "frozen",
        verify_keys: spec.verify_keys,
        need_at_least: spec.need_at_least,
        reason_code: spec.reason_code,
      };
      continue;
    }

    reachable += 1;
    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      const { body, latencyMs } = await runTrial(token, spec.url, spec.tier);
      let ok = false;
      if (body) {
        [ok] = verify(body, spec.verify_keys, spec.need_at_least);
      }
      if (ok) passes += 1;
      latencies.push(latencyMs);
      // Sequential pacing — DataDome shield (g2) collapses under concurrency.
      if (t !== trials - 1) await sleep(PACE_SECONDS * 1000);
    }

    const sr = Math.round((passes / trials) * 10000) / 10000;
    const avgLat = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    operationalSrs.push(sr);
    operationalLatencies.push(avgLat);
    domainResults[domain] = {
      status: "operational",
      tier: spec.tier,
      url: spec.url,
      success_rate: sr,
      pass_count: passes,
      trials,
      avg_latency_ms: avgLat,
      cost_per_1k_usd: spec.cost_per_1k_usd,
      cost_source: "frozen",
      verify_keys: spec.verify_keys,
      need_at_least: spec.need_at_least,
    };
    console.log(
      `  ${domain.padEnd(16)} SR=${String(Math.round(sr * 100)).padStart(3)}%  ${String(avgLat).padStart(5)} ms  (${passes}/${trials} pass)`,
    );
  }

  // --- Summary, computed the same way as the frozen file. ---
  const avgSr = operationalSrs.length
    ? Math.round((operationalSrs.reduce((a, b) => a + b, 0) / operationalSrs.length) * 10000) / 10000
    : 0;
  const avgLat = operationalLatencies.length
    ? Math.round(operationalLatencies.reduce((a, b) => a + b, 0) / operationalLatencies.length)
    : 0;
  const operationalCount = Object.values(DOMAINS).filter((s) => s.status === "operational").length;
  const summary = {
    domains_total: total,
    operational: operationalCount,
    genuine_fail: total - operationalCount,
    reachability_pct: total ? Math.round((reachable / total) * 100) : 0,
    avg_success_rate: avgSr,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // frozen — cost not measured live
    avg_latency_ms: avgLat,
  };

  const out = {
    provider: PROVIDER,
    report_date: REPORT_DATE,
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: domainResults,
  };

  // Write ../../test-results/decodo.run.json relative to THIS file's location.
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(here, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  // --- Clean per-domain table to stdout. ---
  console.log(`\n${"DOMAIN".padEnd(18)} ${"STATUS".padEnd(12)} ${"SR".padStart(6)} ${"AVG ms".padStart(9)}`);
  console.log("-".repeat(48));
  for (const [domain, row] of Object.entries(domainResults)) {
    const r: any = row;
    console.log(
      `${domain.padEnd(18)} ${String(r.status).padEnd(12)} ${(Math.round(r.success_rate * 100) + "%").padStart(6)} ${String(r.avg_latency_ms).padStart(8)}`,
    );
  }
  console.log("-".repeat(48));
  console.log(
    `avg_success_rate=${summary.avg_success_rate.toFixed(3)}  reachability=${summary.reachability_pct}%  avg_latency=${summary.avg_latency_ms} ms`,
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
