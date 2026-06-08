#!/usr/bin/env python3
"""
test_scrapingbee.py — self-contained reachability/extraction test for the ScrapingBee
web-scraping API, frozen against the 2026-06-08 benchmark numbers.

WHAT IT TESTS
  For each of the 20 target domains in the frozen 2026 slice it issues N trials
  (default 3) against ScrapingBee, unwraps the response, and verifies that the
  returned HTML contains at least `need_at_least` of the domain's `verify_keys`
  substrings. A domain PASSES a trial when hits >= need_at_least.

  One domain (g2.com) is a documented GENUINE FAIL (DataDome blacklists ScrapingBee
  IPs between bursts: pass-4 went 3/3 -> 0/30 at lock-in). We DO NOT spend credits
  on it — it is printed as a SKIP line with its reason_code.

HOW TO RUN
  export SCRAPINGBEE_TOKEN=your_api_key        # Windows: set SCRAPINGBEE_TOKEN=...
  python test_scrapingbee.py                   # 3 trials per operational domain
  python test_scrapingbee.py --trials 5        # custom trial count

  If SCRAPINGBEE_TOKEN is unset the script prints a hint and exits 0 (no crash).

WHAT IT WRITES
  ../../test-results/scrapingbee.run.json (relative to this file's location), in the
  same schema as the frozen file: {provider, report_date, frozen:false, endpoint,
  auth_env, summary, domains}. success_rate / avg_latency_ms are MEASURED this run;
  avg_cost_per_1k_usd is COPIED from the frozen slice (cost is not measured live).

REQUEST RECIPE (per slice request_recipe)
  transport : GET
  auth      : querystring api_key=<KEY>
  base      : https://app.scrapingbee.com/api/v1/
  params    : api_key, url=<targetUrl>, + tier params (render_js, premium_proxy,
              stealth_proxy, country_code). Response is raw HTML (no unwrapping).
  quirk     : spread calls over time — IPs blacklist under bursts. We pace between
              every request (see PACE_SECONDS).

Stdlib only. Python 3.8+.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

PROVIDER = "scrapingbee"
ENDPOINT = "https://app.scrapingbee.com/api/v1/"
AUTH_ENV = "SCRAPINGBEE_TOKEN"

# ScrapingBee blacklists IPs under bursts (see slice quirk). Pace every request so
# back-to-back trials against the same target don't get the IP locked out.
PACE_SECONDS = 2.0
TIMEOUT_SECONDS = 180  # idealista/g2 latencies run 90-110s; give generous headroom.

# avg_cost_per_1k_usd is copied from the frozen slice summary; cost is not measured live.
FROZEN_AVG_COST_PER_1K_USD = 2.66

# ---------------------------------------------------------------------------
# DOMAINS — literal values embedded from the frozen slice (do NOT read slice at runtime).
# Each entry: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), and reason_code for genuine_fail rows.
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
        "cost_per_1k_usd": 0.196,
    },
    "bestbuy.com": {
        "status": "operational",
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
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
        "cost_per_1k_usd": 0.196,
    },
    "booking.com": {
        "status": "operational",
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
    },
    "capterra.com": {
        "status": "operational",
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
    },
    "g2.com": {
        # GENUINE FAIL — DataDome blacklists IPs between bursts. We never request this.
        "status": "genuine_fail",
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true", "country_code": "us"}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
        "reason_code": "datadome_wall",
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
        "cost_per_1k_usd": 0.196,
    },
    "google.com": {
        # Dedicated Google plugin endpoint (store/google) at 25cr — endpoint_override applies.
        "status": "operational",
        "url": "https://www.google.com/search?q=python+tutorial",
        "tier": {"params": {}, "endpoint_override": "https://app.scrapingbee.com/api/v1/store/google"},
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
    },
    "idealista.com": {
        "status": "operational",
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {"params": {"stealth_proxy": "true"}, "endpoint_override": None},
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 14.7,
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
        "cost_per_1k_usd": 0.196,
    },
    "instagram.com": {
        "status": "operational",
        "url": "https://www.instagram.com/nike/",
        "tier": {"params": {"render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            '"username":"nike"',
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            'href="https://www.instagram.com/nike/"',
            'og:type" content="profile"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.98,
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
        "cost_per_1k_usd": 0.196,
    },
    "reddit.com": {
        "status": "operational",
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
        "cost_per_1k_usd": 0.196,
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
        "cost_per_1k_usd": 0.196,
    },
    "trustpilot.com": {
        "status": "operational",
        "url": "https://www.trustpilot.com/review/amazon.com",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.9,
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {"params": {"render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.98,
    },
    "x.com": {
        "status": "operational",
        "url": "https://x.com/elonmusk",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.196,
    },
    "youtube.com": {
        "status": "operational",
        "url": "https://www.youtube.com/@MrBeast",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.196,
    },
    "zillow.com": {
        "status": "operational",
        "url": "https://www.zillow.com/columbus-oh/",
        "tier": {"params": {"premium_proxy": "true", "render_js": "true"}, "endpoint_override": None},
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,  # frozen slice has null cost for zillow
    },
}

# Short human-readable notes for SKIP lines, keyed by reason_code.
REASON_NOTES = {
    "datadome_wall": "DataDome blacklists IPs between bursts (pass-4 3/3 -> 0/30 at lock-in)",
}


def build_request(domain_cfg, api_key):
    """Build a ScrapingBee GET request per the slice request_recipe.

    Auth is querystring api_key. The target URL goes in the `url` param, and tier
    params (render_js, premium_proxy, stealth_proxy, country_code) are appended.
    google.com uses the dedicated store/google plugin via endpoint_override.
    Returns a urllib.request.Request (GET).
    """
    tier = domain_cfg["tier"]
    base = tier["endpoint_override"] or ENDPOINT
    params = {"api_key": api_key, "url": domain_cfg["url"]}
    # Tier params are literal strings ("true") exactly as the API expects them.
    params.update(tier["params"])
    query = urllib.parse.urlencode(params)
    full_url = base + ("&" if "?" in base else "?") + query
    return urllib.request.Request(full_url, method="GET")


def unwrap(raw_bytes):
    """ScrapingBee returns raw HTML directly — no JSON envelope to unwrap.

    Decode as UTF-8 (lenient) and return the body string.
    """
    return raw_bytes.decode("utf-8", errors="replace")


def verify(body, verify_keys, need_at_least):
    """Count substring hits among verify_keys; PASS when hits >= need_at_least.

    IDENTICAL rule across the Python and TypeScript scripts.
    """
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run_trial(domain_cfg, api_key):
    """Execute one request. Returns (passed: bool, latency_ms: int, hits: int)."""
    req = build_request(domain_cfg, api_key)
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            raw = resp.read()
        latency_ms = int((time.time() - start) * 1000)
        body = unwrap(raw)
        passed, hits = verify(body, domain_cfg["verify_keys"], domain_cfg["need_at_least"])
        return passed, latency_ms, hits
    except Exception as exc:  # network error, HTTP error, timeout — counts as a failed trial
        latency_ms = int((time.time() - start) * 1000)
        sys.stderr.write("    ! request error: {}\n".format(exc))
        return False, latency_ms, 0


def main():
    parser = argparse.ArgumentParser(description="ScrapingBee per-domain test (frozen 2026 baseline).")
    parser.add_argument("--trials", type=int, default=3, help="trials per operational domain (default 3)")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # Auth check BEFORE any request — never crash on missing key.
    api_key = os.environ.get(AUTH_ENV)
    if not api_key:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        sys.exit(0)

    print("ScrapingBee test — {} trials/domain, pacing {}s between requests\n".format(trials, PACE_SECONDS))

    results = {}
    first_request = True
    for domain, cfg in DOMAINS.items():
        if cfg["status"] == "genuine_fail":
            reason = cfg.get("reason_code", "genuine_fail")
            note = REASON_NOTES.get(reason, "documented genuine fail")
            # Do NOT make requests for genuine_fail rows — print one SKIP line.
            print("SKIP {}: {} — {}".format(domain, reason, note))
            results[domain] = {
                "status": "genuine_fail",
                "success_rate": 0.0,
                "avg_latency_ms": 0,
                "reason_code": reason,
            }
            continue

        passes = 0
        latencies = []
        for t in range(trials):
            # Pace every request after the first to avoid IP blacklisting under bursts.
            if not first_request:
                time.sleep(PACE_SECONDS)
            first_request = False
            passed, latency_ms, hits = run_trial(cfg, api_key)
            latencies.append(latency_ms)
            if passed:
                passes += 1
            print("  {:<16} trial {}/{}: {} ({} hits, {} ms)".format(
                domain, t + 1, trials, "PASS" if passed else "FAIL", hits, latency_ms))

        success_rate = passes / trials
        avg_latency = int(sum(latencies) / len(latencies)) if latencies else 0
        results[domain] = {
            "status": "operational",
            "success_rate": success_rate,
            "avg_latency_ms": avg_latency,
            "passes": passes,
            "trials": trials,
        }

    write_results(results)
    print_table(results)


def write_results(results):
    """Write ../../test-results/scrapingbee.run.json in the frozen-file schema."""
    op_rows = [r for r in results.values() if r["status"] == "operational"]
    total = len(results)
    reachable = len(op_rows)  # operational domains are the reachable ones
    reachability_pct = round(100.0 * reachable / total) if total else 0
    avg_success_rate = round(sum(r["success_rate"] for r in op_rows) / len(op_rows), 4) if op_rows else 0.0
    # Average latency over operational rows that actually issued requests.
    avg_latency_ms = int(sum(r["avg_latency_ms"] for r in op_rows) / len(op_rows)) if op_rows else 0

    payload = {
        "provider": PROVIDER,
        "report_date": "2026-06-08",  # today
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": {
            "domains_total": total,
            "operational": reachable,
            "genuine_fail": total - reachable,
            "reachability_pct": reachability_pct,
            "avg_success_rate": avg_success_rate,
            "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,
            "cost_source": "frozen",
            "avg_latency_ms": avg_latency_ms,
        },
        "domains": results,
    }

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(here, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "{}.run.json".format(PROVIDER))
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    print("\nWrote {}".format(out_path))


def print_table(results):
    """Clean per-domain table: domain, status, SR, avg ms."""
    print("\n{:<18} {:<14} {:>7} {:>10}".format("DOMAIN", "STATUS", "SR", "AVG_MS"))
    print("-" * 52)
    for domain, r in results.items():
        sr = "{:.0%}".format(r["success_rate"])
        print("{:<18} {:<14} {:>7} {:>10}".format(domain, r["status"], sr, r["avg_latency_ms"]))


if __name__ == "__main__":
    main()
