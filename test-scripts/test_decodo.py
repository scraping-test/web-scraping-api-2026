#!/usr/bin/env python3
"""
test_decodo.py — self-contained PASS/FAIL probe for the Decodo Scraper API.

WHAT THIS TESTS
  Fires the Decodo Web Scraping API (v2 /scrape endpoint) at 20 real-world target
  URLs (amazon, google, zillow, g2, ...). For each domain it counts how many of a
  small set of "verify_keys" (substrings known to appear in a good response) are
  present in the returned HTML. A domain PASSES a trial when at least `need_at_least`
  keys are found. We run N trials per domain and report a per-domain success rate.

  The frozen 2026 reference numbers live in ../../test-results/decodo.json. This
  script writes a parallel ../../test-results/decodo.run.json in the SAME schema so
  you can diff your live run against the frozen baseline.

HOW TO RUN
  1. export DECODO_TOKEN="<your token>"
       The Decodo dashboard gives you a token that is ALREADY base64(user:pass).
       Use it verbatim — this script does NOT re-encode it.
  2. python test_decodo.py                # 3 trials per domain (default)
     python test_decodo.py --trials 5     # custom trial count

  Stdlib only (urllib, json, os, sys, base64, argparse, time). Python 3.8+.
  No third-party packages, no shared imports across providers.

WHAT IT WRITES
  ../../test-results/decodo.run.json  (relative to this file's location)
  Schema: {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}.
  Each domain row carries the status, measured success_rate, avg_latency_ms, and (for
  operational rows) the PASS count. Cost is copied from the frozen slice (not measured
  live) and tagged "cost_source":"frozen".

PROVIDER QUIRKS (baked into this script)
  * Transport is POST JSON to https://scraper-api.decodo.com/v2/scrape.
  * Auth header: "Authorization: Basic <DECODO_TOKEN>" — token used verbatim.
  * Tier params (headless=html for JS render, country=xx for geo) go INTO the JSON
    body alongside {"url": ...}.
  * The response is a wrapped envelope: the HTML is at results[0].content and the
    INNER per-target HTTP status is at results[0].status_code. Both the outer HTTP
    200 AND a sane inner status/content matter — we verify against results[0].content.
  * Concurrent load melts the g2 DataDome shield (~60% yield) while single requests
    are fine, so the runner is strictly SEQUENTIAL with a short pace between calls.
"""

import argparse
import base64  # noqa: F401  (imported per spec; Decodo token is pre-encoded so we don't call it)
import json
import os
import sys
import time
import urllib.error
import urllib.request

PROVIDER = "decodo"
ENDPOINT = "https://scraper-api.decodo.com/v2/scrape"
AUTH_ENV = "DECODO_TOKEN"
REPORT_DATE = "2026-06-08"  # today; frozen baseline shares this date

# Frozen summary cost — cost is NOT measured live, copied from the slice verbatim.
FROZEN_AVG_COST_PER_1K_USD = 0.68

# Pace between sequential requests. Decodo's DataDome-shielded targets (g2) collapse
# under concurrency, so we never parallelize and add a small gap between calls.
PACE_SECONDS = 1.0
REQUEST_TIMEOUT = 90  # zillow/g2 headless renders run 36-47s; allow generous headroom.

