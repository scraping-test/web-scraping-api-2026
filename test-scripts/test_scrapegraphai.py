#!/usr/bin/env python3
"""
test_scrapegraphai.py — self-contained live test for the ScrapeGraphAI scraping API.

WHAT IT TESTS
    Re-runs the frozen 2026 benchmark for one provider (scrapegraphai) against a
    fixed table of 20 target domains. 18 are "operational" (we actually fetch them
    and check PASS/FAIL); 2 are "genuine_fail" rows that we DO NOT request — we just
    print a SKIP line with the recorded reason code. For each operational domain we
    run N trials (default 3) and report a per-domain success rate + average latency.

    Verification rule (identical to the TypeScript sibling):
        - stringify the JSON response,
        - count how many of the domain's verify_keys appear as substrings,
        - PASS when hits >= need_at_least.

PROVIDER QUIRKS (from the slice request_recipe + quirks):
    - Transport: POST JSON.
    - Auth: HTTP header  "SGAI-APIKEY: <token>"  (NOT a query param, NOT Bearer).
    - Endpoint: each domain carries its own endpoint_override, one of
        /v1/scrape-markdown            (Tier 1, 1 credit)
        /v1/scrape-markdown-stealth-js (Tier 2, 6 credits)
        /v1/scrape-stealth-js          (Tier 2, 6 credits)
      We POST to that exact override URL.
    - Body: {"website_url": "<target url>"}.
    - Response: JSON object with a markdown/html content field. The output is
      MARKDOWN-FIRST, but verify_keys are still matched as plain substrings against
      the stringified JSON body (HTML tokens survive in the embedded content), so we
      just json.dumps() the whole response and substring-match.

HOW TO RUN
    export SCRAPEGRAPHAI_TOKEN=sgai-xxxxxxxx        # see .env.example
    python3 test_scrapegraphai.py                   # 3 trials per operational domain
    python3 test_scrapegraphai.py --trials 5        # custom trial count

    If SCRAPEGRAPHAI_TOKEN is unset the script prints a hint and exits 0 (never crashes).

WHAT IT WRITES
    ../../test-results/scrapegraphai.run.json  (relative to this script's own dir,
    i.e. test-scripts/scrapegraphai/ -> test-results/). Same schema as the frozen file:
    {provider, report_date(today), frozen:false, endpoint, auth_env, summary, domains}.
    avg_cost_per_1k_usd is copied from the frozen slice (cost is not measured live)
    and tagged "cost_source":"frozen".

Stdlib only. Python 3.8+.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------- #
# Provider constants (frozen literals from the slice — do NOT read slice at runtime)
# --------------------------------------------------------------------------- #
PROVIDER = "scrapegraphai"
ENDPOINT = "https://api.scrapegraphai.com/v1"
AUTH_ENV = "SCRAPEGRAPHAI_TOKEN"
# Frozen aggregate cost — cost is not measured live, so we copy this through.
FROZEN_AVG_COST_PER_1K_USD = 6.44

# Provider rate-limit / pacing quirk: ScrapeGraphAI requests are heavy (stealth-js
# can take 16-27s) and the API is credit-metered, so we pace politely between calls.
PACE_SECONDS = 1.0

# --------------------------------------------------------------------------- #
# DOMAINS table — embedded literals from the slice "domains" object.
# Each entry: url, tier(params + endpoint_override), verify_keys, need_at_least,
# status, cost_per_1k_usd (frozen), and reason_code for genuine_fail rows.
# --------------------------------------------------------------------------- #
DOMAINS = {
    "amazon.com": {
        "status": "operational",
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["productTitle", "id=\"dp-container\"", "id=\"centerCol\"", "data-asin=\"B07FZ8S74R\"", "nav-logo-base"],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "bestbuy.com": {
        "status": "genuine_fail",
        "url": "https://www.bestbuy.com/site/apple-iphone-16-pro-max-256gb-natural-titanium-att/6570601.p?skuId=6570601",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["application/ld+json", "\"@type\":\"Product\"", "\"sku\":\"6570601\"", "\"customerPrice\"", "add-to-cart-button"],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "fetch_failed_502",
    },
    "bing.com": {
        "status": "operational",
        "url": "https://www.bing.com/search?q=best+laptops+2025",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["<title>best laptops 2025 - Search</title>", "id=\"b_content\"", "id=\"sb_form\"", "class=\"b_algo", "class=\"b_attribution"],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "booking.com": {
        "status": "operational",
        "url": "https://www.booking.com/hotel/us/the-plaza.html",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js"},
        "verify_keys": ["hp_hotel_name", "data-capla-component-boundary", "\"@type\" : \"Hotel\"", "\"hotelId\":", "\"reviewCount\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "capterra.com": {
        "status": "operational",
        "url": "https://www.capterra.com/p/135003/Slack/",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-stealth-js"},
        "verify_keys": ["<title>Slack Software Pricing", "\"@type\":\"SoftwareApplication\"", "\"name\":\"Slack\"", "data-testid=\"hero-section\"", "/p/135003/Slack"],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "ebay.com": {
        "status": "operational",
        "url": "https://www.ebay.com/itm/116619563010",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js"},
        "verify_keys": ["itm.ebaydesc.com", "ebayLogoTitle", "\"product\":", "p.ebaystatic.com", "\"@type\":\"Product\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "g2.com": {
        "status": "operational",
        "url": "https://www.g2.com/products/slack/reviews",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js"},
        "verify_keys": ["<title>Slack Reviews 2026", "itemprop=\"ratingValue\"", "itemprop=\"reviewBody\"", "products/slack/reviews", "Filter 39001 reviews"],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "github.com": {
        "status": "operational",
        "url": "https://github.com/microsoft/vscode",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["<title>GitHub - microsoft/vscode", "data-testid=\"latest-commit-details\"", "data-testid=\"view-all-files-row\"", "id=\"repository-container-header\"", "github.com/microsoft/vscode"],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "google.com": {
        "status": "operational",
        "url": "https://www.google.com/search?q=python+tutorial",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["id=\"search\"", "id=\"rso\"", "id=\"rcnt\"", "<title>python tutorial - Google Search</title>", "itemtype=\"http://schema.org/SearchResultsPage\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "idealista.com": {
        "status": "operational",
        "url": "https://www.idealista.com/inmueble/110715434/",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js"},
        "verify_keys": ["class=\"main-info__title-main\"", "class=\"info-data-price\"", "inmueble/110715434", "<title>Ático en venta", "Calle de Isabel la Católica"],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "indeed.com": {
        "status": "operational",
        "url": "https://www.indeed.com/jobs?q=software+engineer&l=New+York%2C+NY",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js"},
        "verify_keys": ["<title>Software Engineer Jobs, Employment in New York, NY | Indeed</title>", "data-jk=\"", "class=\"job_seen_beacon", "data-testid=\"company-name\"", "id=\"mosaic-provider-jobcards\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "instagram.com": {
        "status": "operational",
        "url": "https://www.instagram.com/nike/",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["\"username\":\"nike\"", "<title>Nike (&#064;nike)", "instagram://user?username=nike", "href=\"https://www.instagram.com/nike/\"", "og:type\" content=\"profile\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "linkedin.com": {
        "status": "operational",
        "url": "https://www.linkedin.com/company/microsoft/",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["<title>Microsoft | LinkedIn</title>", "\"@type\":\"Organization\"", "urn:li:organization", "/company/microsoft", "_org_guest_company_overview"],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "reddit.com": {
        "status": "operational",
        "url": "https://old.reddit.com/r/programming/",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["id=\"siteTable\"", "data-fullname=\"t3_", "data-subreddit=\"programming\"", "data-subreddit-prefixed=\"r/programming\"", "<title>programming</title>"],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "tripadvisor.com": {
        "status": "operational",
        "url": "https://www.tripadvisor.com/Hotel_Review-g60763-d675616-Reviews-The_Plaza_New_York_A_Fairmont_Managed_Hotel-New_York_City_New_York.html",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["Fairmont", "THE PLAZA NEW YORK", "\"@type\":\"LodgingBusiness\"", "\"aggregateRating\"", "data-automation"],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "trustpilot.com": {
        "status": "operational",
        "url": "https://www.trustpilot.com/review/amazon.com",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown-stealth-js"},
        "verify_keys": ["data-service-review-card-paper", "data-service-review-rating", "\"@type\":\"Organization\"", "\"@type\":\"AggregateRating\"", "data-business-unit-json-ld"],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "walmart.com": {
        "status": "operational",
        "url": "https://www.walmart.com/ip/604342441",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-stealth-js"},
        "verify_keys": ["<title>Apple, AirPods with Charging Case", "\"itemId\":\"604342441\"", "data-testid=\"price-wrap\"", "id=\"__NEXT_DATA__\"", "data-testid=\"hero-image-container\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 12,
    },
    "x.com": {
        "status": "operational",
        "url": "https://x.com/elonmusk",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["elonmusk", "Elon Musk", "44196397", "react-root", "data-testid=\"tweet\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "youtube.com": {
        "status": "operational",
        "url": "https://www.youtube.com/@MrBeast",
        "tier": {"params": {}, "endpoint_override": "https://api.scrapegraphai.com/v1/scrape-markdown"},
        "verify_keys": ["\"channelMetadataRenderer\"", "\"externalId\":\"UCX6OQ3DkcsbYNE6H8uQQuVA\"", "ytInitialData", "\"title\":\"MrBeast\"", "\"subscriberCountText\""],
        "need_at_least": 2,
        "cost_per_1k_usd": 2,
    },
    "zillow.com": {
        "status": "genuine_fail",
        "url": "https://www.zillow.com/columbus-oh/",
        "tier": {"params": {}, "endpoint_override": None},
        "verify_keys": ["data-testid=\"property-card\"", "\"zpid\":", "\"@type\":\"SingleFamilyResidence\"", "\"streetAddress\"", "\"bedrooms\""],
        "need_at_least": 2,
        "cost_per_1k_usd": None,
        "reason_code": "empty_body",
    },
}

# Short human notes for the SKIP lines on genuine_fail rows.
GENUINE_FAIL_NOTES = {
    "fetch_failed_502": "502 fetch_failed on every config (PDP-specific).",
    "empty_body": "200 + empty body on /columbus-oh_rb/.",
}


# --------------------------------------------------------------------------- #
# Request builder — follows the slice request_recipe EXACTLY.
#   POST JSON {"website_url": url} to the domain's endpoint_override,
#   auth via header SGAI-APIKEY.
# --------------------------------------------------------------------------- #
def fetch(url, endpoint_override, token, timeout=120):
    """Return (status_code, response_text). On transport error returns (0, '')."""
    body = json.dumps({"website_url": url}).encode("utf-8")
    req = urllib.request.Request(
        endpoint_override,
        data=body,
        method="POST",
        headers={
            # Quirk: ScrapeGraphAI auth is a custom header, not Authorization/Bearer.
            "SGAI-APIKEY": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        # Read the error body too — useful for diagnosing 4xx/5xx; status still recorded.
        try:
            return e.code, e.read().decode("utf-8", errors="replace")
        except Exception:
            return e.code, ""
    except Exception:
        return 0, ""


def unwrap(status, text):
    """
    Response unwrapping per recipe: ScrapeGraphAI returns a JSON object whose
    markdown/html content lives in a field. We stringify the whole JSON response
    and substring-match verify_keys against it (markdown output, but HTML tokens
    survive in the embedded content). If the body is not JSON, return it raw.
    """
    if not text:
        return ""
    try:
        obj = json.loads(text)
        # Re-serialize the entire parsed object so every nested content field is
        # available to the substring matcher.
        return json.dumps(obj, ensure_ascii=False)
    except (ValueError, TypeError):
        return text


# --------------------------------------------------------------------------- #
# verify() — IDENTICAL rule across both languages.
# Count how many verify_keys appear as substrings; PASS when hits >= need_at_least.
# --------------------------------------------------------------------------- #
def verify(body, verify_keys, need_at_least):
    if not body:
        return False, 0
    hits = 0
    for key in verify_keys:
        if key in body:
            hits += 1
    return hits >= need_at_least, hits


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
def run(trials, token):
    results = {}
    for domain, spec in DOMAINS.items():
        status = spec["status"]

        # genuine_fail rows: DO NOT request. Print a SKIP line and record the row.
        if status == "genuine_fail":
            reason = spec.get("reason_code", "genuine_fail")
            note = GENUINE_FAIL_NOTES.get(reason, "")
            print(f"SKIP {domain}: {reason} — {note}")
            results[domain] = {
                "status": "genuine_fail",
                "success_rate": 0,
                "avg_latency_ms": None,
                "reason_code": reason,
            }
            continue

        endpoint_override = spec["tier"]["endpoint_override"]
        passes = 0
        latencies = []
        for _ in range(trials):
            t0 = time.time()
            code, text = fetch(spec["url"], endpoint_override, token)
            latencies.append(int((time.time() - t0) * 1000))
            body = unwrap(code, text)
            ok, _hits = verify(body, spec["verify_keys"], spec["need_at_least"])
            if ok:
                passes += 1
            # Pace per provider rate-limit quirk (heavy/credit-metered calls).
            time.sleep(PACE_SECONDS)

        sr = passes / trials if trials else 0.0
        avg_ms = int(sum(latencies) / len(latencies)) if latencies else None
        results[domain] = {
            "status": "operational",
            "success_rate": sr,
            "avg_latency_ms": avg_ms,
            "pass": passes,
            "trials": trials,
        }
        print(f"  {domain:<18} {'PASS' if sr > 0 else 'FAIL'}  SR={sr:.2f}  {passes}/{trials}  avg={avg_ms}ms")

    return results


def build_summary(results):
    operational = [r for r in results.values() if r["status"] == "operational"]
    total = len(results)
    genuine_fail = [r for r in results.values() if r["status"] == "genuine_fail"]
    reachable = len(operational)
    reachability_pct = round(100 * reachable / total) if total else 0
    avg_sr = round(sum(r["success_rate"] for r in operational) / len(operational), 4) if operational else 0
    op_lat = [r["avg_latency_ms"] for r in operational if r["avg_latency_ms"] is not None]
    avg_latency_ms = int(sum(op_lat) / len(op_lat)) if op_lat else None
    return {
        "domains_total": total,
        "operational": len(operational),
        "genuine_fail": len(genuine_fail),
        "reachability_pct": reachability_pct,
        "avg_success_rate": avg_sr,
        # Cost is not measured live — copy frozen aggregate and tag the source.
        "avg_cost_per_1k_usd": FROZEN_AVG_COST_PER_1K_USD,
        "cost_source": "frozen",
        "avg_latency_ms": avg_latency_ms,
    }


def build_domains_output(results):
    out = {}
    for domain, spec in DOMAINS.items():
        r = results[domain]
        row = {
            "status": r["status"],
            "success_rate": r["success_rate"],
            "avg_latency_ms": r["avg_latency_ms"],
            # Cost copied from frozen slice; not measured live.
            "cost_per_1k_usd": spec.get("cost_per_1k_usd"),
            "cost_source": "frozen",
        }
        if r["status"] == "operational":
            row["pass"] = r["pass"]
            row["trials"] = r["trials"]
        else:
            row["reason_code"] = r.get("reason_code")
        out[domain] = row
    return out


def main():
    parser = argparse.ArgumentParser(description="Live test for the scrapegraphai scraping API.")
    parser.add_argument("--trials", type=int, default=3, help="Trials per operational domain (default 3).")
    args = parser.parse_args()

    # Auth check BEFORE any request. Never crash on missing env.
    token = os.environ.get(AUTH_ENV)
    if not token:
        print(f"Set {AUTH_ENV} to run (see .env.example)")
        sys.exit(0)

    print(f"== {PROVIDER} live test ==  trials={args.trials}")
    results = run(args.trials, token)

    summary = build_summary(results)
    report = {
        "provider": PROVIDER,
        "report_date": time.strftime("%Y-%m-%d"),
        "frozen": False,
        "endpoint": ENDPOINT,
        "auth_env": AUTH_ENV,
        "summary": summary,
        "domains": build_domains_output(results),
    }

    # Write ../../test-results/<provider>.run.json relative to THIS script's dir.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.normpath(os.path.join(script_dir, "..", "..", "test-results"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{PROVIDER}.run.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    # Clean per-domain table to stdout.
    print()
    print(f"{'domain':<18} {'status':<13} {'SR':>5} {'avg ms':>8}")
    print("-" * 48)
    for domain in DOMAINS:
        r = results[domain]
        sr = f"{r['success_rate']:.2f}"
        avg = "-" if r["avg_latency_ms"] is None else str(r["avg_latency_ms"])
        print(f"{domain:<18} {r['status']:<13} {sr:>5} {avg:>8}")
    print("-" * 48)
    s = summary
    print(f"reachability={s['reachability_pct']}%  avg_SR={s['avg_success_rate']}  "
          f"avg_latency={s['avg_latency_ms']}ms  avg_cost/1k=${s['avg_cost_per_1k_usd']} (frozen)")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
