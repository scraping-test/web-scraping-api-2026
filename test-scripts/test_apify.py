#!/usr/bin/env python3
"""Self-contained PASS/FAIL test for the Apify scraping provider.

WHAT IT TESTS
  Runs Apify's per-domain "best-of-breed" actors against 20 frozen target
  domains and verifies the returned dataset contains expected content markers.
  Each domain uses a *different* marketplace actor (see DOMAINS[*]["endpoint"]).

HOW IT WORKS (Apify request recipe)
  - Transport: POST.
  - Auth: querystring ?token=<APIFY_TOKEN>  (NOT a header).
  - For each domain we POST to that domain's actor "run-sync-get-dataset-items"
    endpoint. The JSON body is the per-domain params object VERBATIM
    (startUrls / categoryOrProductUrls / queries / usernames / ...).
  - The response is a JSON ARRAY of dataset items. We json.dumps() the whole
    array and substring-match the verify_keys against that serialized text.
  - run-sync actors cold-start slowly; per-trial timeout is 90s.

HOW TO RUN
  export APIFY_TOKEN=apify_api_xxx          # Windows: set APIFY_TOKEN=...
  python test_apify.py                      # 3 trials per domain (default)
  python test_apify.py --trials 5           # custom trial count

  If APIFY_TOKEN is unset the script prints a hint and exits 0 (no crash).

WHAT IT WRITES
  ../../test-results/apify.run.json  (relative to this file's location)
  Same schema as the frozen apify.json: {provider, report_date, frozen:false,
  endpoint, auth_env, summary, domains}. success_rate / avg_latency_ms are
  MEASURED this run; cost is copied from the frozen slice (cost_source=frozen).

QUIRKS (from the slice; affect interpretation, not the request)
  - Marketplace pricing varies wildly ($0.000475/result .. $0.044/run).
  - Some actors are PAY_PER_EVENT (reddit ~$0.044/run min).
  - Some actors IGNORE maxItems (x.com returns ~20 tweets despite maxItems=1).
  All 20 domains are operational; there are no genuine_fail rows for Apify.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROVIDER = "apify"
ENDPOINT = "https://api.apify.com/v2"
AUTH_ENV = "APIFY_TOKEN"
FROZEN_REPORT_DATE = "2026-06-08"

# Frozen summary cost figure (not measured live).
FROZEN_AVG_COST_PER_1K_USD = 7.04

# Per-trial timeout: Apify run-sync actors cold-start slowly (slice note: 90s).
REQUEST_TIMEOUT_S = 90

# Pacing between requests. Apify has no tight rate-limit quirk in the recipe,
# but actor runs are heavy/serial; a small gap avoids hammering run-sync.
PACE_SECONDS = 1.0

# ---------------------------------------------------------------------------
# DOMAINS table — embedded literally from the frozen slice. Each entry carries:
#   url, tier{params, endpoint_override}, verify_keys, need_at_least, status,
#   reason_code (None — Apify has no genuine_fail rows), and the frozen
#   cost_per_1k_usd used for the written cost figure.
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "endpoint": "https://api.apify.com/v2/acts/junglee~Amazon-crawler/run-sync-get-dataset-items",
        "params": {
            "categoryOrProductUrls": [{"url": "https://www.amazon.com/dp/B07FZ8S74R"}],
            "maxItemsPerStartUrl": 1,
            "useCaptchaSolver": False,
        },
        "verify_keys": [
            "productTitle",
            'id="dp-container"',
            'id="centerCol"',
            'data-asin="B07FZ8S74R"',
            "nav-logo-base",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5,
    },
    "bestbuy.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "endpoint": "https://api.apify.com/v2/acts/piotrv1001~bestbuy-listings-scraper/run-sync-get-dataset-items",
        "params": {
            "searchUrls": [{"url": "https://www.bestbuy.com/site/searchpage.jsp?st=iphone"}],
            "maxItems": 10,
        },
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 10.15,
    },
    "bing.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "endpoint": "https://api.apify.com/v2/acts/ivanvs~bing-scraper/run-sync-get-dataset-items",
        "params": {
            "queries": ["best laptops 2025"],
            "resultsPerPage": 10,
        },
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            'id="b_content"',
            'id="sb_form"',
            'class="b_algo',
            'class="b_attribution',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 6.1,
    },
    "booking.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "endpoint": "https://api.apify.com/v2/acts/voyager~booking-scraper/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.booking.com/hotel/us/the-plaza.html"}],
            "maxItems": 1,
        },
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 1.075,
    },
    "capterra.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.capterra.com/p/135003/Slack/",
        "endpoint": "https://api.apify.com/v2/acts/crawlerbros~capterra-scraper/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.capterra.com/p/135003/Slack/"}],
            "maxItems": 1,
        },
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 6.055,
    },
    "ebay.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.ebay.com/itm/116619563010",
        "endpoint": "https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items",
        "params": {
            "keywords": ["macbook pro"],
            "count": 1,
        },
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.1,
    },
    "g2.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.g2.com/products/slack/reviews",
        "endpoint": "https://api.apify.com/v2/acts/automation-lab~g2-scraper/run-sync-get-dataset-items",
        "params": {
            "productSlugs": ["slack", "jira-software"],
        },
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 13.75,
    },
    "github.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://github.com/microsoft/vscode",
        "endpoint": "https://api.apify.com/v2/acts/crawlerbros~github-repo-intelligence/run-sync-get-dataset-items",
        "params": {
            "repoUrls": ["https://github.com/microsoft/vscode"],
        },
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            'data-testid="latest-commit-details"',
            'data-testid="view-all-files-row"',
            'id="repository-container-header"',
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.555,
    },
    "google.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.google.com/search?q=python+tutorial",
        "endpoint": "https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items",
        "params": {
            "queries": ["python tutorial"],
            "resultsPerPage": 10,
            "maxPagesPerQuery": 1,
        },
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 1.5,
    },
    "idealista.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.idealista.com/inmueble/110715434/",
        "endpoint": "https://api.apify.com/v2/acts/dz_omar~idealista-scraper-api/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.idealista.com/venta-viviendas/madrid-madrid/"}],
            "maxItems": 5,
        },
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "indeed.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "endpoint": "https://api.apify.com/v2/acts/misceres~indeed-scraper/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY"}],
            "maxItems": 10,
        },
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 13.25,
    },
    "instagram.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.instagram.com/nike/",
        "endpoint": "https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items",
        "params": {
            "usernames": ["nike"],
        },
        "verify_keys": [
            '"username":"nike"',
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            'href="https://www.instagram.com/nike/"',
            'og:type" content="profile"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 2.6,
    },
    "linkedin.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.linkedin.com/company/microsoft/",
        "endpoint": "https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items",
        "params": {
            "profileUrls": ["https://www.linkedin.com/company/microsoft/"],
        },
        "verify_keys": [
            "<title>Microsoft | LinkedIn</title>",
            '"@type":"Organization"',
            "urn:li:organization",
            "/company/microsoft",
            "_org_guest_company_overview",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4,
    },
    "reddit.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://old.reddit.com/r/programming/",
        "endpoint": "https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.reddit.com/r/programming/"}],
            "maxItems": 1,
        },
        "verify_keys": [
            'id="siteTable"',
            'data-fullname="t3_',
            'data-subreddit="programming"',
            'data-subreddit-prefixed="r/programming"',
            "<title>programming</title>",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 44,
    },
    "tripadvisor.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "endpoint": "https://api.apify.com/v2/acts/maxcopell~tripadvisor/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html"}],
            "maxItems": 1,
        },
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            '"@type":"LodgingBusiness"',
            '"aggregateRating"',
            "data-automation",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 7.205,
    },
    "trustpilot.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.trustpilot.com/review/amazon.com",
        "endpoint": "https://api.apify.com/v2/acts/getwally.net~trustpilot-reviews-scraper/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.trustpilot.com/review/amazon.com"}],
            "maxItems": 5,
        },
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.475,
    },
    "walmart.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.walmart.com/ip/604342441",
        "endpoint": "https://api.apify.com/v2/acts/e-commerce~walmart-product-detail-scraper/run-sync-get-dataset-items",
        "params": {
            "productUrls": ["https://www.walmart.com/ip/604342441"],
        },
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.06,
    },
    "x.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://x.com/elonmusk",
        "endpoint": "https://api.apify.com/v2/acts/kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest/run-sync-get-dataset-items",
        # QUIRK: this actor ignores maxItems=1 and returns ~20 tweets/query.
        "params": {
            "query": "from:elonmusk",
            "maxItems": 1,
        },
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5,
    },
    "youtube.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.youtube.com/@MrBeast",
        "endpoint": "https://api.apify.com/v2/acts/streamers~youtube-scraper/run-sync-get-dataset-items",
        "params": {
            "searchQueries": ["MrBeast"],
            "maxResults": 1,
        },
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4,
    },
    "zillow.com": {
        "status": "operational",
        "reason_code": None,
        "url": "https://www.zillow.com/columbus-oh/",
        "endpoint": "https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/run-sync-get-dataset-items",
        "params": {
            "startUrls": [{"url": "https://www.zillow.com/columbus-oh/"}],
            "maxItems": 5,
        },
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 3,
    },
}


# ---------------------------------------------------------------------------
# Request builder — Apify recipe: POST JSON to the actor's
# run-sync-get-dataset-items endpoint, auth via ?token=<KEY> querystring.
# ---------------------------------------------------------------------------
def build_request(domain_cfg, token):
    """Return a urllib Request for one Apify actor run."""
    sep = "&" if "?" in domain_cfg["endpoint"] else "?"
    url = "{}{}token={}".format(domain_cfg["endpoint"], sep, urllib.parse.quote(token, safe=""))
    body = json.dumps(domain_cfg["params"]).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    return req


def unwrap_response(raw_bytes):
    """Apify run-sync-get-dataset-items returns a JSON ARRAY of dataset items.

    Per recipe: json.dumps the whole array and substring-match against it.
    If the body is not a JSON array (e.g. an error object), fall back to the
    decoded text so verify simply fails rather than crashing.
    """
    text = raw_bytes.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text
    # Stringify the array (or whatever JSON came back) for marker matching.
    return json.dumps(parsed, ensure_ascii=False)


def verify(body, verify_keys, need_at_least):
    """Count substring hits among verify_keys; PASS when hits >= need_at_least.

    IDENTICAL rule to the TypeScript version.
    """
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run_trial(domain_cfg, token):
    """Run one actor invocation. Returns (passed: bool, latency_ms: int)."""
    start = time.time()
    try:
        req = build_request(domain_cfg, token)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            raw = resp.read()
        latency_ms = int((time.time() - start) * 1000)
        body = unwrap_response(raw)
        passed, _ = verify(body, domain_cfg["verify_keys"], domain_cfg["need_at_least"])
        return passed, latency_ms
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - start) * 1000)
        # Read the error body so a verify_key could theoretically match, but an
        # HTTP error almost always means a failed run -> verify on the payload.
        try:
            body = unwrap_response(e.read())
        except Exception:
            body = ""
        passed, _ = verify(body, domain_cfg["verify_keys"], domain_cfg["need_at_least"])
        return passed, latency_ms
    except Exception:
        latency_ms = int((time.time() - start) * 1000)
        return False, latency_ms


def results_path():
    """../../test-results/apify.run.json relative to this script's directory."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "test-results", PROVIDER + ".run.json"))


