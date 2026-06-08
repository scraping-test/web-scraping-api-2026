/**
 * Self-contained PASS/FAIL test for the Apify scraping provider.
 *
 * WHAT IT TESTS
 *   Runs Apify's per-domain "best-of-breed" actors against 20 frozen target
 *   domains and verifies the returned dataset contains expected content markers.
 *   Each domain uses a *different* marketplace actor (see DOMAINS[*].endpoint).
 *
 * HOW IT WORKS (Apify request recipe)
 *   - Transport: POST.
 *   - Auth: querystring ?token=<APIFY_TOKEN>  (NOT a header).
 *   - For each domain we POST to that domain's actor "run-sync-get-dataset-items"
 *     endpoint. The JSON body is the per-domain params object VERBATIM
 *     (startUrls / categoryOrProductUrls / queries / usernames / ...).
 *   - The response is a JSON ARRAY of dataset items. We JSON.stringify the whole
 *     array and substring-match the verify_keys against that serialized text.
 *   - run-sync actors cold-start slowly; per-trial timeout is 90s.
 *
 * HOW TO RUN
 *   export APIFY_TOKEN=apify_api_xxx          # Windows: set APIFY_TOKEN=...
 *   npx tsx test-apify.ts                     # 3 trials per domain (default)
 *   npx tsx test-apify.ts --trials 5          # custom trial count
 *
 *   If APIFY_TOKEN is unset the script prints a hint and exits 0 (no crash).
 *
 * WHAT IT WRITES
 *   ../../test-results/apify.run.json  (relative to this file's location)
 *   Same schema as the frozen apify.json: {provider, report_date, frozen:false,
 *   endpoint, auth_env, summary, domains}. success_rate / avg_latency_ms are
 *   MEASURED this run; cost is copied from the frozen slice (cost_source=frozen).
 *
 * QUIRKS (from the slice; affect interpretation, not the request)
 *   - Marketplace pricing varies wildly ($0.000475/result .. $0.044/run).
 *   - Some actors are PAY_PER_EVENT (reddit ~$0.044/run min).
 *   - Some actors IGNORE maxItems (x.com returns ~20 tweets despite maxItems=1).
 *   All 20 domains are operational; there are no genuine_fail rows for Apify.
 *
 * Node 18+ (global fetch). Zero npm deps.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "apify";
const ENDPOINT = "https://api.apify.com/v2";
const AUTH_ENV = "APIFY_TOKEN";

// Frozen summary cost figure (not measured live).
const FROZEN_AVG_COST_PER_1K_USD = 7.04;

// Per-trial timeout: Apify run-sync actors cold-start slowly (slice note: 90s).
const REQUEST_TIMEOUT_MS = 90_000;

// Pacing between requests. Apify has no tight rate-limit quirk in the recipe,
// but actor runs are heavy/serial; a small gap avoids hammering run-sync.
const PACE_MS = 1_000;

interface DomainCfg {
  status: "operational" | "genuine_fail";
  reason_code: string | null;
  url: string;
  endpoint: string;
  params: Record<string, unknown>;
  verify_keys: string[];
  need_at_least: number;
  cost_per_1k_usd: number;
}

// ---------------------------------------------------------------------------
// DOMAINS table — embedded literally from the frozen slice. Each entry carries:
//   url, tier{params, endpoint}, verify_keys, need_at_least, status,
//   reason_code (null — Apify has no genuine_fail rows), and the frozen
//   cost_per_1k_usd used for the written cost figure.
// ---------------------------------------------------------------------------
const DOMAINS: Record<string, DomainCfg> = {
  "amazon.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.amazon.com/dp/B07FZ8S74R",
    endpoint: "https://api.apify.com/v2/acts/junglee~Amazon-crawler/run-sync-get-dataset-items",
    params: {
      categoryOrProductUrls: [{ url: "https://www.amazon.com/dp/B07FZ8S74R" }],
      maxItemsPerStartUrl: 1,
      useCaptchaSolver: false,
    },
    verify_keys: [
      "productTitle",
      'id="dp-container"',
      'id="centerCol"',
      'data-asin="B07FZ8S74R"',
      "nav-logo-base",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 5,
  },
  "bestbuy.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
    endpoint: "https://api.apify.com/v2/acts/piotrv1001~bestbuy-listings-scraper/run-sync-get-dataset-items",
    params: {
      searchUrls: [{ url: "https://www.bestbuy.com/site/searchpage.jsp?st=iphone" }],
      maxItems: 10,
    },
    verify_keys: [
      "application/ld+json",
      '"@type":"Product"',
      '"sku":"6570601"',
      '"customerPrice"',
      "add-to-cart-button",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 10.15,
  },
  "bing.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.bing.com/search?q=best+laptops+2025",
    endpoint: "https://api.apify.com/v2/acts/ivanvs~bing-scraper/run-sync-get-dataset-items",
    params: {
      queries: ["best laptops 2025"],
      resultsPerPage: 10,
    },
    verify_keys: [
      "<title>best laptops 2025 - Search</title>",
      'id="b_content"',
      'id="sb_form"',
      'class="b_algo',
      'class="b_attribution',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 6.1,
  },
  "booking.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.booking.com/hotel/us/the-plaza.html",
    endpoint: "https://api.apify.com/v2/acts/voyager~booking-scraper/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.booking.com/hotel/us/the-plaza.html" }],
      maxItems: 1,
    },
    verify_keys: [
      "hp_hotel_name",
      "data-capla-component-boundary",
      '"@type" : "Hotel"',
      '"hotelId":',
      '"reviewCount"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 1.075,
  },
  "capterra.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.capterra.com/p/135003/Slack/",
    endpoint: "https://api.apify.com/v2/acts/crawlerbros~capterra-scraper/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.capterra.com/p/135003/Slack/" }],
      maxItems: 1,
    },
    verify_keys: [
      "<title>Slack Software Pricing",
      '"@type":"SoftwareApplication"',
      '"name":"Slack"',
      'data-testid="hero-section"',
      "/p/135003/Slack",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 6.055,
  },
  "ebay.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.ebay.com/itm/116619563010",
    endpoint: "https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items",
    params: {
      keywords: ["macbook pro"],
      count: 1,
    },
    verify_keys: [
      "itm.ebaydesc.com",
      "ebayLogoTitle",
      '"product":',
      "p.ebaystatic.com",
      '"@type":"Product"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 4.1,
  },
  "g2.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.g2.com/products/slack/reviews",
    endpoint: "https://api.apify.com/v2/acts/automation-lab~g2-scraper/run-sync-get-dataset-items",
    params: {
      productSlugs: ["slack", "jira-software"],
    },
    verify_keys: [
      "<title>Slack Reviews 2026",
      'itemprop="ratingValue"',
      'itemprop="reviewBody"',
      "products/slack/reviews",
      "Filter 39001 reviews",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 13.75,
  },
  "github.com": {
    status: "operational",
    reason_code: null,
    url: "https://github.com/microsoft/vscode",
    endpoint: "https://api.apify.com/v2/acts/crawlerbros~github-repo-intelligence/run-sync-get-dataset-items",
    params: {
      repoUrls: ["https://github.com/microsoft/vscode"],
    },
    verify_keys: [
      "<title>GitHub - microsoft/vscode",
      'data-testid="latest-commit-details"',
      'data-testid="view-all-files-row"',
      'id="repository-container-header"',
      "github.com/microsoft/vscode",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 4.555,
  },
  "google.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.google.com/search?q=python+tutorial",
    endpoint: "https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items",
    params: {
      queries: ["python tutorial"],
      resultsPerPage: 10,
      maxPagesPerQuery: 1,
    },
    verify_keys: [
      'id="search"',
      'id="rso"',
      'id="rcnt"',
      "<title>python tutorial - Google Search</title>",
      'itemtype="http://schema.org/SearchResultsPage"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 1.5,
  },
  "idealista.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.idealista.com/inmueble/110715434/",
    endpoint: "https://api.apify.com/v2/acts/dz_omar~idealista-scraper-api/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.idealista.com/venta-viviendas/madrid-madrid/" }],
      maxItems: 5,
    },
    verify_keys: [
      'class="main-info__title-main"',
      'class="info-data-price"',
      "inmueble/110715434",
      "<title>Ático en venta",
      "Calle de Isabel la Católica",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2,
  },
  "indeed.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
    endpoint: "https://api.apify.com/v2/acts/misceres~indeed-scraper/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY" }],
      maxItems: 10,
    },
    verify_keys: [
      "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
      'data-jk="',
      'class="job_seen_beacon',
      'data-testid="company-name"',
      'id="mosaic-provider-jobcards"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 13.25,
  },
  "instagram.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.instagram.com/nike/",
    endpoint: "https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items",
    params: {
      usernames: ["nike"],
    },
    verify_keys: [
      '"username":"nike"',
      "<title>Nike (&#064;nike)",
      "instagram://user?username=nike",
      'href="https://www.instagram.com/nike/"',
      'og:type" content="profile"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 2.6,
  },
  "linkedin.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.linkedin.com/company/microsoft/",
    endpoint: "https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items",
    params: {
      profileUrls: ["https://www.linkedin.com/company/microsoft/"],
    },
    verify_keys: [
      "<title>Microsoft | LinkedIn</title>",
      '"@type":"Organization"',
      "urn:li:organization",
      "/company/microsoft",
      "_org_guest_company_overview",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 4,
  },
  "reddit.com": {
    status: "operational",
    reason_code: null,
    url: "https://old.reddit.com/r/programming/",
    endpoint: "https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.reddit.com/r/programming/" }],
      maxItems: 1,
    },
    verify_keys: [
      'id="siteTable"',
      'data-fullname="t3_',
      'data-subreddit="programming"',
      'data-subreddit-prefixed="r/programming"',
      "<title>programming</title>",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 44,
  },
  "tripadvisor.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
    endpoint: "https://api.apify.com/v2/acts/maxcopell~tripadvisor/run-sync-get-dataset-items",
    params: {
      startUrls: [
        {
          url: "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        },
      ],
      maxItems: 1,
    },
    verify_keys: [
      "Fairmont",
      "THE PLAZA NEW YORK",
      '"@type":"LodgingBusiness"',
      '"aggregateRating"',
      "data-automation",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 7.205,
  },
  "trustpilot.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.trustpilot.com/review/amazon.com",
    endpoint: "https://api.apify.com/v2/acts/getwally.net~trustpilot-reviews-scraper/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.trustpilot.com/review/amazon.com" }],
      maxItems: 5,
    },
    verify_keys: [
      "data-service-review-card-paper",
      "data-service-review-rating",
      '"@type":"Organization"',
      '"@type":"AggregateRating"',
      "data-business-unit-json-ld",
    ],
    need_at_least: 2,
    cost_per_1k_usd: 0.475,
  },
  "walmart.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.walmart.com/ip/604342441",
    endpoint: "https://api.apify.com/v2/acts/e-commerce~walmart-product-detail-scraper/run-sync-get-dataset-items",
    params: {
      productUrls: ["https://www.walmart.com/ip/604342441"],
    },
    verify_keys: [
      "<title>Apple, AirPods with Charging Case",
      '"itemId":"604342441"',
      'data-testid="price-wrap"',
      'id="__NEXT_DATA__"',
      'data-testid="hero-image-container"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 3.06,
  },
  "x.com": {
    status: "operational",
    reason_code: null,
    url: "https://x.com/elonmusk",
    endpoint:
      "https://api.apify.com/v2/acts/kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest/run-sync-get-dataset-items",
    // QUIRK: this actor ignores maxItems=1 and returns ~20 tweets/query.
    params: {
      query: "from:elonmusk",
      maxItems: 1,
    },
    verify_keys: ["elonmusk", "Elon Musk", "44196397", "react-root", 'data-testid="tweet"'],
    need_at_least: 2,
    cost_per_1k_usd: 5,
  },
  "youtube.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.youtube.com/@MrBeast",
    endpoint: "https://api.apify.com/v2/acts/streamers~youtube-scraper/run-sync-get-dataset-items",
    params: {
      searchQueries: ["MrBeast"],
      maxResults: 1,
    },
    verify_keys: [
      '"channelMetadataRenderer"',
      '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
      "ytInitialData",
      '"title":"MrBeast"',
      '"subscriberCountText"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 4,
  },
  "zillow.com": {
    status: "operational",
    reason_code: null,
    url: "https://www.zillow.com/columbus-oh/",
    endpoint: "https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/run-sync-get-dataset-items",
    params: {
      startUrls: [{ url: "https://www.zillow.com/columbus-oh/" }],
      maxItems: 5,
    },
    verify_keys: [
      'data-testid="property-card"',
      '"zpid":',
      '"@type":"SingleFamilyResidence"',
      '"streetAddress"',
      '"bedrooms"',
    ],
    need_at_least: 2,
    cost_per_1k_usd: 3,
  },
};

// ---------------------------------------------------------------------------
// Request builder — Apify recipe: POST JSON to the actor's
// run-sync-get-dataset-items endpoint, auth via ?token=<KEY> querystring.
// ---------------------------------------------------------------------------
function buildRequestUrl(cfg: DomainCfg, token: string): string {
  const sep = cfg.endpoint.includes("?") ? "&" : "?";
  return `${cfg.endpoint}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Apify run-sync-get-dataset-items returns a JSON ARRAY of dataset items.
 * Per recipe: JSON.stringify the whole array and substring-match against it.
 * If the body is not valid JSON (e.g. an error string), fall back to raw text
 * so verify simply fails rather than throwing.
 */
