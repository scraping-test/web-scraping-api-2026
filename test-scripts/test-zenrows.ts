/**
 * test-zenrows.ts — self-contained PASS/FAIL test for the ZenRows scraping API.
 *
 * WHAT IT TESTS
 *   Probes 18 operational target domains (out of 20 total; 2 are known genuine
 *   failures and are skipped, not requested). For each operational domain it
 *   runs N trials through ZenRows, takes the raw HTML response, and checks that
 *   it contains at least `need_at_least` of the domain's `verify_keys`
 *   substrings. PASS = enough keys found.
 *
 * HOW TO RUN
 *   set  ZENROWS_TOKEN=<your-api-key>   (PowerShell:  $env:ZENROWS_TOKEN="...")
 *   npx tsx test-zenrows.ts             # default 3 trials per domain
 *   npx tsx test-zenrows.ts --trials 5  # custom trial count
 *   If ZENROWS_TOKEN is unset the script prints a hint and exits 0 (never crashes).
 *
 * WHAT IT WRITES
 *   ../../test-results/zenrows.run.json (relative to this script's location)
 *   Same schema as the frozen 2026 file: {provider, report_date, frozen:false,
 *   endpoint, auth_env, summary, domains}. success_rate / avg_latency_ms are
 *   measured live this run; cost is copied from the frozen slice
 *   ("cost_source":"frozen") because cost is not measured live.
 *
 * PROVIDER NOTES (from the request recipe / quirks)
 *   - Transport: GET to https://api.zenrows.com/v1/ . Auth is a querystring
 *     param `apikey`. Target URL is the `url` param; tier params (js_render,
 *     premium_proxy, proxy_country, wait) are appended verbatim. Response is
 *     raw HTML — no JSON envelope to unwrap.
 *   - PACING QUIRK: after ~3 consecutive 4xx the API key soft-locks for ~60s.
 *     The runner backs off 60s after 3 consecutive 4xx responses to avoid
 *     cascading the lock. Developer plan is also conc=1; trials run serially.
 *   - No cache-busting param (that quirk applies only to firecrawl/serpapi).
 *
 * Node 18+ built-ins + global fetch only. Zero npm deps.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "zenrows";
const ENDPOINT = "https://api.zenrows.com/v1/";
const AUTH_ENV = "ZENROWS_TOKEN";

// Frozen summary cost figure, copied through verbatim (cost is not measured live).
const FROZEN_AVG_COST_PER_1K_USD = 2.18;

// Pacing: after 3 consecutive 4xx the key soft-locks ~60s. Back off when we hit
// the threshold. (See request_recipe.note in the slice.)
const SOFTLOCK_4XX_THRESHOLD = 3;
const SOFTLOCK_BACKOFF_MS = 60_000;
// Gentle spacing between requests on the conc=1 Developer plan.
const INTER_REQUEST_PACE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 90_000;

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

// --------------------------------------------------------------------------
// DOMAINS table — literal values embedded from the slice (NOT read at runtime).
// --------------------------------------------------------------------------
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
    cost_per_1k_usd: 0.28,
  },
  "bestbuy.com": {
    status: "genuine_fail",
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
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
    reason_code: "geo_fence_interstitial",
  },
  "bing.com": {
    status: "operational",
    url: "https://www.bing.com/search?q=best+laptops+2025",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
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
    cost_per_1k_usd: null,
  },
  "booking.com": {
    status: "operational",
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
      endpoint_override: null,
    },
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "capterra.com": {
    status: "operational",
    url: "https://www.capterra.com/p/135003/Slack/",
    tier: { params: { js_render: "true" }, endpoint_override: null },
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 1.4,
  },
  "ebay.com": {
    status: "operational",
    url: "https://www.ebay.com/itm/116619563010",
    tier: {
      params: {
        premium_proxy: "true",
        js_render: "true",
        proxy_country: "us",
        // wait=8000 clears the "Pardon Our Interruption" splash (quirk).
        wait: "8000",
      },
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
    cost_per_1k_usd: 7,
  },
  "g2.com": {
    status: "operational",
    url: "https://www.g2.com/products/slack/reviews",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
      endpoint_override: null,
    },
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
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
    cost_per_1k_usd: 0.28,
  },
  "google.com": {
    status: "operational",
    url: "https://www.google.com/search?q=python+tutorial",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
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
    cost_per_1k_usd: null,
  },
  "idealista.com": {
    status: "operational",
    url: "https://www.idealista.com/inmueble/110715434/",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
      endpoint_override: null,
    },
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "indeed.com": {
    status: "operational",
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
      endpoint_override: null,
    },
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
  "instagram.com": {
    status: "genuine_fail",
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
    cost_per_1k_usd: null,
    reason_code: "requests_forbidden_policy",
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
    cost_per_1k_usd: 0.28,
  },
  "reddit.com": {
    status: "operational",
    url: "https://old.reddit.com/r/programming/",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
      endpoint_override: null,
    },
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
    status: "operational",
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
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
    cost_per_1k_usd: null,
  },
  "trustpilot.com": {
    status: "operational",
    url: "https://www.trustpilot.com/review/amazon.com",
    tier: {
      params: { premium_proxy: "true", js_render: "true" },
      endpoint_override: null,
    },
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 7,
  },
  "walmart.com": {
    status: "operational",
    url: "https://www.walmart.com/ip/604342441",
    tier: {
      params: { premium_proxy: "true", proxy_country: "us" },
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
    cost_per_1k_usd: 2.8,
  },
  "x.com": {
    status: "operational",
    url: "https://x.com/elonmusk",
    tier: { params: {}, endpoint_override: null },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: 0.28,
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
    cost_per_1k_usd: 0.28,
  },
  "zillow.com": {
    status: "operational",
    url: "https://www.zillow.com/columbus-oh/",
    tier: {
      params: { premium_proxy: "true", js_render: "true", proxy_country: "us" },
      endpoint_override: null,
    },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: null,
  },
};

const SKIP_NOTES: Record<string, string> = {
  geo_fence_interstitial: '"Select your Country" geo-fence; UX redirect, not a technical block',
  requests_forbidden_policy: "REQS001 Requests forbidden every tier (live IG)",
};

interface DomainResult {
  status: string;
  success_rate: number;
  avg_latency_ms: number | null;
  passes?: number;
  trials?: number;
  reason_code?: string;
  cost_per_1k_usd: number | null;
  cost_source: "frozen";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Request builder — follows request_recipe EXACTLY:
//   GET https://api.zenrows.com/v1/?apikey=<KEY>&url=<targetUrl>&<tier params>
//   Auth is a querystring param. Returns raw HTML.
// endpoint_override is honored if a domain ever sets one (none do here).
// --------------------------------------------------------------------------
function buildUrl(token: string, cfg: DomainCfg): string {
  const base = cfg.tier.endpoint_override ?? ENDPOINT;
  const q = new URLSearchParams();
  q.set("apikey", token);
  q.set("url", cfg.url);
  // Tier params appended verbatim (js_render, premium_proxy, proxy_country, wait).
  for (const [k, v] of Object.entries(cfg.tier.params)) q.set(k, v);
  return base + "?" + q.toString();
}

interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  latencyMs: number;
}

async function fetchOnce(token: string, cfg: DomainCfg): Promise<FetchResult> {
  const url = buildUrl(token, cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET", // transport per recipe
      headers: { Accept: "*/*" },
      signal: ctrl.signal,
    });
    // For ZenRows the body IS the target's raw HTML; no JSON envelope to unwrap.
    const body = await resp.text();
    const latencyMs = Date.now() - start;
    return { ok: resp.ok, status: resp.status, body, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - start;
    return { ok: false, status: 0, body: "ERROR: " + String(e), latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------
// verify — IDENTICAL rule to the Python file: count substring hits among
// verify_keys; PASS when hits >= need_at_least.
// --------------------------------------------------------------------------
function verify(body: string, verifyKeys: string[], needAtLeast: number): [boolean, number] {
  if (!body) return [false, 0];
  let hits = 0;
  for (const key of verifyKeys) if (body.includes(key)) hits++;
  return [hits >= needAtLeast, hits];
}

async function run(token: string, trials: number): Promise<Record<string, DomainResult>> {
  const results: Record<string, DomainResult> = {};
  const domains = Object.keys(DOMAINS).sort();
  const lastDomain = domains[domains.length - 1];
  let consecutive4xx = 0; // tracked across the whole run for the soft-lock backoff

  for (const domain of domains) {
    const cfg = DOMAINS[domain];

    if (cfg.status !== "operational") {
      // genuine_fail: do NOT make requests. One SKIP line.
      const note = SKIP_NOTES[cfg.reason_code ?? ""] ?? "known non-technical failure";
      console.log(`SKIP ${domain}: ${cfg.reason_code} — ${note}`);
      results[domain] = {
        status: cfg.status,
        success_rate: 0,
        avg_latency_ms: null,
        reason_code: cfg.reason_code,
        cost_per_1k_usd: cfg.cost_per_1k_usd,
        cost_source: "frozen",
      };
      continue;
    }

    let passes = 0;
    const latencies: number[] = [];
    for (let t = 0; t < trials; t++) {
      const { ok, status, body, latencyMs } = await fetchOnce(token, cfg);
      latencies.push(latencyMs);

      if (ok) {
        consecutive4xx = 0;
        const [isPass, hits] = verify(body, cfg.verify_keys, cfg.need_at_least);
        if (isPass) passes++;
        console.log(
          `  ${domain} trial ${t + 1}/${trials}: HTTP ${status} ${latencyMs}ms hits=${hits} -> ${
            isPass ? "PASS" : "fail"
          }`
        );
      } else {
        // Track consecutive 4xx for the soft-lock backoff.
        if (status >= 400 && status < 500) consecutive4xx++;
        else consecutive4xx = 0;
        console.log(
          `  ${domain} trial ${t + 1}/${trials}: HTTP ${status} ${latencyMs}ms -> request-fail`
        );
        if (consecutive4xx >= SOFTLOCK_4XX_THRESHOLD) {
          // QUIRK: key soft-locks ~60s after ~3 consecutive 4xx; back off.
          console.log(
            `  [pace] ${consecutive4xx} consecutive 4xx — backing off ${
              SOFTLOCK_BACKOFF_MS / 1000
            }s (ZenRows soft-lock)`
          );
          await sleep(SOFTLOCK_BACKOFF_MS);
          consecutive4xx = 0;
        }
      }

      // Gentle pacing between requests (Developer plan conc=1).
      const isLast = domain === lastDomain && t === trials - 1;
      if (!isLast) await sleep(INTER_REQUEST_PACE_MS);
    }

    const successRate = trials ? passes / trials : 0;
    const avgLatencyMs = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    results[domain] = {
      status: "operational",
      success_rate: successRate,
      avg_latency_ms: avgLatencyMs,
      passes,
      trials,
      cost_per_1k_usd: cfg.cost_per_1k_usd,
      cost_source: "frozen",
    };
  }

  return results;
}

function buildSummary(results: Record<string, DomainResult>) {
  const all = Object.values(results);
  const operational = all.filter((r) => r.status === "operational");
  const total = all.length;
  const reachable = operational.length;
  const reachabilityPct = total ? Math.round((100 * reachable) / total) : 0;
  let avgSuccessRate = 0;
  let avgLatencyMs: number | null = null;
  if (operational.length) {
    avgSuccessRate =
      operational.reduce((a, r) => a + r.success_rate, 0) / operational.length;
    const lat = operational
      .map((r) => r.avg_latency_ms)
      .filter((v): v is number => v !== null);
    avgLatencyMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  }
  return {
    domains_total: total,
    operational: reachable,
    genuine_fail: total - reachable,
    reachability_pct: reachabilityPct,
    avg_success_rate: Math.round(avgSuccessRate * 10000) / 10000,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // frozen, not measured live
    avg_latency_ms: avgLatencyMs,
    cost_source: "frozen" as const,
  };
}

function writeResults(results: Record<string, DomainResult>, summary: ReturnType<typeof buildSummary>): string {
  // ../../test-results/ relative to this script (test-scripts/<provider>/).
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = normalize(join(here, "..", "..", "test-results"));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${PROVIDER}.run.json`);
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    provider: PROVIDER,
    report_date: today,
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: results,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  return outPath;
}

function printTable(results: Record<string, DomainResult>): void {
  console.log("\n" + ["DOMAIN".padEnd(18), "STATUS".padEnd(13), "SR".padStart(6), "AVG MS".padStart(10)].join(" "));
  console.log("-".repeat(50));
  for (const domain of Object.keys(results).sort()) {
    const r = results[domain];
    const sr = `${Math.round(r.success_rate * 100)}%`;
    const ms = r.avg_latency_ms === null ? "-" : String(r.avg_latency_ms);
    console.log(
      [domain.padEnd(18), r.status.padEnd(13), sr.padStart(6), ms.padStart(10)].join(" ")
    );
  }
}

function parseTrials(argv: string[]): number {
  const i = argv.indexOf("--trials");
  if (i !== -1 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3;
}

async function main(): Promise<number> {
  const trials = parseTrials(process.argv);

  // Auth check BEFORE any request. Exit 0 (never crash) if missing.
  const token = process.env[AUTH_ENV];
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    return 0;
  }

  console.log(`ZenRows test — endpoint ${ENDPOINT} — ${trials} trials/domain`);
  const results = await run(token, trials);
  const summary = buildSummary(results);
  const outPath = writeResults(results, summary);
  printTable(results);

  console.log(
    `\nsummary: ${summary.operational}/${summary.domains_total} operational, ` +
      `reachability ${summary.reachability_pct}%, ` +
      `avg SR ${(summary.avg_success_rate * 100).toFixed(1)}%, ` +
      `avg ${summary.avg_latency_ms ?? "-"} ms`
  );
  console.log(`wrote ${outPath}`);
  return 0;
}

main().then((code) => process.exit(code));
