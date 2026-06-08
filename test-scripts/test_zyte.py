#!/usr/bin/env python3
"""
test_zyte.py -- self-contained reachability/verification test for the Zyte API.

WHAT IT TESTS
  Runs Zyte's /v1/extract endpoint against 20 frozen target domains (18 operational,
  2 genuine-fail) and checks whether the returned HTML contains the expected per-domain
  "verify keys". A domain PASSES a trial when at least `need_at_least` of its verify keys
  appear as substrings in the unwrapped response body.

HOW TO RUN
  export ZYTE_API_KEY=...            # your Zyte API key
  python3 test_zyte.py               # 3 trials per operational domain (default)
  python3 test_zyte.py --trials 5    # custom trial count

  If ZYTE_API_KEY is unset the script prints a hint and exits 0 (it never crashes).

WHAT IT WRITES
  ../../test-results/zyte.run.json  (relative to this script's own location:
  test-scripts/zyte/ -> ../../test-results/). Same schema as the frozen file:
  {provider, report_date(today), frozen:false, endpoint, auth_env, summary, domains}.
  Cost numbers are copied from the frozen slice (cost is not measured live) and tagged
  "cost_source":"frozen"; success_rate and avg_latency_ms are measured this run.

ZYTE QUIRKS (baked into this script)
  * Transport is POST JSON to https://api.zyte.com/v1/extract.
  * Auth is HTTP Basic with the API key as the USERNAME and an EMPTY password, i.e.
    Authorization: Basic base64("<ZYTE_API_KEY>:")  -- note the trailing colon.
  * Tier params come straight from the slice: httpResponseBody (t1, $0.0006/req),
    browserHtml (t2, $0.003/req), or extractor flags (product/article).
  * httpResponseBody is returned BASE64-ENCODED and MUST be decoded before verifying.
    browserHtml is plain text. Any other extractor output is JSON-stringified.
  * linkedin (451 Domain Forbidden, account-policy) and g2 (520 Website Ban) are
    genuine_fail: the script SKIPS them and makes no request.

Stdlib only (urllib, json, os, sys, base64, argparse, time). Python 3.8+.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

PROVIDER = "zyte"
ENDPOINT = "https://api.zyte.com/v1/extract"
AUTH_ENV = "ZYTE_API_KEY"

# Frozen summary cost figure, copied verbatim from the slice (cost is not measured live).
FROZEN_AVG_COST_PER_1K_USD = 1.11

# Per-provider pacing. Zyte's API is generous but the heavy browserHtml/extractor
# domains run long; a small inter-trial sleep keeps us well under any burst limit.
PACE_SECONDS = 1.0

# Request timeout. Zyte's browserHtml p90 can hit ~60s (zillow), so give it room.
REQUEST_TIMEOUT = 90

# ---------------------------------------------------------------------------
# DOMAINS table -- literal values lifted from the slice. Each operational row keeps
# url, tier (params + endpoint_override), verify_keys, need_at_least, status, plus the
# frozen cost_per_1k_usd. genuine_fail rows additionally carry a reason_code + note.
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "productTitle",
            "id=\"dp-container\"",
            "id=\"centerCol\"",
            "data-asin=\"B07FZ8S74R\"",
            "nav-logo-base",
        ],
        "need_at_least": 2,
    },
    "bestbuy.com": {
        "status": "operational",
        "tier": {"params": {"product": True}, "endpoint_override": None},
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "cost_per_1k_usd": None,
        "verify_keys": [
            "application/ld+json",
            "\"@type\":\"Product\"",
            "\"sku\":\"6570601\"",
            "\"customerPrice\"",
            "add-to-cart-button",
        ],
        "need_at_least": 2,
    },
    "bing.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            "id=\"b_content\"",
            "id=\"sb_form\"",
            "class=\"b_algo",
            "class=\"b_attribution",
        ],
        "need_at_least": 2,
    },
    "booking.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            "\"@type\" : \"Hotel\"",
            "\"hotelId\":",
            "\"reviewCount\"",
        ],
        "need_at_least": 2,
    },
    "capterra.com": {
        "status": "operational",
        # GB geolocation per the slice -- capterra serves a US interstitial otherwise.
        "tier": {"params": {"httpResponseBody": True, "geolocation": "GB"}, "endpoint_override": None},
        "url": "https://www.capterra.com/p/135003/Slack/",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "<title>Slack Software Pricing",
            "\"@type\":\"SoftwareApplication\"",
            "\"name\":\"Slack\"",
            "data-testid=\"hero-section\"",
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
    },
    "ebay.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.ebay.com/itm/116619563010",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            "\"product\":",
            "p.ebaystatic.com",
            "\"@type\":\"Product\"",
        ],
        "need_at_least": 2,
    },
    "g2.com": {
        "status": "genuine_fail",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.g2.com/products/slack/reviews",
        "cost_per_1k_usd": None,
        "verify_keys": [
            "<title>Slack Reviews 2026",
            "itemprop=\"ratingValue\"",
            "itemprop=\"reviewBody\"",
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "reason_code": "website_ban_520",
        "note": "520 Website Ban every tier including browser actions.",
    },
    "github.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://github.com/microsoft/vscode",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            "data-testid=\"latest-commit-details\"",
            "data-testid=\"view-all-files-row\"",
            "id=\"repository-container-header\"",
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
    },
    "google.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.google.com/search?q=python+tutorial",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "id=\"search\"",
            "id=\"rso\"",
            "id=\"rcnt\"",
            "<title>python tutorial - Google Search</title>",
            "itemtype=\"http://schema.org/SearchResultsPage\"",
        ],
        "need_at_least": 2,
    },
    "idealista.com": {
        "status": "operational",
        "tier": {"params": {"product": True}, "endpoint_override": None},
        "url": "https://www.idealista.com/inmueble/110715434/",
        "cost_per_1k_usd": None,
        "verify_keys": [
            "class=\"main-info__title-main\"",
            "class=\"info-data-price\"",
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
    },
    "indeed.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            "data-jk=\"",
            "class=\"job_seen_beacon",
            "data-testid=\"company-name\"",
            "id=\"mosaic-provider-jobcards\"",
        ],
        "need_at_least": 2,
    },
    "instagram.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.instagram.com/nike/",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "\"username\":\"nike\"",
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            "href=\"https://www.instagram.com/nike/\"",
            "og:type\" content=\"profile\"",
        ],
        "need_at_least": 2,
    },
    "linkedin.com": {
        "status": "genuine_fail",
        "tier": {"params": {}, "endpoint_override": None},
        "url": "https://www.linkedin.com/company/microsoft/",
        "cost_per_1k_usd": 0,
        "verify_keys": [
            "<title>Microsoft | LinkedIn</title>",
            "\"@type\":\"Organization\"",
            "urn:li:organization",
            "/company/microsoft",
            "_org_guest_company_overview",
        ],
        "need_at_least": 2,
        "reason_code": "domain_forbidden_451",
        "note": "451 Domain Forbidden (account-policy block).",
    },
    "reddit.com": {
        "status": "operational",
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://old.reddit.com/r/programming/",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "id=\"siteTable\"",
            "data-fullname=\"t3_",
            "data-subreddit=\"programming\"",
            "data-subreddit-prefixed=\"r/programming\"",
            "<title>programming</title>",
        ],
        "need_at_least": 2,
    },
    "tripadvisor.com": {
        "status": "operational",
        "tier": {"params": {"article": True}, "endpoint_override": None},
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "cost_per_1k_usd": None,
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            "\"@type\":\"LodgingBusiness\"",
            "\"aggregateRating\"",
            "data-automation",
        ],
        "need_at_least": 2,
    },
    "trustpilot.com": {
        "status": "operational",
        # t1 returned 520, escalated to browserHtml ($0.003/req).
        "tier": {"params": {"browserHtml": True}, "endpoint_override": None},
        "url": "https://www.trustpilot.com/review/amazon.com",
        "cost_per_1k_usd": 3,
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            "\"@type\":\"Organization\"",
            "\"@type\":\"AggregateRating\"",
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
    },
    "walmart.com": {
        "status": "operational",
        "tier": {"params": {"product": True}, "endpoint_override": None},
        "url": "https://www.walmart.com/ip/604342441",
        "cost_per_1k_usd": None,
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            "\"itemId\":\"604342441\"",
            "data-testid=\"price-wrap\"",
            "id=\"__NEXT_DATA__\"",
            "data-testid=\"hero-image-container\"",
        ],
        "need_at_least": 2,
    },
    "x.com": {
        "status": "operational",
        # t1 returns login-wall HTML; browserHtml needed for real content.
        "tier": {"params": {"browserHtml": True}, "endpoint_override": None},
        "url": "https://x.com/elonmusk",
        "cost_per_1k_usd": 3,
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            "data-testid=\"tweet\"",
        ],
        "need_at_least": 2,
    },
    "youtube.com": {
        "status": "operational",
        # t1 httpResponseBody. Frozen note: lenient verifier; t2 browserHtml is the strict
        # alternative, but the slice's canonical tier here is httpResponseBody, so we keep it.
        "tier": {"params": {"httpResponseBody": True}, "endpoint_override": None},
        "url": "https://www.youtube.com/@MrBeast",
        "cost_per_1k_usd": 0.6,
        "verify_keys": [
            "\"channelMetadataRenderer\"",
            "\"externalId\":\"UCX6OQ3DkcsbYNE6H8uQQuVA\"",
            "ytInitialData",
            "\"title\":\"MrBeast\"",
            "\"subscriberCountText\"",
        ],
        "need_at_least": 2,
    },
    "zillow.com": {
        "status": "operational",
        # t2 browserHtml; p90 hits the 60s timeout (hence REQUEST_TIMEOUT=90).
        "tier": {"params": {"browserHtml": True}, "endpoint_override": None},
        "url": "https://www.zillow.com/columbus-oh/",
        "cost_per_1k_usd": 3,
        "verify_keys": [
            "data-testid=\"property-card\"",
            "\"zpid\":",
            "\"@type\":\"SingleFamilyResidence\"",
            "\"streetAddress\"",
            "\"bedrooms\"",
        ],
        "need_at_least": 2,
    },
}


def verify(body, verify_keys, need_at_least):
    """Count how many verify_keys appear as substrings in body; PASS when hits >= need_at_least.
    This rule is byte-for-byte identical to the TypeScript implementation."""
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def build_request(api_key, url, params, endpoint_override=None):
    """Build the Zyte /v1/extract POST request following the slice's request_recipe EXACTLY.

    Recipe:
      transport: POST JSON
      auth:      header:Basic-keyonly  -> Authorization: Basic base64("<API_KEY>:")
                 (API key as username, EMPTY password, trailing colon)
      body:      {url: targetUrl, <tier params...>}  e.g. {url, httpResponseBody:true}
    endpoint_override is null for every Zyte domain, but honor it if ever present.
    """
    payload = {"url": url}
    payload.update(params)
    data = json.dumps(payload).encode("utf-8")

    # Basic auth, key-only: username = API key, password = "" -> base64("<key>:").
    token = base64.b64encode("{}:".format(api_key).encode("utf-8")).decode("ascii")

    target = endpoint_override or ENDPOINT
    req = urllib.request.Request(target, data=data, method="POST")
    req.add_header("Authorization", "Basic " + token)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    return req


def unwrap(resp_json, params):
    """Turn a Zyte JSON response into a single string body for verification.

    * httpResponseBody is BASE64 -> decode to UTF-8 text (errors replaced).
    * browserHtml is plain text -> use as-is.
    * Any other extractor output (product/article/etc.) -> JSON-stringify the whole object
      so structured fields are still substring-searchable.
    """
    if params.get("httpResponseBody"):
        b64 = resp_json.get("httpResponseBody")
        if b64:
            return base64.b64decode(b64).decode("utf-8", errors="replace")
        return ""
    if params.get("browserHtml"):
        return resp_json.get("browserHtml") or ""
    # Extractor tiers (product/article/...) or anything else: stringify the JSON payload.
    return json.dumps(resp_json, ensure_ascii=False)


def run_trial(api_key, dom):
    """One request. Returns (passed: bool, latency_ms: int)."""
    params = dom["tier"]["params"]
    # endpoint_override is null for every Zyte domain, but honor it if ever present.
    req = build_request(api_key, dom["url"], params, dom["tier"].get("endpoint_override"))
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        latency_ms = int((time.time() - start) * 1000)
        resp_json = json.loads(raw)
        body = unwrap(resp_json, params)
        passed, _ = verify(body, dom["verify_keys"], dom["need_at_least"])
        return passed, latency_ms
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - start) * 1000)
        # Surface the HTTP status (e.g. 451/520/429) without crashing the run.
        sys.stderr.write("  HTTP {} on request\n".format(e.code))
        return False, latency_ms
    except Exception as e:  # noqa: BLE001 - network/parse errors must not abort the suite.
        latency_ms = int((time.time() - start) * 1000)
        sys.stderr.write("  error: {}\n".format(e))
        return False, latency_ms


def main():
    parser = argparse.ArgumentParser(description="Test the Zyte API against frozen target domains.")
    parser.add_argument("--trials", type=int, default=3, help="trials per operational domain (default 3)")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # Auth check BEFORE any request. Never crash on a missing key.
    api_key = os.environ.get(AUTH_ENV)
    if not api_key:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        sys.exit(0)

    today = time.strftime("%Y-%m-%d")
    print("zyte test -- {} trials/domain -- {}\n".format(trials, today))

    results = {}
    op_success_rates = []
    op_latencies = []
    reachable = 0

    for name, dom in DOMAINS.items():
        if dom["status"] == "genuine_fail":
            # No request for genuine failures -- one explanatory SKIP line.
            print("SKIP {}: {} -- {}".format(name, dom["reason_code"], dom["note"]))
            results[name] = {
                "status": "genuine_fail",
                "tier": dom["tier"],
                "url": dom["url"],
                "success_rate": 0,
                "avg_latency_ms": None,
                "cost_per_1k_usd": dom["cost_per_1k_usd"],
                "cost_source": "frozen",
                "reason_code": dom["reason_code"],
                "verify_keys": dom["verify_keys"],
                "need_at_least": dom["need_at_least"],
            }
            continue

        passes = 0
        latencies = []
        for t in range(trials):
            passed, latency_ms = run_trial(api_key, dom)
            if passed:
                passes += 1
            latencies.append(latency_ms)
            if t < trials - 1:
                time.sleep(PACE_SECONDS)  # pace between trials

        success_rate = passes / trials
        avg_latency = int(sum(latencies) / len(latencies)) if latencies else 0
        op_success_rates.append(success_rate)
        op_latencies.append(avg_latency)
        if success_rate > 0:
            reachable += 1

        print("  {:<16} {:>4}/{:<2} SR={:.3f}  {} ms".format(
            name, passes, trials, success_rate, avg_latency))

        results[name] = {
            "status": "operational",
            "tier": dom["tier"],
            "url": dom["url"],
            "success_rate": success_rate,
            "pass_count": passes,
            "trials": trials,
            "avg_latency_ms": avg_latency,
            "cost_per_1k_usd": dom["cost_per_1k_usd"],
            "cost_source": "frozen",
            "verify_keys": dom["verify_keys"],
            "need_at_least": dom["need_at_least"],
        }

    total = len(DOMAINS)
    operational = sum(1 for d in DOMAINS.values() if d["status"] == "operational")
    genuine_fail = total - operational
    # reachability_pct = operational domains that produced >=1 passing trial, over total.
    reachability_pct = round(100 * reachable / total, 0) if total else 0
    avg_success_rate = round(sum(op_success_rates) / len(op_success_rates), 3) if op_success_rates else 0
    avg_latency_ms = int(sum(op_latencies) / len(op_latencies)) if op_latencies else 0

    summary = {
        "domains_total": total,
        "operational": operational,
        "genuine_fail": genuine_fail,
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # frozen; cost isn't measured live
        "avg_latency_ms": avg_latency_ms,
    }

    out = {
        "provider": PROVIDER,
        "report_date": today,
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": results,
    }

    # Write ../../test-results/zyte.run.json relative to THIS script's location.
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "..", "..", "test-results")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "{}.run.json".format(PROVIDER))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print("\nsummary: reachability={}%  avg_SR={}  avg_latency={} ms".format(
        reachability_pct, avg_success_rate, avg_latency_ms))
    print("wrote {}".format(os.path.abspath(out_path)))


if __name__ == "__main__":
    main()
