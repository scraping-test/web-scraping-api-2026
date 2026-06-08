# Web Scraping API Benchmark 2026: 16 Providers Tested Across 20 Hard Targets

This is a frozen snapshot. In June 2026 we ran every major web scraping API against the same 20 websites (Amazon, Google, LinkedIn, Zillow, G2, and 15 others that actively fight scrapers) and recorded what each provider could actually fetch, at what cost, and how fast. The numbers below are the result. We are not updating them. This repository is the 2026 report, kept as-is so it stays comparable over time.

Every result is reproducible. The [`test-scripts/`](test-scripts/) folder has a standalone Python and TypeScript script for each provider. Add your own API key, run the script, and you get a fresh results file you can diff against ours.

## Provider comparison

Sorted by how many of the 20 target domains each provider could reach, then by average cost. "Domains reached" counts a domain as reachable if the provider returned verifiable content on it at least once (success rate above zero). Averages are computed over the domains a provider actually reaches. A domain it cannot scrape at all is reported as a block, not folded into the average as a zero.

| Provider | Domains reached | Avg success rate | Avg cost / 1k | Avg latency | Data |
|---|---|---|---|---|---|
| [Scrape.do](#scrapedo) | 20/20 (100%) | 99.4% | $0.23 | 4.2s | [json](test-results/scrape-do.json) |
| [Decodo](#decodo) | 20/20 (100%) | 95.9% | $0.68 | 11.9s | [json](test-results/decodo.json) |
| [Bright Data](#bright-data) | 20/20 (100%) | 94.7% | $1.55 | 14.6s | [json](test-results/brightdata.json) |
| [Scrapfly](#scrapfly) | 20/20 (100%) | 93.4% | $2.69 | 4.8s | [json](test-results/scrapfly.json) |
| [WebScrapingAPI](#webscrapingapi) | 20/20 (100%) | 86.9% | $4.90 | 14.8s | [json](test-results/webscrapingapi.json) |
| [Oxylabs](#oxylabs) | 20/20 (100%) | 93.4% | $7.00 | 13.1s | [json](test-results/oxylabs.json) |
| [Apify](#apify) | 20/20 (100%) | 95.3% | $7.04 | 19.5s | [json](test-results/apify.json) |
| [ScrapingDog](#scrapingdog) | 19/20 (95%) | 84.8% | $1.51 | 6.5s | [json](test-results/scrapingdog.json) |
| [ScrapingBee](#scrapingbee) | 19/20 (95%) | 89.6% | $2.66 | 19.2s | [json](test-results/scrapingbee.json) |
| [Zyte](#zyte) | 18/20 (90%) | 92.2% | $1.11 | 12.7s | [json](test-results/zyte.json) |
| [ZenRows](#zenrows) | 18/20 (90%) | 90.6% | $2.18 | 12.2s | [json](test-results/zenrows.json) |
| [ScrapeGraphAI](#scrapegraphai) | 18/20 (90%) | 98.5% | $6.44 | 6.4s | [json](test-results/scrapegraphai.json) |
| [ScraperAPI](#scraperapi) | 18/20 (90%) | 83.9% | $12.04 | 14.7s | [json](test-results/scraperapi.json) |
| [Firecrawl](#firecrawl) | 16/20 (80%) | 83.1% | $16.70 | 4.0s | [json](test-results/firecrawl.json) |
| [ScrapingAnt](#scrapingant) | 15/20 (75%) | 74.9% | $2.30 | 30.7s | [json](test-results/scrapingant.json) |
| [SerpApi](#serpapi) | 8/20 (40%) | — | $25.00 | — | [json](test-results/serpapi.json) |

A few things stand out. Reaching every domain is not the same as being cheap or fast. Scrape.do manages all three, but Oxylabs and Apify also hit 20/20 while costing roughly 30× more per request. SerpApi sits at the bottom on coverage for a simple reason: it is a search-engine API, not a general scraper, so it only has dedicated engines for 8 of these 20 sites and treats the other 12 as out of scope rather than failures. Cost is per 1,000 successful requests, in USD, at each provider's entry-level paid plan as of June 2026.

## How we tested

### The 20 target domains

We picked 20 sites that cover the spread of real scraping work: e-commerce, search, travel, jobs, social, reviews, and real estate. They range from trivial to genuinely hostile. The full list, with the exact URL and the markers we check for, lives in each provider's [results JSON](test-results/).

| Category | Domains |
|---|---|
| E-commerce | amazon.com, bestbuy.com, ebay.com, walmart.com |
| Search | google.com, bing.com |
| Social | instagram.com, linkedin.com, reddit.com, x.com, youtube.com |
| Travel | booking.com, tripadvisor.com |
| Reviews | g2.com, capterra.com, trustpilot.com |
| Jobs | indeed.com |
| Real estate | zillow.com, idealista.com |
| Developer | github.com |

GitHub is the easy end of the scale; it works on the cheapest tier almost everywhere. G2, Zillow, and Idealista are the hard end, sitting behind DataDome, PerimeterX, and geo-fences that defeat several providers entirely.

### What counts as a success

Every target URL has five verification markers: JSON-LD types, item IDs pulled from the URL, stable CDN references, or page-specific anchors. A request passes if **at least two of the five markers appear in the response body.** Two-of-five is a deliberate middle ground. One marker is too easy to fake, since a bot wall can echo a brand name in its title, and requiring all five breaks the moment a site renames a single CSS class.

We learned to avoid the obvious traps. A Walmart "Item Not Found" wall returns HTTP 200 with the product name still in the title. A Firecrawl `/search` call returns Google snippets that mention the URL without ever fetching the page. Both look like success to a naive check, so the markers are chosen to reject them: SKU numbers, `sourceURL` matches, and schema.org types rather than brand names.

### Tiers and cost

Most providers expose tiers: a cheap datacenter-proxy request, a more expensive residential or rendered request, a premium anti-bot mode. A given site only needs as much firepower as it takes to get through. Amazon's product page works on the basic tier nearly everywhere; Best Buy needs residential proxies; X needs a rendered browser with a wait.

For each provider-and-domain pair we use the **cheapest tier that reliably passes**, which is the same tier our daily benchmark settled on after working up the ladder. That tier (the exact parameters and any dedicated endpoint) is baked into each domain's entry in the results JSON and into the test scripts, so what you run is what we ran. The cost column reflects that per-domain tier rather than a flat headline rate, because the headline rate is usually fiction once a site forces an upgrade.

### Trial counts and pacing

The frozen numbers come from 30 trials per domain for most providers, fewer for the expensive ones (Firecrawl and ScraperAPI's ultra-premium tier are capped at 10 to keep the bill sane). Thirty trials is enough to catch a real success-rate drop without burning quota on noise. The replication scripts default to 3 trials so you can sanity-check a provider for a few cents; pass `--trials 30` to match our sample size.

Each provider is paced to its own limits. ScrapingAnt needs six seconds between calls or it cools your key down, ZenRows soft-locks after a burst of 4xx, and Firecrawl caps at 100 requests a minute. The scripts encode these so a replication run does not trip the same wires we did.

## Results by provider

### Scrape.do

The most complete coverage at the lowest cost in the set: 20/20 domains, 99.4% average success, and an average of $0.23 per thousand. The catch is that the published "1 credit" basic rate is not always what you pay. Protected domains get auto-routed through higher tiers and billed accordingly (LinkedIn lands at $3.30/1k, G2 at $2.75/1k), and the `scrape.do-request-cost` header reports the real figure on every response. Amazon runs at $0.11/1k on the basic tier, Best Buy at $1.10 on the super tier. The slowest domain is X, at roughly 10 seconds with a rendered wait. Dedicated plugins for Amazon, Google, and YouTube return structured JSON at the same credit cost. [Full data →](test-results/scrape-do.json)

### Decodo

Second on the value curve: 20/20 reachable, 95.9% average success, $0.68 per thousand. The quirk that bites people is that the premium proxy pool is the *default* when you POST without naming a tier, so a bare request costs $1.00/1k instead of the $0.50 standard rate. Only six of the twenty domains actually need more than the standard tier. G2 is the soft spot. Its DataDome shield drops Decodo to about 60% under concurrent load, though single requests clear fine, and it is the slowest domain here at roughly 48 seconds. [Full data →](test-results/decodo.json)

### Bright Data

Full coverage at 94.7% success and $1.55 per thousand on the Web Unlocker. Pricing is a two-tier lookup rather than a single rate: $1.50/1k for standard domains and $2.50/1k for 87 specific high-protection sites, of which Best Buy is the only one in this set. The thing to watch is that a wrong-zone token returns HTTP 200 with an "Access denied" HTML body that looks like a clean scrape, so you have to check the content and never trust the status code alone. Latency runs high on the review sites, with Capterra averaging around 52 seconds. [Full data →](test-results/brightdata.json)

### Scrapfly

20/20 at 93.4% success and $2.69 per thousand, and the second-fastest full-coverage provider at 4.8 seconds average. Cost is credit-based with per-domain surcharges: LinkedIn adds 25 credits, and the DataDome bypass on G2 costs 40. GitHub quietly routes through the residential pool and runs 25 credits even on the basic tier. Pin `country=us` for Google and Zillow, or geo-routing roulette will cost you success rate. Bing is the cheapest domain at $0.15/1k. [Full data →](test-results/scrapfly.json)

### WebScrapingAPI

Full coverage, but the success rate slips to 86.9% and cost climbs to $4.90 per thousand. The credit ladder is 1 (basic), 5 (render), 10 (render plus country). Two failure modes are worth knowing. A four-minute per-domain wall-time budget can cut large batches short, and the API occasionally returns a 52-byte stub as a 200, which is really a hidden 502. Walmart only yields about 25% even at the top tier. eBay is the priciest domain here at $24.50/1k. [Full data →](test-results/webscrapingapi.json)

### Oxylabs

20/20 and 93.4% success, but the most expensive of the full-coverage group at a flat $7.00 per thousand. The operational note that matters most is about transport. Oxylabs' Web Unblocker uses an HTTP CONNECT proxy that hangs forever under Node's built-in `fetch`, so our TypeScript script sidesteps it with the realtime JSON endpoint and the Python script stays the reference path. Source-keyed parsers (`amazon_product`, `google`, `walmart`, `bing`, `indeed`) return clean structured data. Trustpilot is the weak spot, with 403s that persist even at the top tier. [Full data →](test-results/oxylabs.json)

### Apify

Apify is a marketplace rather than a single API. Each domain runs through a community or official Actor, so the 20/20 coverage and strong 95.3% success come with wildly variable pricing, from $0.475/1k on Trustpilot up to $44/1k on Reddit, where a pay-per-event Actor charges a start fee on top of each result. The average lands at $7.04/1k, and Actor cold starts push latency to the highest in the full-coverage set (19.5s average, Walmart up to 56s). Some Actors ignore `maxItems=1` and return a full page of results regardless. [Full data →](test-results/apify.json)

### ScrapingDog

19/20 at 84.8% success and a low $1.51 per thousand. The one block is G2, sitting behind a Cloudflare Turnstile wall that structurally rejects the only parameter combination that might clear it. The generic `/scrape` endpoint struggles on protected sites, but eleven domains have dedicated endpoints (`/instagram/profile`, `/x/profile`, `/youtube/channel`, and others) that jump from under 60% to 100% success in exchange for a higher per-call credit cost. Idealista and Tripadvisor stay low-yield even on premium. [Full data →](test-results/scrapingdog.json)

### ScrapingBee

19/20 at 89.6% success and $2.66 per thousand. G2 is the casualty, and its story is the cleanest example of why we lock in recoveries over 30 trials. A first burst passed 3 of 3, then the same config returned 0 of 30 once ScrapingBee blacklisted its own outbound IPs after the burst. The lesson baked into the script is to spread calls out rather than hammer hard targets. Idealista is both expensive and slow here, at $14.70/1k and the worst single-domain latency in the whole benchmark, around 110 seconds. [Full data →](test-results/scrapingbee.json)

### Zyte

18/20 at 92.2% success and a competitive $1.11 per thousand. There are two clean policy blocks. LinkedIn returns 451 Domain Forbidden, which is an account-level decision rather than a technical wall, and G2 returns 520 Website Ban on every tier including full browser rendering. Pricing is automatic, at $0.0006/req for an HTTP body and $0.003/req for browser HTML, and you cannot force the cheaper path on a site that needs the browser. The HTTP-body response comes back base64-encoded, so the scripts decode it before checking. Zillow is the slowest at about 39 seconds. [Full data →](test-results/zyte.json)

### ZenRows

18/20 at 90.6% success and $2.18 per thousand. The two blocks are not really ZenRows' fault. Best Buy returns a "Select your Country" geo-fence interstitial, which is a UX redirect rather than a bot wall, and Instagram is forbidden by provider policy on every tier. The operational gotcha is the Developer plan's temper: two or three consecutive 4xx responses soft-lock the key for about a minute, so the script backs off 60 seconds after a run of failures. eBay needs an 8-second wait to clear its interstitial, which makes it both the priciest ($7/1k) and slowest (38s) domain. [Full data →](test-results/zenrows.json)

### ScrapeGraphAI

18/20, but on the domains it reaches it posts the highest success rate of any provider in the set, 98.5%, at $6.44 per thousand. It is an LLM-driven, markdown-first scraper, so verification matches text tokens rather than CSS classes. Both blocks are URL-specific. The Best Buy product page 502s on every configuration while the homepage and search work fine, and the Zillow region URL returns an empty body. There are no per-domain parsers by design; the whole product is `/scrape` and `/extract`. Booking is the priciest domain at $12/1k on the stealth tier. [Full data →](test-results/scrapegraphai.json)

### ScraperAPI

18/20 at 83.9% success and the second-highest cost in the set at $12.04 per thousand. Instagram and X are hard ToS-denylist blocks at the gateway, and the X block also covers twitter.com and nitter mirrors. The headline credit rate is misleading: Amazon bills 5× the documented cost, Google 25×, and LinkedIn 30×, all visible in the `sa-credit-cost` header. G2 only clears on the ultra-premium tier with a render and a selector wait, which is why Best Buy tops out at $36.75/1k here. Trustpilot returns 500s on roughly 98% of calls, so it is effectively blocked. [Full data →](test-results/scraperapi.json)

### Firecrawl

16/20 at 83.1% success and the highest average cost in the benchmark at $16.70 per thousand. There are four hard blocks. Instagram, LinkedIn, and Reddit sit on a policy block-list that answers with a 263-byte denial, and Google returns reCAPTCHA 429 because Firecrawl's outbound IPs are on Google's high-volume rate-limit list. Two things are worth watching when you read Firecrawl numbers. Its `/search` endpoint returns SERP snippets that masquerade as scraped pages, so the scripts require the response `sourceURL` to match the target domain. It also caches per URL for about an hour, which means repeated trials measure cache hits unless you bust the cache, and the scripts do. That caching is exactly why the 4.0s average looks so fast. [Full data →](test-results/firecrawl.json)

### ScrapingAnt

15/20 at 74.9% success and $2.30 per thousand, the widest block surface among the general scrapers. Five domains (G2, Idealista, LinkedIn, Tripadvisor, Trustpilot) return 423 "browser detected" on every configuration. These are target-side blocks that a plan upgrade will not fix. It is also the slowest provider overall at 30.7 seconds average, with several domains in the 30–60 second range. A per-key cooldown after any 4xx is why the script paces at six seconds between calls. Google is the priciest domain at $23.75/1k on the deluxe tier. [Full data →](test-results/scrapingant.json)

### SerpApi

SerpApi is a different kind of tool, a structured search-engine API rather than a general scraper. It has dedicated engines for 8 of the 20 domains (Google, Bing, Amazon, eBay, Walmart, YouTube, Tripadvisor, and Instagram profiles) and returns clean JSON for each at a flat $0.025 per search, which works out to $25/1k, roughly 40× a general scraper. The other 12 domains simply have no engine. The scripts report them as `missing_data: no dedicated engine` rather than counting them as failures, because asking SerpApi to fetch an arbitrary Zillow page is using it for something it was never built to do. If your work is SERP data, the coverage gap is irrelevant and the structured output is the whole point. [Full data →](test-results/serpapi.json)

## What blocks what

Across all 16 providers, 19 provider-and-domain pairs are genuine blocks, meaning content the provider physically cannot return after we exhausted reasonable tiers. SerpApi's 12 out-of-scope domains sit on top of that. Grouped by cause:

| Cause | Count | Pairs |
|---|---|---|
| No dedicated engine (out of scope) | 12 | SerpApi → bestbuy, booking, capterra, g2, github, idealista, indeed, linkedin, reddit, trustpilot, x, zillow |
| ToS / policy denylist | 5 | Firecrawl → instagram, linkedin, reddit · ScraperAPI → instagram, x |
| Browser-detected (423) | 5 | ScrapingAnt → g2, idealista, linkedin, tripadvisor, trustpilot |
| DataDome wall | 1 | ScrapingBee → g2 |
| Cloudflare Turnstile | 1 | ScrapingDog → g2 |
| Website ban (520) | 1 | Zyte → g2 |
| Domain forbidden (451) | 1 | Zyte → linkedin |
| Geo-fence interstitial | 1 | ZenRows → bestbuy |
| Requests-forbidden policy | 1 | ZenRows → instagram |
| Fetch failed (502) | 1 | ScrapeGraphAI → bestbuy |
| Empty body | 1 | ScrapeGraphAI → zillow |
| reCAPTCHA (429) | 1 | Firecrawl → google |

One pattern is worth calling out. The hardest *technical* target in the set is G2, which blocks five different providers behind DataDome, Cloudflare, and outright bans. The hardest *policy* targets are Instagram, LinkedIn, and X, where several providers simply refuse the request at the gateway regardless of technical capability. None of these are configuration mistakes. Each one was re-verified across independent transports before we marked it a real block.

## Replicate this yourself

You need the provider's API key and either Python 3.8+ or Node 18+. There are no other dependencies. The scripts use only the standard library on the Python side and built-in `fetch` on the Node side.

```bash
# 1. Get the keys you want to test, copy the env template
cp .env.example .env
#    then fill in the variables for the providers you have keys for

# 2. Load your env (or export the one variable you need)
export SCRAPE_DO_TOKEN=your_key_here

# 3. Run a provider (Python)
python test-scripts/scrape-do/test_scrape_do.py

# 3. ...or TypeScript
npx tsx test-scripts/scrape-do/test-scrape-do.ts

# Run more trials to match our sample size (default is 3)
python test-scripts/scrape-do/test_scrape_do.py --trials 30
```

Each script reads only the one environment variable named in [`.env.example`](.env.example) for that provider. Run it with the key unset and it tells you which variable to set, then exits cleanly without ever making a request.

The script prints a per-domain table (status, success rate, average latency) and writes `test-results/<provider>.run.json` in the same shape as the frozen file next to it. Diff the two to see how your run compares to ours:

```bash
python test-scripts/decodo/test_decodo.py --trials 30
# then compare:
git diff --no-index test-results/decodo.json test-results/decodo.run.json
```

Expect differences. Anti-bot defenses change, your IP geography differs from ours, and a provider may have moved a domain to a different tier since June 2026. That drift is exactly what makes a dated snapshot useful, because it gives you a fixed point to measure against.

## Methodology notes and caveats

- **Pass means success rate above zero, not above 90%.** A provider that returns verified content 31% of the time is still capable of scraping that domain. You are paying for that 31%, and you can model cost-per-success on top of it. A block is 0% across every tier we tried. Treating anything under 90% as failure mis-ranks providers, so we don't do it.
- **Recoveries are confirmed over 30 trials, not 3.** A burst of three lucky requests is not a working configuration. We watched ScrapingBee pass G2 three-for-three and then fail 30-for-30 once its IPs were blacklisted. Only results that hold at scale get recorded as operational.
- **Cache hits are excluded.** Firecrawl and SerpApi cache responses, so the scripts bust the cache and latency reflects live fetches rather than replays.
- **Costs are per-domain, not per-provider.** Most providers charge more for protected sites than their headline rate suggests. The cost in each domain's record is the rate for the tier that domain actually needs.
- **This is a snapshot, not a live feed.** The numbers are dated June 2026 and will not be updated. Re-run the scripts for current figures.

---

*Web Scraping API Benchmark 2026. A technical companion to [scrapingtest.com/web-scraping-api](https://scrapingtest.com/web-scraping-api). Report date: 2026-06-08.*
