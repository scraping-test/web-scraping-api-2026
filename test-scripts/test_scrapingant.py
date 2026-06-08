#!/usr/bin/env python3
"""Self-contained ScrapingAnt provider test (frozen 2026 baseline).

WHAT THIS TESTS
  Runs ScrapingAnt against a fixed set of 20 target domains and checks, per
  domain, whether the returned HTML contains enough of the expected "verify
  keys" to count as a successful scrape. It reproduces the exact request shape
  (tier params, endpoint, auth) that produced the frozen 2026 numbers so you can
  diff a fresh run against the baseline.

HOW TO RUN
  export SCRAPINGANT_TOKEN=<your_key>         # required; without it the script
                                              # prints a hint and exits 0
  python3 test_scrapingant.py                 # default 3 trials per domain
  python3 test_scrapingant.py --trials 5      # override trial count

  Stdlib only (urllib, json, os, sys, base64, argparse, time). Python 3.8+.
  No third-party packages, no shared imports across providers.

WHAT IT WRITES
  ../../test-results/scrapingant.run.json  (relative to this script's own dir,
  i.e. test-scripts/scrapingant/ -> ../../test-results/). Same schema as the
  frozen file: {provider, report_date, frozen:false, endpoint, auth_env,
  summary, domains}. avg_cost_per_1k_usd is copied from the frozen slice
  ("cost_source":"frozen") because cost is not measured live; success_rate and
  avg_latency_ms ARE measured this run.

PROVIDER QUIRKS BAKED IN (from the slice request_recipe + quirks)
  - Transport GET. Auth via querystring x-api-key=<KEY> (NOT a header).
  - Endpoint https://api.scrapingant.com/v2/general — returns RAW HTML (no JSON
    envelope to unwrap).
  - Query shape: x-api-key=<KEY>, url=<targetUrl>, plus tier params
    (browser, proxy_country, residential). Booleans are literal "true" strings.
  - PACING: >= 6s between calls. Per-key cooldown after ANY 4xx response — we
    DOUBLE the next inter-call interval after a 4xx (and reset to the floor once
    a clean response comes back). This is the documented per-key rate-limit
    quirk: bursting after a 4xx keeps you throttled.
  - Wide target-side failure surface: g2, idealista, linkedin, tripadvisor,
    trustpilot all return 423 on every config (genuine_fail, never requested).
  - High latency is normal: many domains average 30-60s (booking, capterra,
    indeed, zillow), so the request timeout is generous.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROVIDER = "scrapingant"
# Per the recipe: base is /v2 and the scrape endpoint is /v2/general.
ENDPOINT = "https://api.scrapingant.com/v2/general"
AUTH_ENV = "SCRAPINGANT_TOKEN"
REPORT_DATE = "2026-06-08"  # today (frozen-compatible)

# avg_cost_per_1k_usd from the frozen slice summary; cost is NOT measured live.
FROZEN_AVG_COST_PER_1K_USD = 2.3

# --- Pacing (recipe quirk) ---------------------------------------------------
# >= 6s between calls. After ANY 4xx, the per-key cooldown kicks in: we DOUBLE
# the next interval. It resets to the floor after a clean (non-4xx) response.
PACE_FLOOR_SECONDS = 6.0
# Generous timeout: booking/capterra/indeed/zillow average 56-58s in the frozen run.
TIMEOUT_SECONDS = 120

# --- DOMAINS table: literal values embedded from the slice (do NOT read slice at runtime) ---
# Each entry: url, tier{params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), and reason_code for genuine_fail rows.
DOMAINS = {
    "amazon.com": {
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["productTitle", "id=\"dp-container\"", "id=\"centerCol\"",
                        "data-asin=\"B07FZ8S74R\"", "nav-logo-base"],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "bestbuy.com": {
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "tier": {"params": {"browser": "true"}, "endpoint_override": None},
        "verify_keys": ["application/ld+json", "\"@type\":\"Product\"", "\"sku\":\"6570601\"",
                        "\"customerPrice\"", "add-to-cart-button"],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 1.9,
    },
    "bing.com": {
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["<title>best laptops 2025 - Search</title>", "id=\"b_content\"",
                        "id=\"sb_form\"", "class=\"b_algo", "class=\"b_attribution"],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "booking.com": {
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["hp_hotel_name", "data-capla-component-boundary", "\"@type\" : \"Hotel\"",
                        "\"hotelId\":", "\"reviewCount\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "capterra.com": {
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["<title>Slack Software Pricing", "\"@type\":\"SoftwareApplication\"",
                        "\"name\":\"Slack\"", "data-testid=\"hero-section\"", "/p/135003/Slack"],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "ebay.com": {
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["itm.ebaydesc.com", "ebayLogoTitle", "\"product\":",
                        "p.ebaystatic.com", "\"@type\":\"Product\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "g2.com": {
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["<title>Slack Reviews 2026", "itemprop=\"ratingValue\"",
                        "itemprop=\"reviewBody\"", "products/slack/reviews", "Filter 39001 reviews"],
        "need_at_least": 2,
        "status": "genuine_fail",
        "reason_code": "browser_detected_423",
        "cost_per_1k_usd": None,
    },
    "github.com": {
        "url": "https://github.com/microsoft/vscode",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["<title>GitHub - microsoft/vscode", "data-testid=\"latest-commit-details\"",
                        "data-testid=\"view-all-files-row\"", "id=\"repository-container-header\"",
                        "github.com/microsoft/vscode"],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "google.com": {
        "url": "https://www.google.com/search?q=python+tutorial",
        # T5-v2-deluxe (125cr): browser + residential proxy.
        "tier": {"params": {"browser": "true", "residential": "true"}, "endpoint_override": None},
        "verify_keys": ["id=\"search\"", "id=\"rso\"", "id=\"rcnt\"",
                        "<title>python tutorial - Google Search</title>",
                        "itemtype=\"http://schema.org/SearchResultsPage\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 23.75,
    },
    "idealista.com": {
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["class=\"main-info__title-main\"", "class=\"info-data-price\"",
                        "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
        "need_at_least": 2,
        "status": "genuine_fail",
        "reason_code": "browser_detected_423",
        "cost_per_1k_usd": None,
    },
    "indeed.com": {
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
                        "data-jk=\"", "class=\"job_seen_beacon", "data-testid=\"company-name\"",
                        "id=\"mosaic-provider-jobcards\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "instagram.com": {
        "url": "https://www.instagram.com/nike/",
        # T5-browser-resUS: browser + US proxy_country (recovered at 30-trial lock-in).
        "tier": {"params": {"browser": "true", "proxy_country": "US"}, "endpoint_override": None},
        "verify_keys": ["\"username\":\"nike\"", "<title>Nike (&#064;nike)",
                        "instagram://user?username=nike", "href=\"https://www.instagram.com/nike/\"",
                        "og:type\" content=\"profile\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": None,
    },
    "linkedin.com": {
        "url": "https://www.linkedin.com/company/microsoft/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["<title>Microsoft | LinkedIn</title>", "\"@type\":\"Organization\"",
                        "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
        "need_at_least": 2,
        "status": "genuine_fail",
        "reason_code": "browser_detected_423",
        "cost_per_1k_usd": None,
    },
    "reddit.com": {
        "url": "https://old.reddit.com/r/programming/",
        # T5-browser-resUS: browser + US proxy_country (recovered).
        "tier": {"params": {"browser": "true", "proxy_country": "US"}, "endpoint_override": None},
        "verify_keys": ["id=\"siteTable\"", "data-fullname=\"t3_", "data-subreddit=\"programming\"",
                        "data-subreddit-prefixed=\"r/programming\"", "<title>programming</title>"],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": None,
    },
    "tripadvisor.com": {
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["Fairmont", "THE PLAZA NEW YORK", "\"@type\":\"LodgingBusiness\"",
                        "\"aggregateRating\"", "data-automation"],
        "need_at_least": 2,
        "status": "genuine_fail",
        "reason_code": "browser_detected_423",
        "cost_per_1k_usd": None,
    },
    "trustpilot.com": {
        "url": "https://www.trustpilot.com/review/amazon.com",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["data-service-review-card-paper", "data-service-review-rating",
                        "\"@type\":\"Organization\"", "\"@type\":\"AggregateRating\"",
                        "data-business-unit-json-ld"],
        "need_at_least": 2,
        "status": "genuine_fail",
        "reason_code": "browser_detected_423",
        "cost_per_1k_usd": None,
    },
    "walmart.com": {
        "url": "https://www.walmart.com/ip/604342441",
        # T5-browser-resUS: browser + US proxy_country (recovered).
        "tier": {"params": {"browser": "true", "proxy_country": "US"}, "endpoint_override": None},
        "verify_keys": ["<title>Apple, AirPods with Charging Case", "\"itemId\":\"604342441\"",
                        "data-testid=\"price-wrap\"", "id=\"__NEXT_DATA__\"",
                        "data-testid=\"hero-image-container\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": None,
    },
    "x.com": {
        "url": "https://x.com/elonmusk",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["elonmusk", "Elon Musk", "44196397", "react-root", "data-testid=\"tweet\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "youtube.com": {
        "url": "https://www.youtube.com/@MrBeast",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["\"channelMetadataRenderer\"", "\"externalId\":\"UCX6OQ3DkcsbYNE6H8uQQuVA\"",
                        "ytInitialData", "\"title\":\"MrBeast\"", "\"subscriberCountText\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
    "zillow.com": {
        "url": "https://www.zillow.com/columbus-oh/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["data-testid=\"property-card\"", "\"zpid\":",
                        "\"@type\":\"SingleFamilyResidence\"", "\"streetAddress\"", "\"bedrooms\""],
        "need_at_least": 2,
        "status": "operational",
        "cost_per_1k_usd": 0.19,
    },
}

# Short human-readable notes for SKIP lines on genuine_fail domains.
REASON_NOTES = {
    "browser_detected_423": "target-side anti-bot returns 423 on every config",
}


def build_request(target_url, params):
    """Build a urllib Request following the recipe EXACTLY.

    Transport GET. Auth = querystring x-api-key (NOT a header). Query shape:
      x-api-key=<KEY>, url=<targetUrl>, plus tier params.
    Endpoint https://api.scrapingant.com/v2/general. Returns RAW HTML — no
    JSON envelope.
    """
    token = os.environ[AUTH_ENV]
    query = {"x-api-key": token, "url": target_url}
    # Tier params (browser, proxy_country, residential) as literal "true"/"US" strings.
    query.update(params)
    qs = urllib.parse.urlencode(query)
    full_url = ENDPOINT + "?" + qs
    return urllib.request.Request(full_url, method="GET")


def unwrap(raw_bytes):
    """Response unwrapping for ScrapingAnt: the /v2/general body is RAW HTML, no
    JSON envelope. Decode bytes -> str (utf-8, replace errors)."""
    if isinstance(raw_bytes, bytes):
        return raw_bytes.decode("utf-8", errors="replace")
    return raw_bytes


def verify(body, verify_keys, need_at_least):
    """Count substring hits in body; PASS when hits >= need_at_least.
    IDENTICAL rule to the TypeScript port."""
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run_trial(target_url, params):
    """Single request. Returns (body_text, latency_ms, got_4xx).

    got_4xx drives the per-key cooldown: after any 4xx the caller doubles the
    next inter-call interval. The runner does verification on the returned body.
    """
    req = build_request(target_url, params)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            raw = resp.read()
        latency_ms = int((time.monotonic() - start) * 1000)
        return unwrap(raw), latency_ms, False
    except urllib.error.HTTPError as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        got_4xx = 400 <= e.code < 500
        # Read the error body too — some gateways return useful HTML on 4xx/5xx.
        try:
            body = unwrap(e.read())
        except Exception:
            body = ""
        return body, latency_ms, got_4xx
    except Exception:
        latency_ms = int((time.monotonic() - start) * 1000)
        return "", latency_ms, False


def main():
    parser = argparse.ArgumentParser(description="ScrapingAnt provider test (frozen 2026 baseline).")
    parser.add_argument("--trials", type=int, default=3, help="Trials per operational domain (default 3).")
    args = parser.parse_args()

    trials = max(1, args.trials)

    # AUTH check BEFORE any request: never crash if env var is unset.
    if not os.environ.get(AUTH_ENV):
        print(f"Set {AUTH_ENV} to run (see .env.example)")
        sys.exit(0)

    print(f"ScrapingAnt test — {trials} trials/domain, pacing >= {PACE_FLOOR_SECONDS}s "
          f"(doubles after any 4xx)\n")

    results = {}
    operational_count = 0
    skipped_count = 0

    # Per-key cooldown state: current interval starts at the floor and doubles
    # after any 4xx, resetting to the floor after a clean response.
    pace_seconds = PACE_FLOOR_SECONDS
    first_request = True

    for domain, cfg in DOMAINS.items():
        status = cfg["status"]
        if status == "genuine_fail":
            # genuine_fail: DO NOT make requests. One SKIP line.
            reason = cfg.get("reason_code", "unknown")
            note = REASON_NOTES.get(reason, "")
            print(f"SKIP {domain}: {reason} — {note}")
            results[domain] = {
                "status": "genuine_fail",
                "reason_code": reason,
                "success_rate": 0,
                "avg_latency_ms": None,
                "cost_per_1k_usd": cfg.get("cost_per_1k_usd"),
            }
            skipped_count += 1
            continue

        operational_count += 1
        tier_params = cfg["tier"]["params"]
        passes = 0
        latencies = []
        for t in range(trials):
            # Pace before every request except the very first. The interval is
            # the current per-key cooldown (>= floor, doubled after a 4xx).
            if not first_request:
                time.sleep(pace_seconds)
            first_request = False

            body, latency_ms, got_4xx = run_trial(cfg["url"], tier_params)
            latencies.append(latency_ms)

            passed, hits = verify(body, cfg["verify_keys"], cfg["need_at_least"]) if body else (False, 0)
            if passed:
                passes += 1

            print(f"  {domain:<16} trial {t + 1}/{trials}: "
                  f"{'PASS' if passed else 'FAIL'} ({hits} hits, {latency_ms} ms"
                  f"{', 4xx' if got_4xx else ''})")

            # Per-key cooldown: double after a 4xx, otherwise reset to the floor.
            if got_4xx:
                pace_seconds = min(pace_seconds * 2, 60.0)
            else:
                pace_seconds = PACE_FLOOR_SECONDS

        success_rate = passes / trials if trials else 0
        avg_latency = int(sum(latencies) / len(latencies)) if latencies else None
        results[domain] = {
            "status": "operational",
            "pass": passes,
            "trials": trials,
            "success_rate": round(success_rate, 4),
            "avg_latency_ms": avg_latency,
            "cost_per_1k_usd": cfg.get("cost_per_1k_usd"),
        }

    # ---- summary (same method as frozen) ----
    op_rows = [r for r in results.values() if r["status"] == "operational"]
    avg_success_rate = (
        round(sum(r["success_rate"] for r in op_rows) / len(op_rows), 4) if op_rows else 0
    )
    op_latencies = [r["avg_latency_ms"] for r in op_rows if r["avg_latency_ms"] is not None]
    avg_latency_ms = int(sum(op_latencies) / len(op_latencies)) if op_latencies else None
    domains_total = len(DOMAINS)
    reachability_pct = round(operational_count / domains_total * 100) if domains_total else 0

    summary = {
        "domains_total": domains_total,
        "operational": operational_count,
        "genuine_fail": skipped_count,
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,
        "cost_source": "frozen",
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

    # ---- write results JSON relative to THIS script: -> ../../test-results/ ----
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(script_dir, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{PROVIDER}.run.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # ---- clean per-domain table to stdout ----
    print()
    print(f"{'domain':<18} {'status':<13} {'SR':>6} {'avg ms':>9}")
    print("-" * 48)
    for domain, r in results.items():
        sr = f"{r['success_rate'] * 100:.0f}%"
        ms = "-" if r["avg_latency_ms"] is None else str(r["avg_latency_ms"])
        print(f"{domain:<18} {r['status']:<13} {sr:>6} {ms:>9}")
    print("-" * 48)
    print(f"reachability {summary['reachability_pct']}%  "
          f"avg SR {summary['avg_success_rate'] * 100:.1f}%  "
          f"avg latency {summary['avg_latency_ms']}ms")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
