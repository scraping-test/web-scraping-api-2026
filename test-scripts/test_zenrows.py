#!/usr/bin/env python3
"""
test_zenrows.py — self-contained PASS/FAIL test for the ZenRows scraping API.

WHAT IT TESTS
  Probes 18 operational target domains (out of 20 total; 2 are known
  genuine failures and are skipped, not requested). For each operational
  domain it runs N trials through ZenRows, unwraps the response, and checks
  that the returned HTML contains at least `need_at_least` of the domain's
  `verify_keys` substrings. PASS = enough keys found.

HOW TO RUN
  set  ZENROWS_TOKEN=<your-api-key>     (PowerShell:  $env:ZENROWS_TOKEN="...")
  python test_zenrows.py                 # default 3 trials per domain
  python test_zenrows.py --trials 5      # custom trial count
  If ZENROWS_TOKEN is unset the script prints a hint and exits 0 (never crashes).

WHAT IT WRITES
  ../../test-results/zenrows.run.json  (relative to this script's location)
  Same schema as the frozen 2026 file: {provider, report_date, frozen:false,
  endpoint, auth_env, summary, domains}. success_rate / avg_latency_ms are
  measured live this run; cost is copied from the frozen slice
  ("cost_source":"frozen") because cost is not measured live.

PROVIDER NOTES (from the request recipe / quirks)
  - Transport: GET to https://api.zenrows.com/v1/ . Auth is a querystring
    param `apikey`. Target URL is the `url` param; tier params (js_render,
    premium_proxy, proxy_country, wait) are appended verbatim. Response is
    raw HTML — no JSON envelope to unwrap.
  - PACING QUIRK: after ~3 consecutive 4xx the API key soft-locks for ~60s.
    The runner backs off 60s after 3 consecutive 4xx responses to avoid
    cascading the lock. Developer plan is also conc=1; trials run serially.
  - No cache-busting param (that quirk applies only to firecrawl/serpapi).

Stdlib only. Python 3.8+.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROVIDER = "zenrows"
ENDPOINT = "https://api.zenrows.com/v1/"
AUTH_ENV = "ZENROWS_TOKEN"

# Frozen summary cost figure, copied through verbatim (cost is not measured live).
FROZEN_AVG_COST_PER_1K_USD = 2.18

# Pacing: after 3 consecutive 4xx the key soft-locks ~60s. Back off when we hit
# the threshold. (See request_recipe.note in the slice.)
SOFTLOCK_4XX_THRESHOLD = 3
SOFTLOCK_BACKOFF_S = 60
# Gentle spacing between requests on the conc=1 Developer plan.
INTER_REQUEST_PACE_S = 1.0
REQUEST_TIMEOUT_S = 90

# --------------------------------------------------------------------------
# DOMAINS table — literal values embedded from the slice (NOT read at runtime).
# Each entry: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), and reason_code for genuine_fail rows.
# --------------------------------------------------------------------------
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
        "cost_per_1k_usd": 0.28,
    },
    "bestbuy.com": {
        "status": "genuine_fail",
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
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
        "reason_code": "geo_fence_interstitial",
    },
    "bing.com": {
        "status": "operational",
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
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
        "cost_per_1k_usd": None,
    },
    "booking.com": {
        "status": "operational",
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "hp_hotel_name",
            "data-capla-component-boundary",
            '"@type" : "Hotel"',
            '"hotelId":',
            '"reviewCount"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
    },
    "capterra.com": {
        "status": "operational",
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {"params": {"js_render": "true"}, "endpoint_override": None},
        "verify_keys": [
            "<title>Slack Software Pricing",
            '"@type":"SoftwareApplication"',
            '"name":"Slack"',
            'data-testid="hero-section"',
            "/p/135003/Slack",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 1.4,
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {
            "params": {
                "premium_proxy": "true",
                "js_render": "true",
                "proxy_country": "us",
                # wait=8000 clears the "Pardon Our Interruption" splash (quirk).
                "wait": "8000",
            },
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
        "cost_per_1k_usd": 7,
    },
    "g2.com": {
        "status": "operational",
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "<title>Slack Reviews 2026",
            'itemprop="ratingValue"',
            'itemprop="reviewBody"',
            "products/slack/reviews",
            "Filter 39001 reviews",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
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
        "cost_per_1k_usd": 0.28,
    },
    "google.com": {
        "status": "operational",
        "url": "https://www.google.com/search?q=python+tutorial",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
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
        "cost_per_1k_usd": None,
    },
    "idealista.com": {
        "status": "operational",
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
            "endpoint_override": None,
        },
        "verify_keys": [
            'class="main-info__title-main"',
            'class="info-data-price"',
            "inmueble/110715434",
            "<title>Ático en venta",
            "Calle de Isabel la Católica",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
    },
    "indeed.com": {
        "status": "operational",
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
            'data-jk="',
            'class="job_seen_beacon',
            'data-testid="company-name"',
            'id="mosaic-provider-jobcards"',
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
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
        "reason_code": "requests_forbidden_policy",
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
        "cost_per_1k_usd": 0.28,
    },
    "reddit.com": {
        "status": "operational",
        "url": "https://old.reddit.com/r/programming/",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
            "endpoint_override": None,
        },
        "verify_keys": [
            'id="siteTable"',
            'data-fullname="t3_',
            'data-subreddit="programming"',
            'data-subreddit-prefixed="r/programming"',
            "<title>programming</title>",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
    },
    "tripadvisor.com": {
        "status": "operational",
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
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
        "cost_per_1k_usd": None,
    },
    "trustpilot.com": {
        "status": "operational",
        "url": "https://www.trustpilot.com/review/amazon.com",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true"},
            "endpoint_override": None,
        },
        "verify_keys": [
            "data-service-review-card-paper",
            "data-service-review-rating",
            '"@type":"Organization"',
            '"@type":"AggregateRating"',
            "data-business-unit-json-ld",
        ],
        "need_at_least": 2,
        "cost_per_1k_usd": 7,
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {
            "params": {"premium_proxy": "true", "proxy_country": "us"},
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
        "cost_per_1k_usd": 2.8,
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
        "cost_per_1k_usd": 0.28,
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
        "cost_per_1k_usd": 0.28,
    },
    "zillow.com": {
        "status": "operational",
        "url": "https://www.zillow.com/columbus-oh/",
        "tier": {
            "params": {"premium_proxy": "true", "js_render": "true", "proxy_country": "us"},
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
        "cost_per_1k_usd": None,
    },
}


# --------------------------------------------------------------------------
# Request builder — follows request_recipe EXACTLY:
#   GET https://api.zenrows.com/v1/?apikey=<KEY>&url=<targetUrl>&<tier params>
#   Auth is a querystring param. Returns raw HTML.
# endpoint_override is honored if a domain ever sets one (none do here).
# --------------------------------------------------------------------------
def build_request(token, domain_cfg):
    tier = domain_cfg["tier"]
    base = tier.get("endpoint_override") or ENDPOINT
    query = {"apikey": token, "url": domain_cfg["url"]}
    # Tier params appended verbatim (js_render, premium_proxy, proxy_country, wait).
    query.update(tier.get("params") or {})
    full_url = base + "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(full_url, method="GET")
    req.add_header("Accept", "*/*")
    return req


def fetch(token, domain_cfg):
    """Return (ok, status, body_text, latency_ms).

    ok is True only on HTTP 2xx. For ZenRows the body IS the target's raw HTML;
    there is no JSON envelope to unwrap.
    """
    req = build_request(token, domain_cfg)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            raw = resp.read()
            latency_ms = int((time.monotonic() - start) * 1000)
            text = raw.decode("utf-8", errors="replace")
            return True, resp.status, text, latency_ms
    except urllib.error.HTTPError as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        try:
            text = e.read().decode("utf-8", errors="replace")
        except Exception:
            text = ""
        return False, e.code, text, latency_ms
    except Exception as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        return False, 0, "ERROR: {}".format(e), latency_ms


# --------------------------------------------------------------------------
# verify — IDENTICAL rule to the TS file: count substring hits among
# verify_keys; PASS when hits >= need_at_least.
# --------------------------------------------------------------------------
def verify(body, verify_keys, need_at_least):
    if not body:
        return False, 0
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------
def run(token, trials):
    results = {}
    operational = [d for d, c in DOMAINS.items() if c["status"] == "operational"]
    skipped = [d for d, c in DOMAINS.items() if c["status"] != "operational"]

    consecutive_4xx = 0  # tracked across the whole run for the soft-lock backoff

    for domain in sorted(DOMAINS.keys()):
        cfg = DOMAINS[domain]

        if cfg["status"] != "operational":
            # genuine_fail: do NOT make requests. One SKIP line.
            note = SKIP_NOTES.get(cfg.get("reason_code"), "known non-technical failure")
            print("SKIP {}: {} — {}".format(domain, cfg.get("reason_code"), note))
            results[domain] = {
                "status": cfg["status"],
                "success_rate": 0.0,
                "avg_latency_ms": None,
                "reason_code": cfg.get("reason_code"),
                "cost_per_1k_usd": cfg.get("cost_per_1k_usd"),
                "cost_source": "frozen",
            }
            continue

        passes = 0
        latencies = []
        for t in range(trials):
            ok, status, body, latency_ms = fetch(token, cfg)
            latencies.append(latency_ms)

            if ok:
                consecutive_4xx = 0
                is_pass, hits = verify(body, cfg["verify_keys"], cfg["need_at_least"])
                if is_pass:
                    passes += 1
                print("  {} trial {}/{}: HTTP {} {}ms hits={} -> {}".format(
                    domain, t + 1, trials, status, latency_ms, hits,
                    "PASS" if is_pass else "fail"))
            else:
                # Track consecutive 4xx for the soft-lock backoff.
                if 400 <= status < 500:
                    consecutive_4xx += 1
                else:
                    consecutive_4xx = 0
                print("  {} trial {}/{}: HTTP {} {}ms -> request-fail".format(
                    domain, t + 1, trials, status, latency_ms))
                if consecutive_4xx >= SOFTLOCK_4XX_THRESHOLD:
                    # QUIRK: key soft-locks ~60s after ~3 consecutive 4xx; back off.
                    print("  [pace] {} consecutive 4xx — backing off {}s "
                          "(ZenRows soft-lock)".format(consecutive_4xx, SOFTLOCK_BACKOFF_S))
                    time.sleep(SOFTLOCK_BACKOFF_S)
                    consecutive_4xx = 0

            # Gentle pacing between requests (Developer plan conc=1).
            if not (domain == sorted(DOMAINS.keys())[-1] and t == trials - 1):
                time.sleep(INTER_REQUEST_PACE_S)

        success_rate = passes / trials if trials else 0.0
        avg_latency_ms = int(sum(latencies) / len(latencies)) if latencies else None
        results[domain] = {
            "status": "operational",
            "success_rate": success_rate,
            "avg_latency_ms": avg_latency_ms,
            "passes": passes,
            "trials": trials,
            "cost_per_1k_usd": cfg.get("cost_per_1k_usd"),
            "cost_source": "frozen",
        }

    return results, operational, skipped


SKIP_NOTES = {
    "geo_fence_interstitial": '"Select your Country" geo-fence; UX redirect, not a technical block',
    "requests_forbidden_policy": "REQS001 Requests forbidden every tier (live IG)",
}


def build_summary(results):
    operational = [r for r in results.values() if r["status"] == "operational"]
    total = len(results)
    reachable = len(operational)
    reachability_pct = round(100 * reachable / total) if total else 0
    if operational:
        avg_success_rate = sum(r["success_rate"] for r in operational) / len(operational)
        lat = [r["avg_latency_ms"] for r in operational if r["avg_latency_ms"] is not None]
        avg_latency_ms = int(sum(lat) / len(lat)) if lat else None
    else:
        avg_success_rate = 0.0
        avg_latency_ms = None
    return {
        "domains_total": total,
        "operational": reachable,
        "genuine_fail": total - reachable,
        "reachability_pct": reachability_pct,
        "avg_success_rate": round(avg_success_rate, 4),
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # frozen, not measured live
        "avg_latency_ms": avg_latency_ms,
        "cost_source": "frozen",
    }


def write_results(results, summary):
    # ../../test-results/ relative to this script (test-scripts/<provider>/).
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(here, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "{}.run.json".format(PROVIDER))
    payload = {
        "provider": PROVIDER,
        "report_date": time.strftime("%Y-%m-%d"),
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": results,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return out_path


def print_table(results):
    print("\n{:<18} {:<13} {:>6} {:>10}".format("DOMAIN", "STATUS", "SR", "AVG MS"))
    print("-" * 50)
    for domain in sorted(results.keys()):
        r = results[domain]
        sr = "{:.0%}".format(r["success_rate"])
        ms = "-" if r["avg_latency_ms"] is None else str(r["avg_latency_ms"])
        print("{:<18} {:<13} {:>6} {:>10}".format(domain, r["status"], sr, ms))


def main():
    parser = argparse.ArgumentParser(description="ZenRows per-domain PASS/FAIL test.")
    parser.add_argument("--trials", type=int, default=3, help="trials per operational domain")
    args = parser.parse_args()

    # Auth check BEFORE any request. Exit 0 (never crash) if missing.
    token = os.environ.get(AUTH_ENV)
    if not token:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        return 0

    print("ZenRows test — endpoint {} — {} trials/domain".format(ENDPOINT, args.trials))
    results, operational, skipped = run(token, args.trials)
    summary = build_summary(results)
    out_path = write_results(results, summary)
    print_table(results)

    print("\nsummary: {}/{} operational, reachability {}%, avg SR {:.1%}, avg {} ms".format(
        summary["operational"], summary["domains_total"], summary["reachability_pct"],
        summary["avg_success_rate"],
        "-" if summary["avg_latency_ms"] is None else summary["avg_latency_ms"]))
    print("wrote {}".format(out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
