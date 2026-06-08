#!/usr/bin/env python3
"""
test_scrape_do.py — Self-contained live test for the "scrape-do" web-scraping API.

WHAT IT TESTS
  Fetches 20 frozen benchmark target URLs (amazon, bestbuy, google, zillow, ...)
  through Scrape.do and verifies the returned HTML/JSON contains the expected
  per-domain marker substrings. Produces a per-domain PASS/FAIL table and a
  results JSON you can diff against the frozen 2026 numbers.

HOW TO RUN
  1. Get a Scrape.do API token (https://scrape.do) and export it:
         export SCRAPE_DO_TOKEN=your_token_here     # Windows: set SCRAPE_DO_TOKEN=...
  2. Run with stdlib-only Python 3.8+:
         python test_scrape_do.py                    # 3 trials per domain (default)
         python test_scrape_do.py --trials 5         # custom trial count

WHAT IT WRITES
  ../../test-results/scrape-do.run.json  (relative to this script's location:
  test-scripts/scrape-do/ -> ../../test-results/). Same schema as the frozen file:
  {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}.

REQUEST RECIPE (scrape-do)
  GET https://api.scrape.do?token=<KEY>&url=<targetUrl>[&<tier params>]
  - Auth is a querystring param "token" (NOT a header).
  - When a domain has an endpoint_override (google/youtube plugins), that override
    is the base URL; token+url are still passed as query params.
  - Per-domain tier params (super, render, geoCode, customWait) are merged in.
  - Response body IS the target's content directly (HTML, or structured JSON for
    plugin endpoints) — no envelope to unwrap.

PROVIDER QUIRKS (from slice)
  - Credit-based pricing; tiers: basic(1cr), render(5cr), super(10cr), super+render(25cr).
  - render=true can 502 on amazon -> use super=true instead (we follow the frozen tier).
  - super=true auto-rotates residential + handles anti-bot for tough tier-2 domains.
  - Cost is reported via the "scrape.do-request-cost" response header (not measured here;
    cost numbers are copied from the frozen slice).
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

PROVIDER = "scrape-do"
ENDPOINT = "https://api.scrape.do"
AUTH_ENV = "SCRAPE_DO_TOKEN"

# Frozen per-1k cost numbers (copied from the slice; cost is NOT measured live).
AVG_COST_PER_1K_USD = 0.23

# ---------------------------------------------------------------------------
# DOMAINS table — literal values embedded from the slice (NOT read at runtime).
# Each entry: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd, reason_code (None for operational rows).
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "productTitle",
            'id="dp-container"',
            'id="centerCol"',
            'data-asin="B07FZ8S74R"',
            "nav-logo-base",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "bestbuy.com": {
        "status": "operational",
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        # tier=super (10cr); T1 basic fails (anti-bot).
        "tier": {"params": {"super": "true"}, "endpoint_override": None},
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 1.1,
        "reason_code": None,
    },
    "bing.com": {
        "status": "operational",
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            'id="b_content"',
            'id="sb_form"',
            'class="b_algo',
            'class="b_attribution',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "booking.com": {
        "status": "operational",
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "capterra.com": {
        "status": "operational",
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "g2.com": {
        "status": "operational",
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "github.com": {
        "status": "operational",
        "url": "https://github.com/microsoft/vscode",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            'data-testid="latest-commit-details"',
            'data-testid="view-all-files-row"',
            'id="repository-container-header"',
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "google.com": {
        "status": "operational",
        "url": "https://www.google.com/search?q=python+tutorial",
        # tier=basic (1cr); /plugin/google/search returns structured JSON at same cost.
        "tier": {
            "params": {},
            "endpoint_override": "https://api.scrape.do/plugin/google/search",
        },
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "idealista.com": {
        "status": "operational",
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "indeed.com": {
        "status": "operational",
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "instagram.com": {
        "status": "operational",
        "url": "https://www.instagram.com/nike/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            '"username":"nike"',
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            'href="https://www.instagram.com/nike/"',
            'og:type" content="profile"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "linkedin.com": {
        "status": "operational",
        "url": "https://www.linkedin.com/company/microsoft/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Microsoft | LinkedIn</title>",
            '"@type":"Organization"',
            "urn:li:organization",
            "/company/microsoft",
            "_org_guest_company_overview",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "reddit.com": {
        "status": "operational",
        # old.reddit.com URL (server-rendered, easier to parse).
        "url": "https://old.reddit.com/r/programming/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            'id="siteTable"',
            'data-fullname="t3_',
            'data-subreddit="programming"',
            'data-subreddit-prefixed="r/programming"',
            "<title>programming</title>",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "tripadvisor.com": {
        "status": "operational",
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            '"@type":"LodgingBusiness"',
            '"aggregateRating"',
            "data-automation",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "trustpilot.com": {
        "status": "operational",
        "url": "https://www.trustpilot.com/review/amazon.com",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "x.com": {
        "status": "operational",
        "url": "https://x.com/elonmusk",
        # tier=render+customWait=5000 (5cr) — JS-heavy SPA needs a render wait.
        "tier": {
            "params": {"render": "true", "customWait": "5000"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.55,
        "reason_code": None,
    },
    "youtube.com": {
        "status": "operational",
        "url": "https://www.youtube.com/@MrBeast",
        # tier=basic (1cr); /plugin/google/youtube structured JSON.
        "tier": {
            "params": {},
            "endpoint_override": "https://api.scrape.do/plugin/google/youtube",
        },
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.11,
        "reason_code": None,
    },
    "zillow.com": {
        "status": "operational",
        "url": "https://www.zillow.com/columbus-oh/",
        # tier=super+geo (10cr).
        "tier": {
            "params": {"super": "true", "geoCode": "us"},
            "endpoint_override": None,
        },
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 1.1,
        "reason_code": None,
    },
}

# Trials per operational domain (default; overridable with --trials).
DEFAULT_TRIALS = 3
# Pace between requests (seconds). Scrape.do has plan-tier concurrency limits;
# a small inter-request delay avoids tripping rate limits on the Hobby plan.
PACE_SECONDS = 1.0
# HTTP timeout per request (seconds). render+super tiers can be slow (x.com ~10s).
REQUEST_TIMEOUT = 90


def build_request(target_url, tier, token, cache_bust_counter=None):
    """
    Build the scrape-do GET request URL following the recipe EXACTLY.

    - Base is ENDPOINT, unless tier.endpoint_override is set (plugin), in which
      case the override is the base. token+url are passed in BOTH cases.
    - tier.params (super/render/geoCode/customWait) are merged into the query.
    - Auth mechanism: querystring param "token" (NOT a header).
    """
    base = tier.get("endpoint_override") or ENDPOINT
    params = {"token": token, "url": target_url}
    params.update(tier.get("params") or {})
    # Scrape.do does not require cache-busting per the recipe; the counter is
    # accepted for signature parity with cache-busting providers but unused here.
    query = urllib.parse.urlencode(params)
    return base + "?" + query


def fetch(target_url, tier, token, cache_bust_counter=None):
    """
    Perform the request. Returns (ok, body_text, latency_ms).
    Never raises — network/HTTP errors are caught and reported as a failed trial.
    """
    full_url = build_request(target_url, tier, token, cache_bust_counter)
    req = urllib.request.Request(full_url, headers={"Accept": "*/*"})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
            latency_ms = int((time.monotonic() - start) * 1000)
            # scrape-do returns the target content directly (HTML or plugin JSON);
            # there is no JSON envelope to unwrap.
            body = raw.decode("utf-8", errors="replace")
            return True, body, latency_ms
    except urllib.error.HTTPError as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        # Read the error body so verify() still has something to inspect (the
        # target HTML may still be present on some 4xx/5xx passthroughs).
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return False, body, latency_ms
    except Exception as e:  # URLError, timeout, etc.
        latency_ms = int((time.monotonic() - start) * 1000)
        return False, "scrape-do request error: %s" % e, latency_ms


def verify(body, verify_keys, need_at_least):
    """
    Count how many verify_keys appear as substrings in body.
    PASS when hits >= need_at_least. IDENTICAL rule in the TS version.
    """
    if not body:
        return False, 0
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run():
    parser = argparse.ArgumentParser(
        description="Live test scrape-do against frozen benchmark domains."
    )
    parser.add_argument(
        "--trials",
        type=int,
        default=DEFAULT_TRIALS,
        help="Number of trials per operational domain (default %d)." % DEFAULT_TRIALS,
    )
    args = parser.parse_args()
    trials = max(1, args.trials)

    # --- Auth gate (BEFORE any request). Never crash if the token is missing. ---
    token = os.environ.get(AUTH_ENV)
    if not token:
        print("Set %s to run (see .env.example)" % AUTH_ENV)
        sys.exit(0)

    today = time.strftime("%Y-%m-%d")
    print("scrape-do live test — %d trial(s) per operational domain\n" % trials)

    results = {}
    cache_bust_counter = 0

    for domain in sorted(DOMAINS.keys()):
        spec = DOMAINS[domain]

        # genuine_fail rows: DO NOT make requests — print one SKIP line.
        if spec["status"] != "operational":
            reason = spec.get("reason_code") or "genuine_fail"
            print("SKIP %s: %s — not operational in frozen run; no request made"
                  % (domain, reason))
            results[domain] = {
                "status": spec["status"],
                "success_rate": 0.0,
                "avg_latency_ms": 0,
                "reason_code": reason,
            }
            continue

        passes = 0
        latencies = []
        for _ in range(trials):
            cache_bust_counter += 1
            ok_http, body, latency_ms = fetch(
                spec["url"], spec["tier"], token, cache_bust_counter
            )
            latencies.append(latency_ms)
            passed, _hits = verify(body, spec["verify_keys"], spec["need_at_least"])
            if passed:
                passes += 1
            # Pace per the provider's concurrency limit quirk.
            time.sleep(PACE_SECONDS)

        success_rate = round(passes / trials, 4)
        avg_latency = int(sum(latencies) / len(latencies)) if latencies else 0
        results[domain] = {
            "status": "operational",
            "success_rate": success_rate,
            "avg_latency_ms": avg_latency,
            "pass_count": passes,
            "trials": trials,
        }

        verdict = "PASS" if passes >= 1 else "FAIL"
        print("  %-16s %-4s %d/%d  %dms"
              % (domain, verdict, passes, trials, avg_latency))

    # --- Summary (same computation rules as the frozen file) ---
    operational = [d for d, v in results.items()
                   if DOMAINS[d]["status"] == "operational"]
    op_results = [results[d] for d in operational]
    reachability_pct = round(
        100.0 * len(operational) / len(DOMAINS), 2
    ) if DOMAINS else 0.0
    avg_success_rate = round(
        sum(r["success_rate"] for r in op_results) / len(op_results), 4
    ) if op_results else 0.0
    avg_latency_ms = int(
        sum(r["avg_latency_ms"] for r in op_results) / len(op_results)
    ) if op_results else 0

    summary = {
        "domains_total": len(DOMAINS),
        "operational": len(operational),
        "genuine_fail": len(DOMAINS) - len(operational),
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        # Cost is NOT measured live — copied from the frozen slice.
        "avg_cost_per_1k_usd": AVG_COST_PER_1K_USD,
        "cost_source": "frozen",
        "avg_latency_ms": avg_latency_ms,
    }

    # --- Build output domains in frozen schema ---
    out_domains = {}
    for domain, spec in DOMAINS.items():
        r = results[domain]
        entry = {
            "status": r["status"],
            "success_rate": r["success_rate"],
            "avg_latency_ms": r["avg_latency_ms"],
            "cost_per_1k_usd": spec["cost_per_1k_usd"],
            "cost_source": "frozen",
        }
        if spec["status"] == "operational":
            entry["pass_count"] = r.get("pass_count", 0)
            entry["trials"] = r.get("trials", trials)
        else:
            entry["reason_code"] = r.get("reason_code")
        out_domains[domain] = entry

    output = {
        "provider": PROVIDER,
        "report_date": today,
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": out_domains,
    }

    # --- Write results relative to THIS script's location ---
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(script_dir, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "%s.run.json" % PROVIDER)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print("\nsummary: reachability=%.2f%%  avg_success_rate=%.4f  avg_latency=%dms"
          % (reachability_pct, avg_success_rate, avg_latency_ms))
    print("wrote %s" % out_path)


if __name__ == "__main__":
    run()
