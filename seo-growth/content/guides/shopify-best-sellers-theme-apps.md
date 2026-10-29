---
title: "How to See Any Shopify Store's Best Sellers, Theme and Apps"
description: "Three quick checks for Shopify competitor research: the best-selling sort URL, the theme name in the page source, and how to spot installed apps — plus what these signals can and can't tell you."
target_keyword: shopify best sellers url
secondary: [shopify best selling url, shopify theme detector, shopify app detector, shopify store competitor analysis]
status: draft (do not publish until compliance release T-001 ships)
last_tested: 2026-10-29
---

# How to See Any Shopify Store's Best Sellers, Theme and Apps

When you research a Shopify competitor, three questions come up first: *what sells, what is the store built on, and what apps does it rely on?* You can answer all three in a few minutes without paid tools.

## 1. Best sellers: the sort URL

Shopify collections can be sorted by sales. Add the sort parameter to a collection URL:

```
https://store.com/collections/all?sort_by=best-selling
https://store.com/collections/{any-collection}?sort_by=best-selling
```

The first products shown are the ones Shopify ranks highest by the store's own sales.

**Caveats**
- Some stores hide `/collections/all` or redirect it. If so, try a big collection like "shop-all", "new" or "women".
- The ranking is relative. It tells you *order*, not quantities or revenue.
- Merchants can pin products manually in some collections, which overrides the sort on some themes.
- Any tool claiming a store's exact revenue is estimating it. Shopify doesn't publish sales.

## 2. Theme: one line in the page source

Open the store, press **Ctrl+U** (or **Cmd+Option+U** on Mac) to view source, and search for `Shopify.theme`. You'll find something like:

```
Shopify.theme = {"name":"…","schema_name":"Dawn","schema_version":"15.0.0","theme_store_id":887,…}
```

- `schema_name` is the base theme, e.g. Dawn, Impulse or Prestige.
- `theme_store_id` is a number if it came from the Shopify Theme Store, and `null` for custom or heavily modified themes. On 29 Oct 2026, two large beauty brands we checked both showed `null`, meaning custom themes.
- `name` is whatever the merchant named it, which sometimes reveals agency or launch notes.

## 3. Apps: script and asset fingerprints

Shopify doesn't publish a store's app list, so detection works by recognising each app's scripts. In the page source, look for:

- `<script src=…>` domains belonging to app vendors (reviews, upsells, loyalty, chat, cookie banners)
- `/apps/` proxy paths and app-block CSS class names
- Well-known globals in the source, such as review or subscription widgets

Doing this by hand is slow. Detectors keep a fingerprint list for hundreds of apps.

## Doing all three at once

*Disclosure: we make this extension.* [Shopify Product Downloader](CWS_LINK) has an **Analyse Stores** tab that shows the theme and detected apps, plus SEO, product and content scores. Its **Products** tab can list the store's **Best Selling** products and export them to CSV. Other free detectors include Koala Inspector and the theme detectors from PageFly and Avada. They're worth comparing, because app-fingerprint coverage differs between tools.

## What to do with what you find

1. Export the top 50 best sellers and group them by `product_type` and price band. That's the store's real assortment strategy.
2. Note the theme. If it's a Theme Store theme, you can preview the same layout.
3. Look at app categories rather than individual apps: reviews, bundles, subscriptions, upsells. They show where the store invests in conversion.
4. Re-check monthly. New products that appear near the top of the best-selling sort are what's trending for that store.
