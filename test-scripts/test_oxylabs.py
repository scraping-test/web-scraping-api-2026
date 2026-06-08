#!/usr/bin/env python3
"""
test_oxylabs.py — self-contained PASS/FAIL probe for the Oxylabs Web Scraper API.

WHAT THIS TESTS
  Fires the Oxylabs Web Scraper API (Realtime endpoint /v1/queries) at 20 real-world
  target pages (amazon, google, zillow, g2, ...). For each domain it counts how many of
  a small set of "verify_keys" (substrings known to appear in a good response) are present
  in the returned content. A trial PASSes when at least `need_at_least` keys are found.
  We run N trials per domain (default 3) and report a per-domain success rate.

  Two domains (booking.com, idealista.com) use Oxylabs' separate Web Unblocker product,
  which is an HTTPS forward proxy on unblock.oxylabs.io:60000 — NOT the realtime JSON API.
  This Python script is the REFERENCE path: it tunnels those two through the HTTPS proxy
  via urllib (CONNECT works fine in CPython). The TypeScript port instead routes those two
  through the realtime endpoint, because Node's HTTP CONNECT tunneling has a masked bug
  (see request_recipe note). Result numbers should be comparable either way.

  The frozen 2026 reference numbers live in ../../test-results/oxylabs.json. This script
  writes a parallel ../../test-results/oxylabs.run.json in the SAME schema so you can diff
  your live run against the frozen baseline.

HOW TO RUN
  1. export OXYLABS_TOKEN="username:password"
       Oxylabs auth is HTTP Basic with your sub-user credentials. Provide them as
       "user:pass" — this script base64-encodes them for you (do NOT pre-encode).
  2. python test_oxylabs.py                # 3 trials per domain (default)
     python test_oxylabs.py --trials 5     # custom trial count

  Stdlib only (urllib, json, os, sys, base64, argparse, time). Python 3.8+.
  No third-party packages, no shared imports across providers.

WHAT IT WRITES
  ../../test-results/oxylabs.run.json  (relative to this file's location)
  Schema: {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}.
  Each domain row carries status, measured success_rate, avg_latency_ms, and (for
  operational rows) the PASS count. Cost is copied from the frozen slice (not measured
  live) and tagged "cost_source":"frozen".

PROVIDER QUIRKS (baked into this script)
  * Realtime transport is POST JSON to https://realtime.oxylabs.io/v1/queries.
  * Auth header: "Authorization: Basic base64(user:pass)" — we encode OXYLABS_TOKEN.
  * The realtime response is a wrapped envelope: the page is at results[0].content.
    When the per-domain params include parse:true (amazon_product), content is structured
    JSON (a dict), not HTML — we json.dumps() it so substring verify still works.
  * Dedicated parsers/engines are selected via source=<...> (amazon_product, walmart_product,
    google_search, bing, universal). Those params go verbatim into the JSON body.
  * Web Unblocker domains (booking, idealista) use endpoint_override unblock.oxylabs.io:60000
    as an HTTPS proxy: we send the real target URL through it with x-oxylabs-render:html
    (booking) and x-oxylabs-geo-location:Spain (idealista) request headers; the proxy returns
    the target page HTML directly (NOT a JSON envelope).
  * Oxylabs sources are slow (bestbuy ~34s, booking ~31s, indeed ~28s); requests are run
    SEQUENTIALLY with a short pace and a generous per-request timeout.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

PROVIDER = "oxylabs"
ENDPOINT = "https://realtime.oxylabs.io/v1/queries"
AUTH_ENV = "OXYLABS_TOKEN"
REPORT_DATE = "2026-06-08"  # today; frozen baseline shares this date

# Frozen summary cost — cost is NOT measured live, copied from the slice verbatim.
FROZEN_AVG_COST_PER_1K_USD = 7

# Web Unblocker proxy endpoint (HTTPS forward proxy, NOT the realtime JSON API).
UNBLOCKER_ENDPOINT = "https://unblock.oxylabs.io:60000"

# Pace between sequential requests. Oxylabs realtime/unblocker calls are slow and
# rate-limited per sub-user, so we never parallelize and gap each call.
PACE_SECONDS = 1.0
REQUEST_TIMEOUT = 120  # bestbuy/booking/indeed run 28-34s; allow generous headroom.

# ---------------------------------------------------------------------------
# DOMAINS — embedded literal values from the frozen slice (do NOT read it at runtime).
# Each row: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), reason_code (None — no genuine_fail rows here),
# and unblocker_headers (extra x-oxylabs-* headers for the Web Unblocker proxy path).
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "amazon_product", "url": "https://www.amazon.com/dp/B07FZ8S74R", "parse": True},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "productTitle",
            'id="dp-container"',
            'id="centerCol"',
            'data-asin="B07FZ8S74R"',
            "nav-logo-base",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "bestbuy.com": {
        "status": "operational",
        "tier": {
            "params": {
                "source": "universal",
                "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
                "render": "html",
                "geo_location": "United States",
            },
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "bing.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "bing", "query": "best laptops 2025"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            'id="b_content"',
            'id="sb_form"',
            'class="b_algo',
            'class="b_attribution',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "booking.com": {
        "status": "operational",
        "tier": {
            "params": {"url": "https://www.booking.com/hotel/us/the-plaza.html"},
            "endpoint_override": "https://unblock.oxylabs.io:60000",
        },
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        # Web Unblocker quirk: ask the proxy to render JS via x-oxylabs-render:html.
        "unblocker_headers": {"x-oxylabs-render": "html"},
    },
    "capterra.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.capterra.com/p/135003/Slack/", "render": "html"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.capterra.com/p/135003/Slack/",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "ebay.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.ebay.com/itm/116619563010"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.ebay.com/itm/116619563010",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "g2.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.g2.com/products/slack/reviews", "render": "html"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.g2.com/products/slack/reviews",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "github.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://github.com/microsoft/vscode"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://github.com/microsoft/vscode",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            'data-testid="latest-commit-details"',
            'data-testid="view-all-files-row"',
            'id="repository-container-header"',
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "google.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "google_search", "query": "python tutorial"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.google.com/search?q=python+tutorial",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "idealista.com": {
        "status": "operational",
        "tier": {
            "params": {"url": "https://www.idealista.com/inmueble/110715434/"},
            "endpoint_override": "https://unblock.oxylabs.io:60000",
        },
        "url": "https://www.idealista.com/inmueble/110715434/",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "reason_code": None,
        # Web Unblocker quirk: Spanish geo-pin via x-oxylabs-geo-location:Spain.
        "unblocker_headers": {"x-oxylabs-geo-location": "Spain"},
    },
    "indeed.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "instagram.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.instagram.com/nike/"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.instagram.com/nike/",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            '"username":"nike"',
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            'href="https://www.instagram.com/nike/"',
            'og:type" content="profile"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "linkedin.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.linkedin.com/company/microsoft/"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.linkedin.com/company/microsoft/",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>Microsoft | LinkedIn</title>",
            '"@type":"Organization"',
            "urn:li:organization",
            "/company/microsoft",
            "_org_guest_company_overview",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "reddit.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://old.reddit.com/r/programming/"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://old.reddit.com/r/programming/",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            'id="siteTable"',
            'data-fullname="t3_',
            'data-subreddit="programming"',
            'data-subreddit-prefixed="r/programming"',
            "<title>programming</title>",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "tripadvisor.com": {
        "status": "operational",
        "tier": {
            "params": {
                "source": "universal",
                "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
            },
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            '"@type":"LodgingBusiness"',
            '"aggregateRating"',
            "data-automation",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "trustpilot.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.trustpilot.com/review/amazon.com", "render": "html"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.trustpilot.com/review/amazon.com",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "walmart.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "walmart_product", "url": "https://www.walmart.com/ip/604342441"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.walmart.com/ip/604342441",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "x.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://x.com/elonmusk"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://x.com/elonmusk",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "youtube.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.youtube.com/@MrBeast"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.youtube.com/@MrBeast",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
    "zillow.com": {
        "status": "operational",
        "tier": {
            "params": {"source": "universal", "url": "https://www.zillow.com/columbus-oh/"},
            "endpoint_override": "https://realtime.oxylabs.io/v1/queries",
        },
        "url": "https://www.zillow.com/columbus-oh/",
        "cost_per_1k_usd": 7,
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "reason_code": None,
        "unblocker_headers": None,
    },
}


def basic_auth_header(token):
    """Oxylabs auth is HTTP Basic with 'user:pass'. We base64-encode it ourselves
    (the user provides the raw 'user:pass' string, NOT a pre-encoded blob)."""
    return "Basic " + base64.b64encode(token.encode("utf-8")).decode("ascii")


def is_unblocker(tier):
    """True when this domain routes through the Web Unblocker HTTPS proxy."""
    return (tier.get("endpoint_override") or "") == UNBLOCKER_ENDPOINT


# ---------------------------------------------------------------------------
# Realtime request builder — POST JSON to /v1/queries with per-domain params
# placed verbatim into the body (source, url, parse, render, geo_location, query).
# ---------------------------------------------------------------------------
def build_realtime_request(token, tier):
    endpoint = tier.get("endpoint_override") or ENDPOINT
    body = dict(tier.get("params", {}))  # per-domain params verbatim
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("Authorization", basic_auth_header(token))
    return req


def unwrap_realtime(raw_bytes):
    """Realtime wraps the page in a JSON envelope: results[0].content holds the page.
    When parse:true (amazon_product), content is a dict of structured fields — we
    json.dumps() it so substring verify still works on the JSON text.
    Returns (content_string, note). On any shape mismatch returns ("", note)."""
    try:
        payload = json.loads(raw_bytes.decode("utf-8", errors="replace"))
    except (ValueError, AttributeError):
        return "", "unparseable JSON envelope"
    results = payload.get("results")
    if isinstance(results, list) and results:
        first = results[0]
        if isinstance(first, dict):
            content = first.get("content", "")
            if not isinstance(content, str):
                # Structured (parse:true) content — stringify dict/list to text.
                content = json.dumps(content)
            return content, None
    return "", "no results[0].content in envelope"


def fetch_realtime(token, tier):
    """One realtime request. Returns (content_string_or_None, latency_ms, note)."""
    start = time.time()
    try:
        req = build_realtime_request(token, tier)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
        latency_ms = int((time.time() - start) * 1000)
        content, note = unwrap_realtime(raw)
        if not content:
            return None, latency_ms, note
        return content, latency_ms, None
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - start) * 1000)
        return None, latency_ms, "HTTP %s" % e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        latency_ms = int((time.time() - start) * 1000)
        return None, latency_ms, "network: %s" % e


def fetch_unblocker(token, target_url, extra_headers):
    """Web Unblocker path (booking, idealista). The Unblocker is an HTTPS forward proxy
    on unblock.oxylabs.io:60000 — we GET the REAL target URL THROUGH it. CPython's urllib
    handles the CONNECT tunnel fine (Node has a masked CONNECT bug; the TS port avoids it
    by using the realtime endpoint instead). The proxy returns the target page HTML
    directly — there is NO JSON envelope to unwrap here.
    Returns (html_string_or_None, latency_ms, note)."""
    start = time.time()
    try:
        # Proxy URL carries Basic-auth credentials inline: https://user:pass@host:port
        # Oxylabs proxies need TLS verification disabled (self-signed proxy cert), so we
        # build an SSL context that does not verify — scoped to this proxy only.
        import ssl

        proxy_with_auth = "https://%s@unblock.oxylabs.io:60000" % token
        proxy_handler = urllib.request.ProxyHandler({"http": proxy_with_auth, "https": proxy_with_auth})
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        https_handler = urllib.request.HTTPSHandler(context=ctx)
        opener = urllib.request.build_opener(proxy_handler, https_handler)

        req = urllib.request.Request(target_url, method="GET")
        # Web Unblocker control headers (render JS, geo-pin) per the per-domain quirk.
        for k, v in (extra_headers or {}).items():
            req.add_header(k, v)
        with opener.open(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
        latency_ms = int((time.time() - start) * 1000)
        html = raw.decode("utf-8", errors="replace")
        if not html:
            return None, latency_ms, "empty body from unblocker"
        return html, latency_ms, None
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - start) * 1000)
        return None, latency_ms, "HTTP %s" % e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        latency_ms = int((time.time() - start) * 1000)
        return None, latency_ms, "network: %s" % e


def verify(body, verify_keys, need_at_least):
    """Count substring hits among verify_keys; PASS when hits >= need_at_least.
    IDENTICAL rule to the TypeScript port."""
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run_trial(token, spec):
    """One request via the correct transport for this domain.
    Returns (passed_bool, hits, latency_ms, note)."""
    tier = spec["tier"]
    if is_unblocker(tier):
        content, latency_ms, note = fetch_unblocker(token, spec["url"], spec.get("unblocker_headers"))
    else:
        content, latency_ms, note = fetch_realtime(token, tier)
    if content is None:
        return False, 0, latency_ms, note or "no content"
    ok, hits = verify(content, spec["verify_keys"], spec["need_at_least"])
    return ok, hits, latency_ms, None


def main():
    parser = argparse.ArgumentParser(description="Oxylabs Web Scraper API PASS/FAIL probe.")
    parser.add_argument("--trials", type=int, default=3, help="trials per domain (default 3)")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # --- Auth check FIRST, before any request. Never crash on missing token. ---
    token = os.environ.get(AUTH_ENV, "").strip()
    if not token:
        print("Set %s to run (see .env.example)" % AUTH_ENV)
        sys.exit(0)

    print("Oxylabs probe — %d trial(s)/domain, endpoint %s\n" % (trials, ENDPOINT))

    domain_results = {}
    operational_srs = []
    operational_latencies = []
    reachable = 0
    total = len(DOMAINS)

    for domain, spec in DOMAINS.items():
        # genuine_fail rows: DO NOT request. (Oxylabs slice has none, but honor the rule.)
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
                "reason_code": spec.get("reason_code"),
                "verify_keys": spec["verify_keys"],
                "need_at_least": spec["need_at_least"],
            }
            continue

        reachable += 1
        passes = 0
        latencies = []
        for t in range(trials):
            ok, _hits, latency_ms, _note = run_trial(token, spec)
            if ok:
                passes += 1
            latencies.append(latency_ms)
            # Sequential pacing — Oxylabs sub-user rate limits + slow renders.
            if t != trials - 1:
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
        print("  %-16s SR=%4.0f%%  %6d ms  (%d/%d pass)" % (domain, sr * 100, avg_lat, passes, trials))

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

    # Write ../../test-results/oxylabs.run.json relative to THIS file's location.
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
