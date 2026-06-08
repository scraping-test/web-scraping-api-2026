#!/usr/bin/env python3
"""
test_serpapi.py — self-contained SerpApi reachability/verification test.

WHAT THIS TESTS
  SerpApi is a SERP-only specialist ($0.025/search, ~40x most general scraping
  providers). It exposes dedicated structured-JSON "engines" for only a handful
  of sites. This script checks the 8 domains that have a dedicated engine and
  honestly SKIPs the 12 that do not (no_dedicated_engine), running N trials each
  and verifying that the stringified JSON response contains the expected markers.

HOW TO RUN
  1. Get a SerpApi key and export it:
         export SERPAPI_TOKEN=...          (Windows PowerShell: $env:SERPAPI_TOKEN="...")
  2. Run:
         python test_serpapi.py             # 3 trials per operational domain
         python test_serpapi.py --trials 5  # custom trial count
  If SERPAPI_TOKEN is unset the script prints a hint and exits 0 (never crashes).

WHAT IT WRITES
  ../../test-results/serpapi.run.json  (relative to this file's location)
  Same schema as the frozen file:
      {provider, report_date, frozen:false, endpoint, auth_env, summary, domains}
  success_rate / avg_latency_ms are MEASURED this run; cost is copied from the
  frozen slice (cost_source:"frozen") because cost is not measured live.

PROVIDER QUIRKS (cited inline where relevant)
  - Transport GET; auth is a querystring param `api_key` (NOT a header).
  - Response is structured JSON, not HTML — we stringify the whole JSON object
    and run substring verification against it.
  - Only 8/20 domains have an engine; the other 12 are genuine_fail and skipped.
  - Cache-bust by appending a `_t` counter param (recipe note: "vary query or _t").
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROVIDER = "serpapi"
ENDPOINT = "https://serpapi.com/search.json"
AUTH_ENV = "SERPAPI_TOKEN"
REPORT_DATE = "2026-06-08"  # today
FROZEN_AVG_COST_PER_1K_USD = 25  # from frozen slice summary

# ---------------------------------------------------------------------------
# DOMAINS table — literal values embedded from serpapi.json (do NOT read at runtime).
# For each domain: url, tier(params + endpoint_override), verify_keys,
# need_at_least, status, and reason_code for genuine_fail rows.
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "tier": {
            "params": {"engine": "amazon", "k": "wireless headphones", "amazon_domain": "amazon.com"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "productTitle",
            'id="dp-container"',
            'id="centerCol"',
            'data-asin="B07FZ8S74R"',
            "nav-logo-base",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "bestbuy.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "application/ld+json",
            '"@type":"Product"',
            '"sku":"6570601"',
            '"customerPrice"',
            "add-to-cart-button",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "bing.com": {
        "status": "operational",
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {
            "params": {"engine": "bing", "q": "python tutorial"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "<title>best laptops 2025 - Search</title>",
            'id="b_content"',
            'id="sb_form"',
            'class="b_algo',
            'class="b_attribution',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "booking.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "capterra.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {
            "params": {"engine": "ebay", "_nkw": "macbook pro", "ebay_domain": "ebay.com"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "itm.ebaydesc.com",
            "ebayLogoTitle",
            '"product":',
            "p.ebaystatic.com",
            '"@type":"Product"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "g2.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "github.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>GitHub - microsoft/vscode",
            'data-testid="latest-commit-details"',
            'data-testid="view-all-files-row"',
            'id="repository-container-header"',
            "github.com/microsoft/vscode",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "google.com": {
        "status": "operational",
        "url": "https://www.google.com/search?q=python+tutorial",
        "tier": {
            "params": {"engine": "google", "q": "python tutorial"},
            "endpoint_override": None,
        },
        "verify_keys": [
            'id="search"',
            'id="rso"',
            'id="rcnt"',
            "<title>python tutorial - Google Search</title>",
            'itemtype="http://schema.org/SearchResultsPage"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "idealista.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "indeed.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "instagram.com": {
        "status": "operational",
        "url": "https://www.instagram.com/nike/",
        "tier": {
            "params": {"engine": "instagram_profile", "username": "natgeo"},
            "endpoint_override": None,
        },
        "verify_keys": [
            '"username":"nike"',
            "<title>Nike (&#064;nike)",
            "instagram://user?username=nike",
            'href="https://www.instagram.com/nike/"',
            'og:type" content="profile"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "linkedin.com": {
        "status": "genuine_fail",
        "url": None,
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
        "reason_code": "no_dedicated_engine",
    },
    "reddit.com": {
        "status": "genuine_fail",
        "url": None,
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
        "reason_code": "no_dedicated_engine",
    },
    "tripadvisor.com": {
        "status": "operational",
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {
            "params": {"engine": "tripadvisor", "q": "hotels in new york"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "Fairmont",
            "THE PLAZA NEW YORK",
            '"@type":"LodgingBusiness"',
            '"aggregateRating"',
            "data-automation",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "trustpilot.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {
            "params": {"engine": "walmart", "query": "laptop"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "<title>Apple, AirPods with Charging Case",
            '"itemId":"604342441"',
            'data-testid="price-wrap"',
            'id="__NEXT_DATA__"',
            'data-testid="hero-image-container"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "x.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            "elonmusk",
            "Elon Musk",
            "44196397",
            "react-root",
            'data-testid="tweet"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
    "youtube.com": {
        "status": "operational",
        "url": "https://www.youtube.com/@MrBeast",
        "tier": {
            "params": {"engine": "youtube", "search_query": "python tutorial"},
            "endpoint_override": None,
        },
        "verify_keys": [
            '"channelMetadataRenderer"',
            '"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"',
            "ytInitialData",
            '"title":"MrBeast"',
            '"subscriberCountText"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 25,
    },
    "zillow.com": {
        "status": "genuine_fail",
        "url": None,
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": [
            'data-testid="property-card"',
            '"zpid":',
            '"@type":"SingleFamilyResidence"',
            '"streetAddress"',
            '"bedrooms"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "no_dedicated_engine",
    },
}

# Short human-readable note keyed by reason_code, for the SKIP line.
REASON_NOTES = {
    "no_dedicated_engine": "SerpApi is SERP-only; no dedicated engine for this site",
}

# Per-trial pace (seconds). SerpApi has generous per-second limits but we keep a
# small courtesy gap between paid searches ($0.025 each) to avoid burst throttling.
PACE_SECONDS = 1.0


# ---------------------------------------------------------------------------
# Request builder — follows request_recipe EXACTLY.
#   transport: GET
#   auth: querystring param `api_key`
#   base: https://serpapi.com/search.json  (no endpoint_override is ever set)
#   query: api_key + per-domain params verbatim, plus a _t cache-bust counter.
# ---------------------------------------------------------------------------
def build_url(domain_cfg, api_key, trial_counter):
    tier = domain_cfg["tier"]
    base = tier.get("endpoint_override") or ENDPOINT
    params = dict(tier["params"])  # per-domain params verbatim (engine, q/k/etc.)
    params["api_key"] = api_key  # auth = querystring:api_key (NOT a header)
    # Cache-bust per recipe note ("vary query or _t param"); deterministic counter.
    params["_t"] = str(trial_counter)
    return base + "?" + urllib.parse.urlencode(params)


def fetch(url, timeout=60):
    """GET the SerpApi endpoint. Returns (body_text, ok). Never raises."""
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "wsa2026-serpapi-test/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace"), True
    except urllib.error.HTTPError as e:
        # Read the error body so verify can still inspect it if useful.
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return body, False
    except Exception as e:
        return "error: " + str(e), False


def unwrap(body_text):
    """
    Response unwrapping for serpapi: the response is structured JSON.
    Per recipe: stringify the WHOLE JSON response and verify substrings against it.
    If parsing fails (e.g. an HTML error page), fall back to the raw text.
    """
    try:
        obj = json.loads(body_text)
    except Exception:
        return body_text
    return json.dumps(obj, ensure_ascii=False)


def verify(body, verify_keys, need_at_least):
    """Count substring hits; PASS when hits >= need_at_least. IDENTICAL in both langs."""
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def run(trials):
    api_key = os.environ.get(AUTH_ENV)
    # Auth check BEFORE any request — never crash if unset.
    if not api_key:
        print("Set %s to run (see .env.example)" % AUTH_ENV)
        return 0

    print("SerpApi test — %d trial(s) per operational domain\n" % trials)

    results = {}
    trial_counter = 0  # global deterministic cache-bust counter

    # Stable ordering so output and JSON are reproducible.
    for domain in sorted(DOMAINS.keys()):
        cfg = DOMAINS[domain]

        if cfg["status"] == "genuine_fail":
            # genuine_fail domains: DO NOT make requests. Print one SKIP line.
            reason = cfg.get("reason_code", "genuine_fail")
            note = REASON_NOTES.get(reason, "no dedicated engine")
            print("SKIP %s: %s — %s" % (domain, reason, note))
            results[domain] = {
                "status": "genuine_fail",
                "reason_code": reason,
                "success_rate": 0,
                "avg_latency_ms": None,
                "cost_per_1k_usd": cfg.get("cost_per_1k_usd"),
                "cost_source": "frozen",
            }
            continue

        # operational domain — run N trials
        passes = 0
        latencies = []
        for _ in range(trials):
            trial_counter += 1
            url = build_url(cfg, api_key, trial_counter)
            t0 = time.time()
            body_text, ok = fetch(url)
            latency_ms = int((time.time() - t0) * 1000)
            latencies.append(latency_ms)
            body = unwrap(body_text)
            ok_verify, _hits = verify(body, cfg["verify_keys"], cfg["need_at_least"])
            if ok and ok_verify:
                passes += 1
            if PACE_SECONDS:
                time.sleep(PACE_SECONDS)

        sr = passes / trials if trials else 0.0
        avg_ms = int(sum(latencies) / len(latencies)) if latencies else None
        print("RUN  %-16s PASS %d/%d  SR %.0f%%  avg %sms"
              % (domain, passes, trials, sr * 100, avg_ms))
        results[domain] = {
            "status": "operational",
            "pass": passes,
            "trials": trials,
            "success_rate": round(sr, 4),
            "avg_latency_ms": avg_ms,
            "cost_per_1k_usd": cfg.get("cost_per_1k_usd"),
            "cost_source": "frozen",
        }

    write_results(results, trials)
    print_table(results)
    return 0


def write_results(results, trials):
    """Write ../../test-results/serpapi.run.json in the frozen-file schema."""
    operational = [d for d, r in results.items() if r["status"] == "operational"]
    genuine_fail = [d for d, r in results.items() if r["status"] == "genuine_fail"]

    op_srs = [results[d]["success_rate"] for d in operational]
    op_lats = [results[d]["avg_latency_ms"] for d in operational if results[d]["avg_latency_ms"] is not None]

    reachability_pct = round(100 * len(operational) / len(results)) if results else 0
    avg_success_rate = round(sum(op_srs) / len(op_srs), 4) if op_srs else None
    avg_latency_ms = int(sum(op_lats) / len(op_lats)) if op_lats else None

    summary = {
        "domains_total": len(results),
        "operational": len(operational),
        "genuine_fail": len(genuine_fail),
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        # cost not measured live — copied from frozen slice.
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,
        "avg_cost_source": "frozen",
        "avg_latency_ms": avg_latency_ms,
    }

    out = {
        "provider": PROVIDER,
        "report_date": REPORT_DATE,
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": results,
    }

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(here, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, PROVIDER + ".run.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print("\nWrote %s" % out_path)


def print_table(results):
    """Clean per-domain table: domain, status, SR, avg ms."""
    print("\n%-16s %-13s %6s %9s" % ("DOMAIN", "STATUS", "SR", "AVG MS"))
    print("-" * 48)
    for domain in sorted(results.keys()):
        r = results[domain]
        sr = r.get("success_rate")
        sr_str = ("%.0f%%" % (sr * 100)) if sr is not None else "-"
        avg = r.get("avg_latency_ms")
        avg_str = str(avg) if avg is not None else "-"
        print("%-16s %-13s %6s %9s" % (domain, r["status"], sr_str, avg_str))


def main():
    parser = argparse.ArgumentParser(description="SerpApi reachability/verification test")
    parser.add_argument("--trials", type=int, default=3, help="trials per operational domain (default 3)")
    args = parser.parse_args()
    trials = args.trials if args.trials and args.trials > 0 else 3
    sys.exit(run(trials))


if __name__ == "__main__":
    main()
