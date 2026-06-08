#!/usr/bin/env python3
"""
test_brightdata.py — self-contained live test for the Bright Data Web Unlocker API.

WHAT THIS TESTS
  Fetches 20 real-world target pages (amazon, google, linkedin, zillow, ...) through
  Bright Data's Unlocker / SERP product and checks that the returned raw HTML actually
  contains domain-specific markers (verify_keys). This catches the well-known failure
  mode where Bright Data returns HTTP 200 with an "Access denied" / challenge page that
  *looks* successful — see request_recipe note in the slice. We only count a trial as a
  PASS when at least `need_at_least` of the verify_keys are present in the body.

HOW TO RUN
  export BRIGHTDATA_TOKEN=<your-api-token>          # Windows: set BRIGHTDATA_TOKEN=...
  python test_brightdata.py                          # 3 trials per domain (default)
  python test_brightdata.py --trials 5               # custom trial count

  Pure standard library, Python 3.8+. No pip installs.

WHAT IT WRITES
  ../../test-results/brightdata.run.json  (relative to this script's own location)
  Same schema as the frozen 2026 file so you can diff measured-vs-frozen numbers.
  Cost is NOT measured live — it is copied from the frozen slice and tagged
  "cost_source":"frozen".

REQUEST SHAPE (per slice request_recipe — Bright Data /request endpoint)
  POST https://api.brightdata.com/request
  Authorization: Bearer <BRIGHTDATA_TOKEN>
  Content-Type: application/json
  Body: {"zone": <zone>, "url": <targetUrl>, "format": "raw", ...per-domain params}
  Response: the raw HTML body of the target page (NOT a JSON envelope).
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# ----------------------------------------------------------------------------
# Provider constants (embedded literally from the slice — NOT read at runtime).
# ----------------------------------------------------------------------------
PROVIDER = "brightdata"
ENDPOINT = "https://api.brightdata.com"          # slice.endpoint (top-level identity)
AUTH_ENV = "BRIGHTDATA_TOKEN"                     # slice.auth_env
REPORT_DATE = "2026-06-08"                        # today (frozen run date for this tool)

# Frozen summary cost figure — cost is not measurable live, copied verbatim.
FROZEN_AVG_COST_PER_1K_USD = 1.55

# ----------------------------------------------------------------------------
# DOMAINS table — literal values lifted from the slice "domains" object.
# Each entry: url, tier {params, endpoint_override}, verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), and reason_code (only for genuine_fail rows).
# brightdata has 0 genuine_fail rows, so reason_code is None everywhere here.
# ----------------------------------------------------------------------------
DOMAINS = {
    "amazon.com": {
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "tier": {"params": {"zone": "unlocker", "country": "us"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["productTitle", "id=\"dp-container\"", "id=\"centerCol\"",
                        "data-asin=\"B07FZ8S74R\"", "nav-logo-base"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "bestbuy.com": {
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "tier": {"params": {"zone": "unlocker", "country": "us"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["application/ld+json", "\"@type\":\"Product\"", "\"sku\":\"6570601\"",
                        "\"customerPrice\"", "add-to-cart-button"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 2.5,
    },
    "bing.com": {
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>best laptops 2025 - Search</title>", "id=\"b_content\"",
                        "id=\"sb_form\"", "class=\"b_algo", "class=\"b_attribution"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "booking.com": {
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["hp_hotel_name", "data-capla-component-boundary",
                        "\"@type\" : \"Hotel\"", "\"hotelId\":", "\"reviewCount\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "capterra.com": {
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {"params": {"zone": "unlocker", "country": "gb"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>Slack Software Pricing", "\"@type\":\"SoftwareApplication\"",
                        "\"name\":\"Slack\"", "data-testid=\"hero-section\"", "/p/135003/Slack"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "ebay.com": {
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["itm.ebaydesc.com", "ebayLogoTitle", "\"product\":",
                        "p.ebaystatic.com", "\"@type\":\"Product\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "g2.com": {
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>Slack Reviews 2026", "itemprop=\"ratingValue\"",
                        "itemprop=\"reviewBody\"", "products/slack/reviews",
                        "Filter 39001 reviews"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "github.com": {
        "url": "https://github.com/microsoft/vscode",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>GitHub - microsoft/vscode",
                        "data-testid=\"latest-commit-details\"",
                        "data-testid=\"view-all-files-row\"",
                        "id=\"repository-container-header\"", "github.com/microsoft/vscode"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "google.com": {
        "url": "https://www.google.com/search?q=python+tutorial",
        # SERP zone (not unlocker) — Bright Data's dedicated search product.
        "tier": {"params": {"zone": "serp"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["id=\"search\"", "id=\"rso\"", "id=\"rcnt\"",
                        "<title>python tutorial - Google Search</title>",
                        "itemtype=\"http://schema.org/SearchResultsPage\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "idealista.com": {
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {"params": {"zone": "unlocker", "country": "es"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["class=\"main-info__title-main\"", "class=\"info-data-price\"",
                        "inmueble/110715434", "<title>Ático en venta",
                        "Calle de Isabel la Católica"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "indeed.com": {
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>",
                        "data-jk=\"", "class=\"job_seen_beacon",
                        "data-testid=\"company-name\"", "id=\"mosaic-provider-jobcards\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "instagram.com": {
        "url": "https://www.instagram.com/nike/",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["\"username\":\"nike\"", "<title>Nike (&#064;nike)",
                        "instagram://user?username=nike",
                        "href=\"https://www.instagram.com/nike/\"",
                        "og:type\" content=\"profile\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "linkedin.com": {
        "url": "https://www.linkedin.com/company/microsoft/",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>Microsoft | LinkedIn</title>", "\"@type\":\"Organization\"",
                        "urn:li:organization", "/company/microsoft",
                        "_org_guest_company_overview"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "reddit.com": {
        "url": "https://old.reddit.com/r/programming/",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["id=\"siteTable\"", "data-fullname=\"t3_",
                        "data-subreddit=\"programming\"",
                        "data-subreddit-prefixed=\"r/programming\"",
                        "<title>programming</title>"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "tripadvisor.com": {
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["Fairmont", "THE PLAZA NEW YORK", "\"@type\":\"LodgingBusiness\"",
                        "\"aggregateRating\"", "data-automation"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "trustpilot.com": {
        "url": "https://www.trustpilot.com/review/amazon.com",
        # T2: needs country=us geo-pinning per slice quirk to avoid the challenge page.
        "tier": {"params": {"zone": "unlocker", "country": "us"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["data-service-review-card-paper", "data-service-review-rating",
                        "\"@type\":\"Organization\"", "\"@type\":\"AggregateRating\"",
                        "data-business-unit-json-ld"],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "walmart.com": {
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["<title>Apple, AirPods with Charging Case",
                        "\"itemId\":\"604342441\"", "data-testid=\"price-wrap\"",
                        "id=\"__NEXT_DATA__\"", "data-testid=\"hero-image-container\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "x.com": {
        "url": "https://x.com/elonmusk",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["elonmusk", "Elon Musk", "44196397", "react-root",
                        "data-testid=\"tweet\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "youtube.com": {
        "url": "https://www.youtube.com/@MrBeast",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["\"channelMetadataRenderer\"",
                        "\"externalId\":\"UCX6OQ3DkcsbYNE6H8uQQuVA\"", "ytInitialData",
                        "\"title\":\"MrBeast\"", "\"subscriberCountText\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
    "zillow.com": {
        "url": "https://www.zillow.com/columbus-oh/",
        "tier": {"params": {"zone": "unlocker"},
                 "endpoint_override": "https://api.brightdata.com/request"},
        "verify_keys": ["data-testid=\"property-card\"", "\"zpid\":",
                        "\"@type\":\"SingleFamilyResidence\"", "\"streetAddress\"",
                        "\"bedrooms\""],
        "need_at_least": 2, "status": "operational", "reason_code": None,
        "cost_per_1k_usd": 1.5,
    },
}

# Bright Data Unlocker is per-account-rate-limited and some targets are very slow
# (booking ~31s, capterra ~52s, g2 ~43s). Pace a small gap between trials to avoid
# hammering the account; the per-request socket timeout is generous to allow the
# slow domains to finish rather than reporting a false FAIL.
PACE_SECONDS = 1.0
REQUEST_TIMEOUT_SECONDS = 90


# ----------------------------------------------------------------------------
# Request builder — follows the slice request_recipe EXACTLY:
#   transport POST, auth header Bearer, body {zone, url, format:"raw", ...params}.
# ----------------------------------------------------------------------------
def build_request(token, domain_cfg):
    """Return a urllib.request.Request for one Bright Data /request call."""
    tier = domain_cfg["tier"]
    endpoint = tier["endpoint_override"]  # always https://api.brightdata.com/request
    params = tier["params"]

    # Body: zone + target url + raw HTML format, merged with per-domain params
    # (zone, country). 'format: raw' makes Bright Data return the page body directly.
    body = {
        "url": domain_cfg["url"],
        "format": "raw",
    }
    body.update(params)  # injects zone (unlocker/serp) and optional country

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, method="POST")
    req.add_header("Authorization", "Bearer " + token)  # auth: header:Bearer
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "*/*")
    return req


def fetch(token, domain_cfg):
    """Execute one request. Returns (body_text_or_None, latency_ms, error_or_None)."""
    req = build_request(token, domain_cfg)
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            raw = resp.read()
            latency_ms = int((time.time() - start) * 1000)
            # Bright Data /request with format:raw returns the target page bytes directly.
            body = raw.decode("utf-8", errors="replace")
            return body, latency_ms, None
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - start) * 1000)
        # Read the error body too — Bright Data sometimes 4xx/5xx with a useful message.
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return body, latency_ms, "HTTP {}".format(e.code)
    except Exception as e:  # noqa: BLE001 — network/timeout/etc; never crash the runner
        latency_ms = int((time.time() - start) * 1000)
        return None, latency_ms, type(e).__name__


# ----------------------------------------------------------------------------
# verify(): count substring hits; PASS when hits >= need_at_least.
# IDENTICAL rule in the TypeScript port.
# ----------------------------------------------------------------------------
def verify(body, verify_keys, need_at_least):
    if not body:
        return False, 0
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


# ----------------------------------------------------------------------------
# Runner
# ----------------------------------------------------------------------------
def run_domain(token, domain, cfg, trials):
    """Run `trials` requests for one operational domain; return measured stats."""
    passes = 0
    latencies = []
    for _ in range(trials):
        body, latency_ms, err = fetch(token, cfg)
        latencies.append(latency_ms)
        ok, _hits = verify(body, cfg["verify_keys"], cfg["need_at_least"])
        if ok:
            passes += 1
        if err and body is None:
            # Pure transport failure (timeout / DNS) — counts as a non-pass trial.
            pass
        time.sleep(PACE_SECONDS)  # rate-limit pacing per provider quirk
    success_rate = passes / trials if trials else 0.0
    avg_latency = int(sum(latencies) / len(latencies)) if latencies else 0
    return {
        "status": "operational",
        "tier": cfg["tier"],
        "url": cfg["url"],
        "success_rate": success_rate,
        "pass_count": passes,
        "trials": trials,
        "avg_latency_ms": avg_latency,
        "cost_per_1k_usd": cfg["cost_per_1k_usd"],
        "cost_source": "frozen",
        "verify_keys": cfg["verify_keys"],
        "need_at_least": cfg["need_at_least"],
    }


def main():
    parser = argparse.ArgumentParser(description="Live test for Bright Data Web Unlocker.")
    parser.add_argument("--trials", type=int, default=3,
                        help="Number of trials per operational domain (default 3).")
    args = parser.parse_args()
    trials = max(1, args.trials)

    # Auth check BEFORE any request — never crash on missing key.
    token = os.environ.get(AUTH_ENV)
    if not token:
        print("Set {} to run (see .env.example)".format(AUTH_ENV))
        sys.exit(0)

    print("Bright Data Web Unlocker — live test ({} trials/domain)".format(trials))
    print("=" * 72)

    results = {}
    operational_count = 0
    skipped_count = 0

    for domain, cfg in DOMAINS.items():
        if cfg["status"] != "operational":
            # genuine_fail rows: DO NOT make requests; print one SKIP line.
            reason = cfg.get("reason_code") or "genuine_fail"
            note = "known failure — not requested live"
            print("SKIP {}: {} — {}".format(domain, reason, note))
            skipped_count += 1
            results[domain] = {
                "status": cfg["status"],
                "tier": cfg["tier"],
                "url": cfg["url"],
                "success_rate": 0.0,
                "avg_latency_ms": 0,
                "cost_per_1k_usd": cfg["cost_per_1k_usd"],
                "cost_source": "frozen",
                "reason_code": cfg.get("reason_code"),
                "verify_keys": cfg["verify_keys"],
                "need_at_least": cfg["need_at_least"],
            }
            continue

        operational_count += 1
        res = run_domain(token, domain, cfg, trials)
        results[domain] = res
        print("  {:<16} {:>3}/{:<3} PASS   SR={:.3f}   {:>6} ms".format(
            domain, res["pass_count"], res["trials"], res["success_rate"],
            res["avg_latency_ms"]))

    # ---- summary (same method as the frozen file) ----
    op_rows = [r for r in results.values() if r["status"] == "operational"]
    domains_total = len(DOMAINS)
    reachability_pct = round(100.0 * operational_count / domains_total, 2) if domains_total else 0.0
    avg_success_rate = (round(sum(r["success_rate"] for r in op_rows) / len(op_rows), 4)
                        if op_rows else 0.0)
    avg_latency_ms = (int(sum(r["avg_latency_ms"] for r in op_rows) / len(op_rows))
                      if op_rows else 0)

    summary = {
        "domains_total": domains_total,
        "operational": operational_count,
        "genuine_fail": skipped_count,
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_success_rate,
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,  # frozen — not measured live
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

    # Write ../../test-results/brightdata.run.json relative to THIS script's location.
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(here, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "{}.run.json".format(PROVIDER))
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)

    # ---- clean per-domain table to stdout ----
    print("=" * 72)
    print("{:<16} {:<12} {:>7}  {:>9}".format("DOMAIN", "STATUS", "SR", "AVG_MS"))
    print("-" * 72)
    for domain, r in results.items():
        print("{:<16} {:<12} {:>7.3f}  {:>9}".format(
            domain, r["status"], r["success_rate"], r["avg_latency_ms"]))
    print("-" * 72)
    print("reachability={}%  avg_SR={:.3f}  avg_ms={}".format(
        summary["reachability_pct"], summary["avg_success_rate"], summary["avg_latency_ms"]))
    print("wrote {}".format(out_path))


if __name__ == "__main__":
    main()
