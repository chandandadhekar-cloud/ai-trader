# 01 — Product & listing audit

Sources: the live listing fetched on 2026-10-29 and the v5.0.2 package's UI (`popup/*.html`). Only verified facts appear below.

## Baseline (measured 2026-10-29, public listing)

| Metric | Value |
|---|---|
| Listing title | Shopify Product Downloader & Spy Tool |
| Users | 756 |
| Rating | 5.0 from 5 ratings |
| Version / updated | 5.0.2 / May 4, 2026 |
| Category | Workflow & Planning |
| Website / homepage link | **none** |
| Privacy policy | Google Doc |
| Install analytics, Search Console, referral data | **not accessible to me.** The owner can see impressions, installs and uninstalls in the CWS Developer Dashboard under Analytics. Please export them monthly into `records/` so growth can be measured against this baseline. |

## What the product actually does (verified in UI)

- **Stores tab.** Add a Shopify store by URL, keep a list of stores, and sync each one.
- **Products tab.** Choose a collection, All Products, or Best Selling. Page sizes run from 25 to 250. The table shows title, variants, category, vendor, and created, updated and published dates. Download as **Shopify CSV** or **Shopify JSON** ("Shopify Import Supported"). The code reads the store's public `products.json` and also uses `sort-by=best-selling`.
- **Analyse Stores tab.** Store score, SEO score, products score and overall score (scored 0 to 100). It also has Maturity Analytics, Recent Activity, Growth Trends, Legal Compliance, Theme & Apps, Content Analytics and Collections Analytics.
- **Google sign-in is required** before first use (`register.html`).

## Target users

1. Dropshippers and product researchers who want to see a competitor's full catalog, best sellers and pricing in a spreadsheet.
2. Merchants and agencies who need product data from a store they can't get admin access to, such as a supplier's or a client's old store.
3. Shopify freelancers who audit stores (theme, apps, SEO score) for pitches.

## Conversion and positioning problems (ranked)

1. **Compliance blockers.** See `00-compliance-blockers.md`. They also inflate the install-time permission warning ("Read your browsing history", "all websites"). That warning is the single largest drag on install conversion.
2. **Three different names.** The listing says "Shopify Product Downloader & Spy Tool". The app says "Shopify Store Intelligence & Competitor Analyzer Pro". The owner calls it "Shopify Product Downloader & Analyzer". About shows v5.1.0 while the manifest says 5.0.2. Pick one name. The keyword data favours keeping **"Shopify Product Downloader"** at the front of the title.
3. **Name collision.** Another extension is also called "Shopify Product Downloader" (`fappdhgcmmejmmeigmgbnddnjefdkonh`). A distinctive suffix and a homepage help Google and users tell them apart.
4. **Login wall before value.** Competitors advertise "No login, no API". Let people download a first CSV without signing in, and ask for sign-in only for saved stores or analytics.
5. **No homepage.** Without one there's nothing to rank for "how to export Shopify products", no backlink target besides the store page, and no trust signal. `site/` is ready to deploy.
6. **Weak social proof.** Only 5 ratings, against Koala at 770 and the free scraper at 26. Add a non-incentivised "Rate us" prompt after the 3rd successful download. Incentivised reviews violate CWS policy.
7. **Description hygiene.** "Unlimited" and "growth metrics" claims are fine only if they hold for large stores. `products.json` paging can be rate-limited on some stores, so "large catalogs supported" is safer than "unlimited". The ✅ bullets are fine.
8. **Category.** Competitors in this niche use Shopping or Workflow & Planning. Keep it unless the dashboard data shows low category traffic.

## Listing copy

Use this **after** the compliance release ships. It contains no new feature claims; everything below exists in the UI.

**Title (≤75 chars):**
`Shopify Product Downloader – Export Store Products to CSV & Spy Tool` (67)

**Summary (≤132 chars):**
`Export products from any Shopify store to CSV or JSON, find best sellers, and see a store's theme, apps and SEO score.` (118)

**Description (first 3 lines are what Google and the store show):**

```
Download the product catalog of any public Shopify store as a Shopify-import-ready CSV or JSON file, in a few clicks.

Built for dropshippers, merchants and agencies who research competitors:
• Export all products or one collection – titles, descriptions, variants, SKUs, prices, vendors, images (URLs)
• Sort by Best Selling to see a store's top products first
• Store analyser: theme & apps, SEO score, collections and content analytics, recent product activity
• Manage multiple stores and re-sync them with one click
• CSV matches Shopify's product import format

How it works
1. Click the extension and add a store URL.
2. Pick a collection (or All / Best Selling).
3. Choose CSV or JSON and click Download.

Works with stores that expose Shopify's public product feed; some stores disable it.
Please respect store owners' copyrights – product photos and descriptions usually belong to the brand.

Affiliate disclosure: [state exactly which links are affiliate links].
Support: brightgoals20@gmail.com · Guides: [homepage URL once live]
```

**Screenshots (1280×800, five slots).** These need real captures from the owner. Suggested captions:
1. "Export any Shopify store's products to CSV" (Products tab with format dropdown)
2. "Start with the store's best sellers" (Best Selling selected)
3. "See the theme, apps and SEO score" (Analyse tab)
4. "Shopify-import-ready CSV" (the CSV open in Sheets)
5. "Manage all your research stores" (Stores tab)
