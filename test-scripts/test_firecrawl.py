#!/usr/bin/env python3
"""
test_firecrawl.py — self-contained PASS/FAIL test harness for the Firecrawl scraping provider.

WHAT IT TESTS
  Runs the frozen 2026 benchmark domain set against Firecrawl's /v1/scrape endpoint and
  reports per-domain PASS/FAIL plus an aggregate success rate, so you can diff a live run
  against the frozen reference numbers embedded below.

  For each OPERATIONAL domain it issues N POST requests (default 3) and counts a trial as a
  PASS when:
    1. STRICT source check:  data.metadata.sourceURL contains the target domain
       (Firecrawl quirk: /search-style URLs can return snippet content from OTHER sites; the
        sourceURL gate avoids those false positives), AND
    2. verify(): at least `need_at_least` of the domain's verify_keys appear as substrings in
       the returned content (data.markdown + data.html).

  GENUINE_FAIL domains are NOT requested — they are known dead ends (ToS deny-list 403 or
  reCAPTCHA 429). The script prints a single SKIP line per such domain.

HOW TO RUN
  export FIRECRAWL_TOKEN=fc-xxxxxxxx           # the only required setup (see .env.example)
  python3 test_firecrawl.py                    # 3 trials per operational domain
  python3 test_firecrawl.py --trials 5         # custom trial count

  If FIRECRAWL_TOKEN is unset the script prints a hint and exits 0 (never crashes).

WHAT IT WRITES
  ../../test-results/firecrawl.run.json  (relative to this script's directory)
  Same schema as the frozen reference file:
    {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}
  Cost figures are copied from the frozen slice (not measured live) and tagged
  "cost_source":"frozen"; success_rate and avg_latency_ms are MEASURED this run.

QUIRKS BAKED IN (from the request recipe)
  - Transport POST, JSON body to the endpoint_override (v1/scrape).
  - Auth via "Authorization: Bearer <token>" header.
  - Body: {"url": target, "formats": ["markdown"]} plus tier params (waitFor, proxy, mobile...).
  - Response unwrap: data.markdown / data.html for content, data.metadata.sourceURL for the gate.
  - Pace 650ms between calls (Firecrawl plan rate-limit is 100 req/min).
  - Cache-bust: append a _t counter param to the target URL each trial.

Stdlib only. Python 3.8+.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

PROVIDER = "firecrawl"
ENDPOINT = "https://api.firecrawl.dev/v1"
AUTH_ENV = "FIRECRAWL_TOKEN"

# Pace between calls in seconds. Recipe: "Pace 650ms between calls" — Firecrawl plans cap at
# 100 req/min, so anything faster risks RL misses that look like target blocks.
PACE_SECONDS = 0.650
REQUEST_TIMEOUT = 90  # stealth + waitFor domains (bestbuy ~14s avg) need a generous ceiling.

# Frozen aggregate cost (copied, not measured). Used verbatim in the run summary.
FROZEN_AVG_COST_PER_1K_USD = 16.7

# ---------------------------------------------------------------------------
# DOMAINS — literal values from the frozen slice. Do NOT read the slice at runtime.
# Each operational entry: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen). genuine_fail entries also carry a reason_code + note.
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "productTitle",
            'id="dp-container"',
            'id="centerCol"',
            'data-asin="B07FZ8S74R"',
            "nav-logo-base",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
    "bestbuy.com": {
        "status": "operational",
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "tier": {
            "params": {"formats": ["markdown"], "waitFor": 5000, "proxy": "stealth"},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "bing.com": {
        "status": "operational",
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            'id="b_content"',
            'id="sb_form"',
            'class="b_algo',
            'class="b_attribution',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
    "booking.com": {
        "status": "operational",
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
    "capterra.com": {
        "status": "operational",
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth", "waitFor": 4000},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "g2.com": {
        "status": "operational",
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth"},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "github.com": {
        "status": "operational",
        "url": "https://github.com/microsoft/vscode",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            'data-testid="latest-commit-details"',
            'data-testid="view-all-files-row"',
            'id="repository-container-header"',
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
    "google.com": {
        "status": "genuine_fail",
        "url": "https://www.google.com/search?q=python+tutorial",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "recaptcha_429",
        "note": "reCAPTCHA 429 every tier; FC IP pool is on Google's high-volume rate-limit list.",
    },
    "idealista.com": {
        "status": "operational",
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth"},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "indeed.com": {
        "status": "operational",
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth"},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "instagram.com": {
        "status": "genuine_fail",
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
        "cost_per_1k_usd": None,
        "reason_code": "tos_denylist",
        "note": '"we do not support this site" 403 block-list.',
    },
    "linkedin.com": {
        "status": "genuine_fail",
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
        "cost_per_1k_usd": None,
        "reason_code": "tos_denylist",
        "note": "same block-list 403 as instagram/reddit.",
    },
    "reddit.com": {
        "status": "genuine_fail",
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
        "cost_per_1k_usd": None,
        "reason_code": "tos_denylist",
        "note": "same block-list 403; old.reddit.com, np.reddit.com all blocked.",
    },
    "tripadvisor.com": {
        "status": "operational",
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth"},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            '"@type":"LodgingBusiness"',
            '"aggregateRating"',
            "data-automation",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "trustpilot.com": {
        "status": "operational",
        "url": "https://www.trustpilot.com/review/amazon.com",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth", "waitFor": 4000},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {
            "params": {"formats": ["markdown"], "proxy": "stealth"},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 26.65,
    },
    "x.com": {
        "status": "operational",
        "url": "https://x.com/elonmusk",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
    },
    "youtube.com": {
        "status": "operational",
        "url": "https://www.youtube.com/@MrBeast",
        "tier": {
            "params": {"formats": ["markdown"]},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
    "zillow.com": {
        "status": "operational",
        "url": "https://www.zillow.com/columbus-oh/",
        "tier": {
            "params": {"formats": ["markdown"], "mobile": True},
            "endpoint_override": "https://api.firecrawl.dev/v1/scrape",
        },
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 5.33,
    },
}


# ---------------------------------------------------------------------------
# verify() — IDENTICAL rule to the TS file: count verify_key substring hits in the
# content, PASS when hits >= need_at_least.
# ---------------------------------------------------------------------------
def verify(body, verify_keys, need_at_least):
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least


def domain_in_source(source_url, domain):
    """STRICT source gate (Firecrawl quirk): the returned metadata.sourceURL must contain the
    target domain, otherwise a /search-style page could pass on snippet text from another site."""
    if not source_url:
        return False
    return domain.lower() in source_url.lower()


def cache_bust(url, counter):
    """Append a deterministic _t counter param (recipe: cache-bust with _t). A counter keeps
    the file deterministic — no wall-clock randomness."""
    sep = "&" if "?" in url else "?"
    return "{}{}_t={}".format(url, sep, counter)


def build_request(token, target_url, tier, counter):
    """Firecrawl request builder, exactly per the recipe:
      POST JSON to the endpoint_override (v1/scrape).
      Header: Authorization: Bearer <token>.
      Body:   {"url": <cache-busted target>, "formats": ["markdown"], **tier params}.
    Returns a urllib Request ready to open."""
    endpoint = tier.get("endpoint_override") or (ENDPOINT + "/scrape")
    busted = cache_bust(target_url, counter)

    # Tier params already include {"formats": ["markdown"]}; merge with url on top.
    body = dict(tier.get("params", {}))
    body["url"] = busted

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, method="POST")
    req.add_header("Authorization", "Bearer {}".format(token))
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    return req


def unwrap(payload):
    """Response unwrapping per recipe: content lives in data.markdown / data.html,
    and the source gate is data.metadata.sourceURL. Returns (content, source_url)."""
    data = payload.get("data") or {}
    content = ""
    if isinstance(data.get("markdown"), str):
        content += data["markdown"]
    if isinstance(data.get("html"), str):
        content += data["html"]
    metadata = data.get("metadata") or {}
    source_url = metadata.get("sourceURL") or ""
    return content, source_url


def run_trial(token, domain, info, counter):
    """Run one trial. Returns (passed: bool, latency_ms: int)."""
    req = build_request(token, info["url"], info["tier"], counter)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        latency_ms = int((time.time() - started) * 1000)
    except urllib.error.HTTPError as e:
        # HTTP error (e.g. 403 deny-list, 429 RL) — count as a fail, record latency.
        latency_ms = int((time.time() - started) * 1000)
        return False, latency_ms
    except Exception:
        latency_ms = int((time.time() - started) * 1000)
        return False, latency_ms

    try:
        payload = json.loads(raw)
    except ValueError:
        return False, latency_ms

    content, source_url = unwrap(payload)

    # STRICT verify: source gate AND verify_keys.
    if not domain_in_source(source_url, domain):
        return False, latency_ms
    passed = verify(content, info["verify_keys"], info["need_at_least"])
    return passed, latency_ms


def round_or_none(value, digits):
    return round(value, digits) if value is not None else None


def main():
    parser = argparse.ArgumentParser(description="Firecrawl per-domain PASS/FAIL test harness.")
    parser.add_argument("--trials", type=int, default=3, help="Trials per operational domain (default 3).")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # Auth check FIRST — before any request. Exit 0 (never crash) when unset.
    token = os.environ.get(AUTH_ENV)
    if not token:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        return 0

    print("Firecrawl test — {} trials per operational domain, {}ms pacing\n".format(trials, int(PACE_SECONDS * 1000)))

    # Global cache-bust counter — deterministic, increments across every request issued.
    counter = 0
    results = {}

    for domain, info in DOMAINS.items():
        if info["status"] == "genuine_fail":
            # Recipe: do NOT make requests for genuine_fail rows.
            print("SKIP {}: {} — {}".format(domain, info.get("reason_code", "genuine_fail"), info.get("note", "")))
            results[domain] = {
                "status": "genuine_fail",
                "success_rate": 0.0,
                "avg_latency_ms": None,
                "reason_code": info.get("reason_code"),
                "cost_per_1k_usd": info.get("cost_per_1k_usd"),
                "cost_source": "frozen",
            }
            continue

        passes = 0
        latencies = []
        for _ in range(trials):
            counter += 1
            passed, latency_ms = run_trial(token, domain, info, counter)
            if passed:
                passes += 1
            latencies.append(latency_ms)
            # Pace between calls (Firecrawl 100 req/min plan limit).
            time.sleep(PACE_SECONDS)

        success_rate = passes / trials
        avg_latency = int(sum(latencies) / len(latencies)) if latencies else None
        results[domain] = {
            "status": "operational",
            "pass": passes,
            "trials": trials,
            "success_rate": round(success_rate, 3),
            "avg_latency_ms": avg_latency,
            "cost_per_1k_usd": info.get("cost_per_1k_usd"),
            "cost_source": "frozen",
        }

    # --- Summary, computed the same way as the frozen file -------------------
    operational = [d for d in DOMAINS.values() if d["status"] == "operational"]
    genuine_fail = [d for d in DOMAINS.values() if d["status"] == "genuine_fail"]
    domains_total = len(DOMAINS)
    op_count = len(operational)

    reachability_pct = round(op_count / domains_total * 100) if domains_total else 0
    op_results = [results[d] for d in DOMAINS if DOMAINS[d]["status"] == "operational"]
    avg_success_rate = (
        round(sum(r["success_rate"] for r in op_results) / len(op_results), 3) if op_results else 0.0
    )
    op_latencies = [r["avg_latency_ms"] for r in op_results if r["avg_latency_ms"] is not None]
    avg_latency_ms = int(sum(op_latencies) / len(op_latencies)) if op_latencies else None

    summary = {
        "domains_total": domains_total,
        "operational": op_count,
        "genuine_fail": len(genuine_fail),
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # copied from frozen; not measured live
        "avg_latency_ms": avg_latency_ms,
        "cost_source": "frozen",
    }

    out = {
        "provider": PROVIDER,
        "report_date": time.strftime("%Y-%m-%d"),  # today
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": results,
    }

    # Write to ../../test-results/<provider>.run.json relative to THIS script's location.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(script_dir, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "{}.run.json".format(PROVIDER))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # --- Clean per-domain table to stdout ------------------------------------
    print("\n{:<18} {:<13} {:>6} {:>10}".format("DOMAIN", "STATUS", "SR", "AVG_MS"))
    print("-" * 50)
    for domain, info in DOMAINS.items():
        r = results[domain]
        if info["status"] == "genuine_fail":
            print("{:<18} {:<13} {:>6} {:>10}".format(domain, "genuine_fail", "-", "-"))
        else:
            sr = "{:.0%}".format(r["success_rate"])
            ms = str(r["avg_latency_ms"]) if r["avg_latency_ms"] is not None else "-"
            label = "{} ({}/{})".format("operational", r["pass"], r["trials"])
            print("{:<18} {:<13} {:>6} {:>10}".format(domain, label, sr, ms))

    print("\nReachability: {}%  |  avg SR: {:.1%}  |  avg ms: {}".format(
        reachability_pct, avg_success_rate, avg_latency_ms if avg_latency_ms is not None else "-"))
    print("Wrote {}".format(out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