function unwrapResponse(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    return JSON.stringify(parsed);
  } catch {
    return rawText;
  }
}

/**
 * Count substring hits among verify_keys; PASS when hits >= need_at_least.
 * IDENTICAL rule to the Python version.
 */
function verify(body: string, verifyKeys: string[], needAtLeast: number): { passed: boolean; hits: number } {
  let hits = 0;
  for (const key of verifyKeys) {
    if (body.includes(key)) hits += 1;
  }
  return { passed: hits >= needAtLeast, hits };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one actor invocation. Returns { passed, latencyMs }. */
async function runTrial(cfg: DomainCfg, token: string): Promise<{ passed: boolean; latencyMs: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(buildRequestUrl(cfg, token), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(cfg.params),
      signal: controller.signal,
    });
    const rawText = await resp.text();
    const latencyMs = Date.now() - start;
    const body = unwrapResponse(rawText);
    // Even on HTTP error status, we run verify on the payload (mirrors Python);
    // an error body will not contain the markers, so it simply fails.
    const { passed } = verify(body, cfg.verify_keys, cfg.need_at_least);
    return { passed, latencyMs };
  } catch {
    return { passed: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function parseTrials(argv: string[]): number {
  const i = argv.indexOf("--trials");
  if (i !== -1 && i + 1 < argv.length) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 3;
}

function resultsPath(): string {
  // ../../test-results/apify.run.json relative to this file's directory.
  const here = dirname(fileURLToPath(import.meta.url));
  return normalize(join(here, "..", "..", "test-results", `${PROVIDER}.run.json`));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const trials = parseTrials(process.argv.slice(2));

  // Auth check BEFORE any request. Never crash on missing token.
  const token = (process.env[AUTH_ENV] ?? "").trim();
  if (!token) {
    console.log(`Set ${AUTH_ENV} to run (see .env.example)`);
    process.exit(0);
  }

  console.log(`apify test — ${trials} trial(s) per operational domain`);
  console.log("-".repeat(72));

  const domainResults: Record<string, unknown> = {};
  const successRates: number[] = [];
  const latenciesAll: number[] = [];
  let reachable = 0;

  for (const [domain, cfg] of Object.entries(DOMAINS)) {
    if (cfg.status !== "operational") {
      // genuine_fail rows: DO NOT make requests (Apify has none, but the runner
      // honors the contract uniformly).
      console.log(`SKIP ${domain}: ${cfg.reason_code ?? "genuine_fail"} — not operational`);
      domainResults[domain] = {
        status: cfg.status,
        reason_code: cfg.reason_code,
        success_rate: 0.0,
        avg_latency_ms: 0,
      };
      continue;
    }

    let passes = 0;
    const latSamples: number[] = [];
    for (let t = 0; t < trials; t++) {
      const { passed, latencyMs } = await runTrial(cfg, token);
      if (passed) passes += 1;
      latSamples.push(latencyMs);
      // Pace between trials (run-sync actors are heavy; avoid hammering).
      if (t < trials - 1) await sleep(PACE_MS);
    }

    const sr = passes / trials;
    const avgLat = latSamples.length
      ? Math.round(latSamples.reduce((a, b) => a + b, 0) / latSamples.length)
      : 0;
    successRates.push(sr);
    latenciesAll.push(...latSamples);
    reachable += 1;

    domainResults[domain] = {
      status: "operational",
      success_rate: Math.round(sr * 1000) / 1000,
      avg_latency_ms: avgLat,
      pass: passes,
      trials,
      cost_per_1k_usd: cfg.cost_per_1k_usd,
      cost_source: "frozen",
    };

    const statusWord = sr >= 0.5 ? "PASS" : "FAIL";
    console.log(
      `${domain.padEnd(16)} ${statusWord.padEnd(11)} SR=${(sr * 100).toFixed(0).padStart(4)}%  ` +
        `avg=${String(avgLat).padStart(7)}ms  (${passes}/${trials})`,
    );

    // Pace between domains as well.
    await sleep(PACE_MS);
  }

  const total = Object.keys(DOMAINS).length;
  const operational = Object.values(DOMAINS).filter((c) => c.status === "operational").length;
  const reachabilityPct = operational ? Math.round((1000 * reachable) / operational) / 10 : 0.0;
  const avgSuccessRate = successRates.length
    ? Math.round((successRates.reduce((a, b) => a + b, 0) / successRates.length) * 1000) / 1000
    : 0.0;
  const avgLatencyMs = latenciesAll.length
    ? Math.round(latenciesAll.reduce((a, b) => a + b, 0) / latenciesAll.length)
    : 0;

  const summary = {
    domains_total: total,
    operational,
    genuine_fail: total - operational,
    reachability_pct: reachabilityPct,
    avg_success_rate: avgSuccessRate,
    avg_cost_per_1k_usd: FROZEN_AVG_COST_PER_1K_USD, // frozen; not measured live
    avg_latency_ms: avgLatencyMs,
    cost_source: "frozen",
  };

  const out = {
    provider: PROVIDER,
    report_date: todayIso(),
    frozen: false,
    endpoint: ENDPOINT,
    auth_env: AUTH_ENV,
    summary,
    domains: domainResults,
  };

  const path = resultsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");

  console.log("-".repeat(72));
  console.log(
    `reachability ${reachabilityPct}%  avg_success_rate ${avgSuccessRate.toFixed(3)}  avg_latency ${avgLatencyMs}ms`,
  );
  console.log(`wrote ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
