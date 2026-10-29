---
title: "How to Export Products from Any Shopify Store to CSV (3 Methods)"
description: "Export a Shopify product catalog to CSV — from your own admin, from any public store's products.json, or with a free Chrome extension. Tested methods, limits and pitfalls."
target_keyword: download shopify products csv
secondary: [export shopify products to csv, shopify download product list, export shopify products with images, copy products from one shopify store to another]
status: draft (do not publish until compliance release T-001 ships)
last_tested: 2026-10-29
---

# How to Export Products from Any Shopify Store to CSV (3 Methods)

There are two very different situations behind "export Shopify products":

- **It's your store.** Use Shopify's built-in export (Method 1). It's free, complete and includes data no outside tool can see, such as inventory and cost.
- **It's someone else's store** (a competitor, a supplier, a client who hasn't given you admin access yet). You can only see what the store publishes. Methods 2 and 3 read that public data.

Pick your situation below.

## Method 1: Your own store (Shopify admin)

1. In Shopify admin, open **Products**.
2. Click **Export**.
3. Choose **Current page**, **All products**, **Selected products**, or **products matching your search**.
4. Choose **CSV for Excel, Numbers, or other spreadsheet programs**, or **Plain CSV file**. Use plain CSV if you'll re-import it into Shopify.
5. Click **Export products**. Small exports download immediately. Large ones are emailed to the account owner as a download link.

**Moving products between two stores you own?** Export from store A and import into store B (**Products › Import**). You don't need a third-party tool. Collections, metaobjects and theme files don't travel in the product CSV. Those need a migration app.

## Method 2: Any public store, by hand (products.json)

Most Shopify storefronts publish a read-only product feed at `/products.json`. We tested this on several stores on 29 Oct 2026:

| Request | What you get |
|---|---|
| `https://store.com/products.json` | 30 products (the default) |
| `https://store.com/products.json?limit=250` | 250 products, the maximum per request (`limit=500` still returns 250) |
| `https://store.com/products.json?limit=250&page=2` | the next 250 |
| `https://store.com/collections/<handle>/products.json` | only that collection |
| `https://store.com/products/<handle>.json` | one product |

Keep increasing `page` until you get an empty `"products": []`.

**What's in it:** title, description HTML, vendor, product type, tags, created/updated/published dates, and every variant (SKU, price, compare-at price, option values, weight, availability flag). Image URLs are included too.
**What's not in it:** inventory quantities, cost, sales numbers, metafields, and unpublished products.

**Turning JSON into CSV.** For a few pages you can paste the JSON into a converter or open it in Google Sheets with a script. For a catalog of 2,000+ products this gets tedious, and each variant has to become its own row to match Shopify's import format. That's where Method 3 saves time.

**When it doesn't work.** Some stores return `403` (bot protection) or aren't on the standard Shopify storefront at all; headless Hydrogen sites, for example, don't have it. In our test, one large store returned 403 for every request. No tool should try to get around that.

## Method 3: Any public store, in a few clicks (Chrome extension)

*Disclosure: we make this extension.*

[Shopify Product Downloader](CWS_LINK) reads the same public feed as Method 2 and turns it into a file for you:

1. Install the extension and open it.
2. Paste the store URL and click **Add Store**.
3. On the **Products** tab, choose a collection, **All Products**, or **Best Selling**.
4. Choose **Shopify – CSV** (import-ready) or **Shopify – JSON**, then click **Download**.

It also has a **Store Analyser** tab (theme and apps, an SEO score, collection and content analytics) if you're researching the store, not just copying a catalog.

Other free options exist as well. Shopify Spy (Scraper & Parser) and "Free Shopify Product Scraper & Exporter" are both on the Chrome Web Store. Compare their export limits before you choose, because some free tiers cap at 100–500 rows.

## Before you import someone else's products

- **Product photos and descriptions are almost always copyrighted** by the brand or store. Use exports for research, such as pricing, assortment, variants and launch timing. Write your own copy and use your own photos or ones your supplier licenses to you.
- If you're dropshipping a supplier's products, ask the supplier for their official catalog CSV. It's usually more complete than any public export.
- Shopify's product import accepts CSV files up to 15 MB. Split bigger files.

## FAQ

**Can I export a Shopify store's sales or inventory?** No. Those aren't public. Tools that show "revenue" are estimating it.

**Can I export product images?** The export includes image URLs. Shopify's importer downloads images from those URLs when you import, but see the copyright note above.

**Why does my export have more rows than products?** Shopify's CSV format uses one row per variant. A t-shirt in 3 sizes × 2 colours is 6 rows.
