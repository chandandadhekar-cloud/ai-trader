# 03 — Strategy, keyword map and prioritised opportunities

## Keyword map

The full list is in `seeds/keywords.csv`: 39 terms from Google autocomplete, which the weekly job expands. There's no volume data without a paid tool, so priority below is my judgement from intent and the competitors visible in results. Treat it as a ranking, not a measurement.

| Cluster | Example terms | Intent | Target page | Difficulty (judged) |
|---|---|---|---|---|
| Brand | shopify product downloader (extension) | navigational | listing title + homepage | low. Name clash with `fappdh…` |
| Export (tool) | shopify product export chrome extension, shopify product scraper free | transactional | homepage | medium. Several extensions plus listicles |
| Export (how-to) | download shopify products csv, export shopify products to csv, …with images | informational | guide: export-shopify-products-csv | medium. The SERP mixes admin-export docs (own store) with scraper guides, so we cover both honestly |
| products.json | shopify products.json, …pagination, …limit | technical | guide: shopify-products-json | low to medium. Dev forums dominate, few polished guides |
| Best sellers | shopify best sellers url, best selling url | informational | guide: best-sellers-theme-apps | low. Short answers, no tools linked |
| Theme/app detect | shopify theme detector, app detector extension | transactional | same guide (section) | high. PageFly, Avada, Meetanshi and Koala own it. Secondary only |
| Analyzer | shopify store analyzer (free/extension) | transactional | homepage | medium |
| Not targeted | export to woocommerce/etsy | — | — | We haven't verified that the CSV maps to those platforms |

## Where growth can realistically come from (ranked)

1. **Fix compliance and the install warning** (T-001). This raises conversion for every other channel and removes takedown risk.
2. **Owned site + 3 guides** (T-008, T-007). Every competitor above 5k users has one. It gives backlinks and Reddit or Quora answers a useful destination, and lets us rank for how-to queries the Chrome Web Store page never will.
3. **Listing optimisation** (T-009). Fix the title and summary, remove the login wall before the first export, and add a ratings prompt. This is free and compounds inside CWS search.
4. **Microsoft Edge Add-ons** (prospect #35). Same package, a second store, free. A second ranking surface for the same keywords.
5. **Editorial inclusion: Do Dropshipping.** It's the one strong independent listicle in the niche, and it lists no catalog exporter today.
6. **AlternativeTo + SaaSHub.** These are "alternatives to Koala Inspector / Shopify Spy" pages where people are actively switching.
7. **YouTube demo.** Search found no competitor video for "export shopify products extension". A 3-minute screen recording can rank on YouTube and in Google video results.
8. **Answer-led community work** on r/shopify, r/dropship and Quora. Only where someone is asking how to get product data from another store, always with disclosure.

## Deliberately not doing

- Buying links (Importify $150 guest posts), bulk directory blasts, PBNs, or comment spam.
- Self-submitting to awesomelistsio/awesome-shopify. Its rules reject self-promotion.
- Answering Shopify Community threads about migrating your **own** store. The native admin export is the right answer there, not our tool.
- Pitching competitor-owned listicles (Koala, Brandsearch, TrendTrack) beyond one low-effort try. They rank their own tools.
- Claiming WooCommerce or Etsy compatibility, "unlimited", or revenue estimates we can't verify.

## Measurement plan

| What | Source | Who can access |
|---|---|---|
| Users, rating, version (public) | `growth.py baseline`, recorded daily | automated ✅ |
| Competitor users and ratings | `growth.py competitors`, weekly | automated ✅ |
| Store impressions, page views, installs, uninstalls, by source | CWS Developer Dashboard › Analytics | **owner only.** Export monthly to `records/cws-analytics-YYYY-MM.csv` |
| Site clicks and impressions by query | Google Search Console | after the site is live, owner verifies via DNS or HTML file |
| Referral traffic to the listing | add `utm_source` to every link we place (CWS analytics shows UTM sources) | automated once links exist |
| Backlinks live/lost, follow/nofollow | `growth.py verify-backlinks` | automated ✅ |