# ---------------------------------------------------------------------------
# DOMAINS — embedded literal values from the frozen slice (do NOT read it at runtime).
# Each row: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), reason_code (None — no genuine_fail rows here).
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "productTitle",
            'id="dp-container"',
            'id="centerCol"',
            'data-asin="B07FZ8S74R"',
            "nav-logo-base",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "bestbuy.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "bing.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            'id="b_content"',
            'id="sb_form"',
            'class="b_algo',
            'class="b_attribution',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "booking.com": {
        "status": "operational",
        "tier": {"params": {"headless": "html"}, "endpoint_override": None},
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "cost_per_1k_usd": 1,
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "capterra.com": {
        "status": "operational",
        "tier": {"params": {"country": "gb"}, "endpoint_override": None},
        "url": "https://www.capterra.com/p/135003/Slack/",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "ebay.com": {
        "status": "operational",
        "tier": {"params": {"headless": "html"}, "endpoint_override": None},
        "url": "https://www.ebay.com/itm/116619563010",
        "cost_per_1k_usd": 1,
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "g2.com": {
        "status": "operational",
        "tier": {"params": {"headless": "html"}, "endpoint_override": None},
        "url": "https://www.g2.com/products/slack/reviews",
        "cost_per_1k_usd": 1,
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "github.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://github.com/microsoft/vscode",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            'data-testid="latest-commit-details"',
            'data-testid="view-all-files-row"',
            'id="repository-container-header"',
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "google.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.google.com/search?q=python+tutorial",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "idealista.com": {
        "status": "operational",
        "tier": {"params": {"country": "es"}, "endpoint_override": None},
        "url": "https://www.idealista.com/inmueble/110715434/",
        "cost_per_1k_usd": None,  # null in frozen slice
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "indeed.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "instagram.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.instagram.com/nike/",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            '"username":"nike"',
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            'href="https://www.instagram.com/nike/"',
            'og:type" content="profile"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "linkedin.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.linkedin.com/company/microsoft/",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            "<title>Microsoft | LinkedIn</title>",
            '"@type":"Organization"',
            "urn:li:organization",
            "/company/microsoft",
            "_org_guest_company_overview",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "reddit.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://old.reddit.com/r/programming/",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            'id="siteTable"',
            'data-fullname="t3_',
            'data-subreddit="programming"',
            'data-subreddit-prefixed="r/programming"',
            "<title>programming</title>",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "tripadvisor.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "cost_per_1k_usd": None,  # null in frozen slice
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            '"@type":"LodgingBusiness"',
            '"aggregateRating"',
            "data-automation",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "trustpilot.com": {
        "status": "operational",
        "tier": {"params": {"headless": "html"}, "endpoint_override": None},
        "url": "https://www.trustpilot.com/review/amazon.com",
        "cost_per_1k_usd": 1,
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "walmart.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.walmart.com/ip/604342441",
        "cost_per_1k_usd": None,  # null in frozen slice
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "x.com": {
        "status": "operational",
        "tier": {"params": {"headless": "html"}, "endpoint_override": None},
        "url": "https://x.com/elonmusk",
        "cost_per_1k_usd": 1,
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "youtube.com": {
        "status": "operational",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.youtube.com/@MrBeast",
        "cost_per_1k_usd": 0.5,
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
    "zillow.com": {
        "status": "operational",
        "tier": {"params": {"headless": "html"}, "endpoint_override": None},
        "url": "https://www.zillow.com/columbus-oh/",
        "cost_per_1k_usd": 1,
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "reason_code": None,
    },
}


# ---------------------------------------------------------------------------
# Request builder — follows the slice request_recipe EXACTLY.
#   transport: POST   auth: header Basic   base: /v2/scrape
#   body: {"url": target} + tier params (headless / country) merged in.
#   endpoint_override (always null for Decodo) is honored if ever present.
# ---------------------------------------------------------------------------
def build_request(token, url, tier):
    endpoint = tier.get("endpoint_override") or ENDPOINT
    body = {"url": url}
    # Tier params (e.g. headless="html", country="es") go straight into the JSON body.
    body.update(tier.get("params", {}))
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    # Token is ALREADY base64(user:pass) — use verbatim, do NOT re-encode.
    req.add_header("Authorization", "Basic " + token)
    return req


def unwrap_response(raw_bytes):
    """Decodo wraps the page in a JSON envelope: results[0].content holds the HTML,
    results[0].status_code is the inner per-target status. Verify against .content.
    Returns (html_string, inner_status). On any shape mismatch returns ("", None)."""
    try:
        payload = json.loads(raw_bytes.decode("utf-8", errors="replace"))
    except (ValueError, AttributeError):
        return "", None
    results = payload.get("results")
    if isinstance(results, list) and results:
        first = results[0]
        if isinstance(first, dict):
            content = first.get("content", "")
            inner = first.get("status_code")
            if not isinstance(content, str):
                # Some endpoints return JSON content as a dict — stringify it so
                # substring verify still works.
                content = json.dumps(content)
            return content, inner
    return "", None


def verify(body, verify_keys, need_at_least):
    """Count substring hits among verify_keys; PASS when hits >= need_at_least.
    IDENTICAL rule to the TypeScript port."""
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run_trial(token, url, tier):
    """One request. Returns (passed_bool, hits, latency_ms, note)."""
    start = time.time()
    try:
        req = build_request(token, url, tier)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
        latency_ms = int((time.time() - start) * 1000)
        body, inner = unwrap_response(raw)
        if not body:
            return False, 0, latency_ms, "empty/unparseable envelope (inner=%s)" % inner
        return None, body, latency_ms, inner  # caller verifies against keys
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - start) * 1000)
        return False, 0, latency_ms, "HTTP %s" % e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        latency_ms = int((time.time() - start) * 1000)
        return False, 0, latency_ms, "network: %s" % e


def main():
    parser = argparse.ArgumentParser(description="Decodo Scraper API PASS/FAIL probe.")
    parser.add_argument("--trials", type=int, default=3, help="trials per domain (default 3)")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # --- Auth check FIRST, before any request. Never crash on missing token. ---
    token = os.environ.get(AUTH_ENV, "").strip()
    if not token:
        print("Set %s to run (see .env.example)" % AUTH_ENV)
        sys.exit(0)

    print("Decodo probe — %d trial(s)/domain, endpoint %s\n" % (trials, ENDPOINT))

    domain_results = {}
    operational_srs = []
    operational_latencies = []
    reachable = 0
    total = len(DOMAINS)

    for domain, spec in DOMAINS.items():
        # genuine_fail rows: DO NOT request. (Decodo slice has none, but honor the rule.)
        if spec["status"] != "operational":
            note = spec.get("reason_code") or "non-operational"
            print("SKIP %s: %s — not requested (genuine_fail in frozen baseline)" % (domain, note))
            domain_results[domain] = {
                "status": spec["status"],
                "tier": spec["tier"],
                "url": spec["url"],
                "success_rate": 0,
                "avg_latency_ms": 0,
                "cost_per_1k_usd": spec["cost_per_1k_usd"],
                "cost_source": "frozen",
                "verify_keys": spec["verify_keys"],
                "need_at_least": spec["need_at_least"],
                "reason_code": spec.get("reason_code"),
            }
            continue

        reachable += 1
        passes = 0
        latencies = []
        for t in range(trials):
            result = run_trial(token, spec["url"], spec["tier"])
            # run_trial returns (None, body, latency, inner) on a fetched envelope,
            # else (False, 0, latency, note) on a hard failure.
            if result[0] is None:
                _, body, latency_ms, _inner = result
                ok, _hits = verify(body, spec["verify_keys"], spec["need_at_least"])
            else:
                ok, _hits, latency_ms, _note = result
            if ok:
                passes += 1
            latencies.append(latency_ms)
            # Sequential pacing — DataDome shield (g2) collapses under concurrency.
            if not (t == trials - 1):
                time.sleep(PACE_SECONDS)

        sr = round(passes / trials, 4)
        avg_lat = int(sum(latencies) / len(latencies)) if latencies else 0
        operational_srs.append(sr)
        operational_latencies.append(avg_lat)
        domain_results[domain] = {
            "status": "operational",
            "tier": spec["tier"],
            "url": spec["url"],
            "success_rate": sr,
            "pass_count": passes,
            "trials": trials,
            "avg_latency_ms": avg_lat,
            "cost_per_1k_usd": spec["cost_per_1k_usd"],
            "cost_source": "frozen",
            "verify_keys": spec["verify_keys"],
            "need_at_least": spec["need_at_least"],
        }
        print("  %-16s SR=%4.0f%%  %5d ms  (%d/%d pass)" % (domain, sr * 100, avg_lat, passes, trials))

    # --- Summary, computed the same way as the frozen file. ---
    avg_sr = round(sum(operational_srs) / len(operational_srs), 4) if operational_srs else 0
    avg_lat = int(sum(operational_latencies) / len(operational_latencies)) if operational_latencies else 0
    summary = {
        "domains_total": total,
        "operational": sum(1 for s in DOMAINS.values() if s["status"] == "operational"),
        "genuine_fail": sum(1 for s in DOMAINS.values() if s["status"] != "operational"),
        "reachability_pct": round(reachable / total * 100) if total else 0,
        "avg_success_rate": avg_sr,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # frozen — cost not measured live
        "avg_latency_ms": avg_lat,
    }

    out = {
        "provider": PROVIDER,
        "report_date": REPORT_DATE,
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": domain_results,
    }

    # Write ../../test-results/decodo.run.json relative to THIS file's location.
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(here, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "%s.run.json" % PROVIDER)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    # --- Clean per-domain table to stdout. ---
    print("\n%-18s %-12s %6s %9s" % ("DOMAIN", "STATUS", "SR", "AVG ms"))
    print("-" * 48)
    for domain, row in domain_results.items():
        print("%-18s %-12s %5.0f%% %8d" % (
            domain, row["status"], row["success_rate"] * 100, row["avg_latency_ms"]))
    print("-" * 48)
    print("avg_success_rate=%.3f  reachability=%d%%  avg_latency=%d ms" % (
        summary["avg_success_rate"], summary["reachability_pct"], summary["avg_latency_ms"]))
    print("\nWrote %s" % out_path)


if __name__ == "__main__":
    main()
