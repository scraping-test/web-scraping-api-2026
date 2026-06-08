#!/usr/bin/env python3
"""
test_scrapfly.py — Self-contained reachability/verification test for the Scrapfly
web-scraping API, frozen against the 2026-06-08 benchmark numbers.

WHAT IT TESTS
    For each of the 20 target domains in the frozen Scrapfly tier table, it issues
    N trials (default 3) through the Scrapfly /scrape endpoint using that domain's
    exact tier params (render_js / asp / country / proxy_pool), unwraps the JSON
    envelope (result.content holds the rendered HTML), and verifies the HTML contains
    at least `need_at_least` of the domain's verify_keys substrings. PASS when
    hits >= need_at_least.

HOW TO RUN
    pip:        none — Python 3.8+ standard library only.
    auth:       export SCRAPFLY_TOKEN=<your scrapfly api key>   (Windows: set SCRAPFLY_TOKEN=...)
    run:        python test_scrapfly.py
    more trials python test_scrapfly.py --trials 5
    If SCRAPFLY_TOKEN is unset the script prints a hint and exits 0 (never crashes).

WHAT IT WRITES
    ../../test-results/scrapfly.run.json  (relative to this file's location)
    Same schema as the frozen file: {provider, report_date, frozen:false, endpoint,
    auth_env, summary, domains}. success_rate + avg_latency_ms are measured live this
    run; avg_cost_per_1k_usd is copied from the frozen slice ("cost_source":"frozen").
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROVIDER = "scrapfly"
ENDPOINT = "https://api.scrapfly.io/scrape"
AUTH_ENV = "SCRAPFLY_TOKEN"
REPORT_DATE = "2026-06-08"  # today

# ---------------------------------------------------------------------------
# DOMAINS table — literal values embedded from the frozen slice. NOT read at runtime.
# Each row carries: url, tier (params + endpoint_override), verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen, for cost reporting), and reason_code for genuine_fail
# rows. Scrapfly's 2026 slice has zero genuine_fail rows — all 20 are operational.
# ---------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "params": {"proxy_pool": "public_residential_pool", "country": "us"},
        "endpoint_override": None,
        "verify_keys": ["productTitle", "id=\"dp-container\"", "id=\"centerCol\"",
                        "data-asin=\"B07FZ8S74R\"", "nav-logo-base"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.75,
        "reason_code": None,
    },
    "bestbuy.com": {
        "status": "operational",
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "params": {"proxy_pool": "public_residential_pool"},
        "endpoint_override": None,
        "verify_keys": ["application/ld+json", "\"@type\":\"Product\"", "\"sku\":\"6570601\"",
                        "\"customerPrice\"", "add-to-cart-button"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.375,
        "reason_code": None,
    },
    "bing.com": {
        "status": "operational",
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "params": {},
        "endpoint_override": None,
        "verify_keys": ["<title>best laptops 2025 - Search</title>", "id=\"b_content\"",
                        "id=\"sb_form\"", "class=\"b_algo", "class=\"b_attribution"],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.15,
        "reason_code": None,
    },
    "booking.com": {
        "status": "operational",
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        # T5: asp+render+residential — lower tiers return upstream 202.
        "params": {"asp": "true", "render_js": "true", "proxy_pool": "public_residential_pool"},
        "endpoint_override": None,
        "verify_keys": ["hp_hotel_name", "data-capla-component-boundary", "\"@type\" : \"Hotel\"",
                        "\"hotelId\":", "\"reviewCount\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.065,
        "reason_code": None,
    },
    "capterra.com": {
        "status": "operational",
        "url": "https://www.capterra.com/p/135003/Slack/",
        "params": {"asp": "true", "country": "us"},
        "endpoint_override": None,
        "verify_keys": ["<title>Slack Software Pricing", "\"@type\":\"SoftwareApplication\"",
                        "\"name\":\"Slack\"", "data-testid=\"hero-section\"", "/p/135003/Slack"],
        "need_at_least": 2,
        "cost_per_1k_usd": 6.757,
        "reason_code": None,
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "params": {"render_js": "true"},
        "endpoint_override": None,
        "verify_keys": ["itm.ebaydesc.com", "ebayLogoTitle", "\"product\":",
                        "p.ebaystatic.com", "\"@type\":\"Product\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.825,
        "reason_code": None,
    },
    "g2.com": {
        "status": "operational",
        "url": "https://www.g2.com/products/slack/reviews",
        # ASP shield = 40cr (datadome). asp=true is required for shielded g2.
        "params": {"asp": "true"},
        "endpoint_override": None,
        "verify_keys": ["<title>Slack Reviews 2026", "itemprop=\"ratingValue\"",
                        "itemprop=\"reviewBody\"", "products/slack/reviews", "Filter 39001 reviews"],
        "need_at_least": 2,
        "cost_per_1k_usd": 6.0,
        "reason_code": None,
    },
    "github.com": {
        "status": "operational",
        "url": "https://github.com/microsoft/vscode",
        # T1 basic params, but Scrapfly auto-routes github through residential (25cr).
        "params": {},
        "endpoint_override": None,
        "verify_keys": ["<title>GitHub - microsoft/vscode", "data-testid=\"latest-commit-details\"",
                        "data-testid=\"view-all-files-row\"", "id=\"repository-container-header\"",
                        "github.com/microsoft/vscode"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.75,
        "reason_code": None,
    },
    "google.com": {
        "status": "operational",
        "url": "https://www.google.com/search?q=python+tutorial",
        # Pin country=us to defeat geo-routing roulette on the datacenter pool.
        "params": {"render_js": "true", "country": "us"},
        "endpoint_override": None,
        "verify_keys": ["id=\"search\"", "id=\"rso\"", "id=\"rcnt\"",
                        "<title>python tutorial - Google Search</title>",
                        "itemtype=\"http://schema.org/SearchResultsPage\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.9,
        "reason_code": None,
    },
    "idealista.com": {
        "status": "operational",
        "url": "https://www.idealista.com/inmueble/110715434/",
        "params": {"asp": "true"},
        "endpoint_override": None,
        "verify_keys": ["class=\"main-info__title-main\"", "class=\"info-data-price\"",
                        "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.075,
        "reason_code": None,
    },
    "indeed.com": {
        "status": "operational",
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        # Use residential; avoid asp here (cloudflare_indeed shield surcharge → 80cr).
        "params": {"proxy_pool": "public_residential_pool"},
        "endpoint_override": None,
        "verify_keys": ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
                        "data-jk=\"", "class=\"job_seen_beacon", "data-testid=\"company-name\"",
                        "id=\"mosaic-provider-jobcards\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.75,
        "reason_code": None,
    },
    "instagram.com": {
        "status": "operational",
        "url": "https://www.instagram.com/nike/",
        "params": {},
        "endpoint_override": None,
        "verify_keys": ["\"username\":\"nike\"", "<title>Nike (&#064;nike)",
                        "instagram://user?username=nike",
                        "href=\"https://www.instagram.com/nike/\"",
                        "og:type\" content=\"profile\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.15,
        "reason_code": None,
    },
    "linkedin.com": {
        "status": "operational",
        "url": "https://www.linkedin.com/company/microsoft/",
        # T1 basic but LinkedIn carries a +25cr domain surcharge (26cr/req).
        "params": {},
        "endpoint_override": None,
        "verify_keys": ["<title>Microsoft | LinkedIn</title>", "\"@type\":\"Organization\"",
                        "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.9,
        "reason_code": None,
    },
    "reddit.com": {
        "status": "operational",
        "url": "https://old.reddit.com/r/programming/",
        "params": {"asp": "true"},
        "endpoint_override": None,
        "verify_keys": ["id=\"siteTable\"", "data-fullname=\"t3_", "data-subreddit=\"programming\"",
                        "data-subreddit-prefixed=\"r/programming\"", "<title>programming</title>"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.675,
        "reason_code": None,
    },
    "tripadvisor.com": {
        "status": "operational",
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        # residential; tripadvisor carries a +10cr domain surcharge.
        "params": {"proxy_pool": "public_residential_pool"},
        "endpoint_override": None,
        "verify_keys": ["Fairmont", "THE PLAZA NEW YORK", "\"@type\":\"LodgingBusiness\"",
                        "\"aggregateRating\"", "data-automation"],
        "need_at_least": 2,
        "cost_per_1k_usd": 4.515,
        "reason_code": None,
    },
    "trustpilot.com": {
        "status": "operational",
        "url": "https://www.trustpilot.com/review/amazon.com",
        "params": {"asp": "true"},
        "endpoint_override": None,
        "verify_keys": ["data-service-review-card-paper", "data-service-review-rating",
                        "\"@type\":\"Organization\"", "\"@type\":\"AggregateRating\"",
                        "data-business-unit-json-ld"],
        "need_at_least": 2,
        "cost_per_1k_usd": 3.75,
        "reason_code": None,
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "params": {"asp": "true", "country": "us"},
        "endpoint_override": None,
        "verify_keys": ["<title>Apple, AirPods with Charging Case", "\"itemId\":\"604342441\"",
                        "data-testid=\"price-wrap\"", "id=\"__NEXT_DATA__\"",
                        "data-testid=\"hero-image-container\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.15,
        "reason_code": None,
    },
    "x.com": {
        "status": "operational",
        "url": "https://x.com/elonmusk",
        "params": {},
        "endpoint_override": None,
        "verify_keys": ["elonmusk", "Elon Musk", "44196397", "react-root", "data-testid=\"tweet\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.15,
        "reason_code": None,
    },
    "youtube.com": {
        "status": "operational",
        "url": "https://www.youtube.com/@MrBeast",
        "params": {},
        "endpoint_override": None,
        "verify_keys": ["\"channelMetadataRenderer\"", "\"externalId\":\"UCX6OQ3DkcsbYNE6H8uQQuVA\"",
                        "ytInitialData", "\"title\":\"MrBeast\"", "\"subscriberCountText\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.15,
        "reason_code": None,
    },
    "zillow.com": {
        "status": "operational",
        "url": "https://www.zillow.com/columbus-oh/",
        # render+us; pinning country=us stabilizes geo-routing.
        "params": {"render_js": "true", "country": "us"},
        "endpoint_override": None,
        "verify_keys": ["data-testid=\"property-card\"", "\"zpid\":",
                        "\"@type\":\"SingleFamilyResidence\"", "\"streetAddress\"", "\"bedrooms\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 0.9,
        "reason_code": None,
    },
}

# Frozen summary cost — copied from slice; cost is NOT measured live.
FROZEN_AVG_COST_PER_1K_USD = 2.69

# Scrapfly rate-limit quirk: credit-based API, generous concurrency but be polite
# between requests so we don't trip the per-account concurrency cap during a burst.
PACING_SECONDS = 1.0

REQUEST_TIMEOUT = 90  # seconds; asp+render_js domains can take >7s server-side.


def build_request(api_key, domain_cfg):
    """Build a urllib Request following Scrapfly's recipe EXACTLY.

    Recipe: transport=GET, auth=querystring 'key', base=https://api.scrapfly.io/scrape.
    Query = key=<KEY>, url=<targetUrl>, plus the domain's tier params verbatim
    (render_js / asp / country / proxy_pool). endpoint_override, when set, replaces
    the base URL (always null for scrapfly in this slice).
    """
    base = domain_cfg.get("endpoint_override") or ENDPOINT
    query = {"key": api_key, "url": domain_cfg["url"]}
    # Tier params are flat key/value strings ("true", "us", "public_residential_pool").
    query.update(domain_cfg["params"])
    full_url = base + "?" + urllib.parse.urlencode(query)
    return urllib.request.Request(full_url, method="GET")


def unwrap_response(raw_bytes):
    """Unwrap Scrapfly's JSON envelope: the HTML lives at result.content.

    Returns the HTML string, or "" if the envelope is missing/malformed.
    """
    try:
        env = json.loads(raw_bytes.decode("utf-8", errors="replace"))
    except (ValueError, AttributeError):
        return ""
    result = env.get("result") if isinstance(env, dict) else None
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, str):
            return content
    return ""


def verify(body, verify_keys, need_at_least):
    """Count how many verify_keys appear as substrings of body.

    PASS when hits >= need_at_least. IDENTICAL rule in the TS port.
    """
    if not body:
        return False, 0
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


def run_domain(api_key, domain, cfg, trials):
    """Run `trials` requests for one operational domain. Returns a result dict."""
    passes = 0
    latencies = []
    last_err = None
    for _ in range(trials):
        req = build_request(api_key, cfg)
        start = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                raw = resp.read()
            elapsed_ms = int((time.monotonic() - start) * 1000)
            latencies.append(elapsed_ms)
            html = unwrap_response(raw)
            ok, _hits = verify(html, cfg["verify_keys"], cfg["need_at_least"])
            if ok:
                passes += 1
        except urllib.error.HTTPError as e:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            latencies.append(elapsed_ms)
            # Scrapfly returns the envelope even on some error statuses; try to verify it.
            try:
                body = e.read()
                html = unwrap_response(body)
                ok, _hits = verify(html, cfg["verify_keys"], cfg["need_at_least"])
                if ok:
                    passes += 1
            except Exception as inner:  # noqa: BLE001
                last_err = "HTTP {}: {}".format(e.code, inner)
            else:
                last_err = "HTTP {}".format(e.code)
        except Exception as e:  # noqa: BLE001 — network/timeout etc.; count as a miss.
            elapsed_ms = int((time.monotonic() - start) * 1000)
            latencies.append(elapsed_ms)
            last_err = str(e)
        time.sleep(PACING_SECONDS)  # pace per credit-based concurrency quirk

    success_rate = passes / trials if trials else 0.0
    avg_latency = int(round(sum(latencies) / len(latencies))) if latencies else 0
    return {
        "status": cfg["status"],
        "passes": passes,
        "trials": trials,
        "success_rate": success_rate,
        "avg_latency_ms": avg_latency,
        "cost_per_1k_usd": cfg["cost_per_1k_usd"],
        "cost_source": "frozen",
        "last_error": last_err,
    }


def main():
    parser = argparse.ArgumentParser(description="Scrapfly per-domain reachability test.")
    parser.add_argument("--trials", type=int, default=3, help="trials per operational domain (default 3)")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # AUTH: read env BEFORE any request. Unset -> hint + exit 0 (never crash).
    api_key = os.environ.get(AUTH_ENV)
    if not api_key:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        sys.exit(0)

    print("scrapfly — {} domains, {} trial(s) each".format(len(DOMAINS), trials))
    print("-" * 64)

    results = {}
    operational_count = 0
    skipped_count = 0

    for domain, cfg in DOMAINS.items():
        if cfg["status"] != "operational":
            # genuine_fail: DO NOT request. One SKIP line. (None present for scrapfly.)
            skipped_count += 1
            reason = cfg.get("reason_code") or "genuine_fail"
            print("SKIP {}: {} — not requested (frozen genuine_fail)".format(domain, reason))
            results[domain] = {
                "status": cfg["status"],
                "reason_code": cfg.get("reason_code"),
                "success_rate": 0.0,
                "avg_latency_ms": 0,
                "cost_per_1k_usd": cfg["cost_per_1k_usd"],
                "cost_source": "frozen",
            }
            continue

        operational_count += 1
        res = run_domain(api_key, domain, cfg, trials)
        results[domain] = res
        verdict = "PASS" if res["passes"] == trials else ("PARTIAL" if res["passes"] > 0 else "FAIL")
        print("{:<16} {:<7} {}/{}  SR={:.2f}  {} ms".format(
            domain, verdict, res["passes"], trials, res["success_rate"], res["avg_latency_ms"]))

    # ----- summary -----
    op_rows = [r for r in results.values() if r["status"] == "operational"]
    reachability_pct = round(100.0 * operational_count / len(DOMAINS), 1) if DOMAINS else 0.0
    avg_success_rate = round(sum(r["success_rate"] for r in op_rows) / len(op_rows), 4) if op_rows else 0.0
    all_lat = [r["avg_latency_ms"] for r in op_rows if r["avg_latency_ms"]]
    avg_latency_ms = int(round(sum(all_lat) / len(all_lat))) if all_lat else 0

    summary = {
        "domains_total": len(DOMAINS),
        "operational": operational_count,
        "genuine_fail": skipped_count,
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # frozen — cost not measured live
        "avg_latency_ms": avg_latency_ms,
    }

    # ----- build domains output block -----
    out_domains = {}
    for domain, r in results.items():
        block = {
            "status": r["status"],
            "success_rate": r["success_rate"],
            "avg_latency_ms": r["avg_latency_ms"],
            "cost_per_1k_usd": r["cost_per_1k_usd"],
            "cost_source": "frozen",
        }
        if r["status"] == "operational":
            block["passes"] = r["passes"]
            block["trials"] = r["trials"]
        else:
            block["reason_code"] = r.get("reason_code")
        out_domains[domain] = block

    report = {
        "provider": PROVIDER,
        "report_date": REPORT_DATE,
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": out_domains,
    }

    # ----- write ../../test-results/scrapfly.run.json relative to THIS file -----
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(here, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "{}.run.json".format(PROVIDER))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("-" * 64)
    print("reachability={}%  avg_SR={:.4f}  avg_latency={} ms".format(
        summary["reachability_pct"], summary["avg_success_rate"], summary["avg_latency_ms"]))
    print("wrote {}".format(out_path))


if __name__ == "__main__":
    main()