def main():
    parser = argparse.ArgumentParser(description="Apify per-domain PASS/FAIL test.")
    parser.add_argument("--trials", type=int, default=3, help="Trials per operational domain (default 3).")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # Auth check BEFORE any request. Never crash on missing token.
    token = os.environ.get(AUTH_ENV, "").strip()
    if not token:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        sys.exit(0)

    today = time.strftime("%Y-%m-%d")
    print("apify test — {} trial(s) per operational domain".format(trials))
    print("-" * 72)

    domain_results = {}
    success_rates = []
    latencies_all = []
    reachable = 0

    for domain, cfg in DOMAINS.items():
        if cfg["status"] != "operational":
            # genuine_fail rows: DO NOT make requests (Apify has none, but the
            # runner honors the contract uniformly).
            print("SKIP {}: {} — not operational".format(domain, cfg.get("reason_code") or "genuine_fail"))
            domain_results[domain] = {
                "status": cfg["status"],
                "reason_code": cfg.get("reason_code"),
                "success_rate": 0.0,
                "avg_latency_ms": 0,
            }
            continue

        passes = 0
        lat_samples = []
        for t in range(trials):
            passed, latency_ms = run_trial(cfg, token)
            if passed:
                passes += 1
            lat_samples.append(latency_ms)
            # Pace between trials (run-sync actors are heavy; avoid hammering).
            if t < trials - 1:
                time.sleep(PACE_SECONDS)

        sr = passes / trials
        avg_lat = int(sum(lat_samples) / len(lat_samples)) if lat_samples else 0
        success_rates.append(sr)
        latencies_all.extend(lat_samples)
        reachable += 1

        domain_results[domain] = {
            "status": "operational",
            "success_rate": round(sr, 3),
            "avg_latency_ms": avg_lat,
            "pass": passes,
            "trials": trials,
            "cost_per_1k_usd": cfg["cost_per_1k_usd"],
            "cost_source": "frozen",
        }

        status_word = "PASS" if sr >= 0.5 else "FAIL"
        print("{:<16} {:<11} SR={:>5.0%}  avg={:>7d}ms  ({}/{})".format(
            domain, status_word, sr, avg_lat, passes, trials))

        # Pace between domains as well.
        time.sleep(PACE_SECONDS)

    total = len(DOMAINS)
    operational = sum(1 for c in DOMAINS.values() if c["status"] == "operational")
    reachability_pct = round(100.0 * reachable / operational, 1) if operational else 0.0
    avg_success_rate = round(sum(success_rates) / len(success_rates), 3) if success_rates else 0.0
    avg_latency_ms = int(sum(latencies_all) / len(latencies_all)) if latencies_all else 0

    summary = {
        "domains_total": total,
        "operational": operational,
        "genuine_fail": total - operational,
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # frozen; not measured live
        "avg_latency_ms": avg_latency_ms,
        "cost_source": "frozen",
    }

    out = {
        "provider": PROVIDER,
        "report_date": today,
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": domain_results,
    }

    path = results_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print("-" * 72)
    print("reachability {}%  avg_success_rate {:.3f}  avg_latency {}ms".format(
        reachability_pct, avg_success_rate, avg_latency_ms))
    print("wrote {}".format(path))


if __name__ == "__main__":
    main()
