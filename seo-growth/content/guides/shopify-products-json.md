---
title: "Shopify products.json: Limits, Pagination and What It Returns"
description: "A practical reference to Shopify's public /products.json storefront endpoint — default and max limit, page-based pagination, collection and single-product URLs, and why some stores return 403."
target_keyword: shopify products.json
secondary: [shopify products json pagination, shopify products.json limit, shopify all products json, shopify product json url]
status: draft (do not publish until compliance release T-001 ships)
last_tested: 2026-10-29
---

# Shopify products.json: Limits, Pagination and What It Returns

Every standard Shopify Online Store exposes a read-only JSON feed of its **published** products. It isn't the Admin API and needs no token, and it isn't the Storefront GraphQL API. It's the same data the theme renders, in JSON form.

## The URLs

```
/products.json                                  # all published products
/products.json?limit=250&page=3                 # paging
/collections/{collection-handle}/products.json  # one collection
/products/{product-handle}.json                 # one product (Admin-style shape)
/products/{product-handle}.js                   # one product (theme/AJAX shape, prices in cents)
```

## Limits and pagination (tested 29 Oct 2026)

| Parameter | Behaviour we observed |
|---|---|
| no `limit` | 30 products |
| `limit=250` | 250 products |
| `limit=500` | still 250. **250 is the cap** |
| `page=N` | 1-based page number; an empty `products` array means you've reached the end |

A minimal loop in Python:

```python
import json, time, urllib.request

def all_products(store):
    page, out = 1, []
    while True:
        url = f"{store}/products.json?limit=250&page={page}"
        req = urllib.request.Request(url, headers={"User-Agent": "catalog-research/1.0"})
        batch = json.load(urllib.request.urlopen(req, timeout=20))["products"]
        if not batch:
            return out
        out += batch
        page += 1
        time.sleep(1)  # be polite; storefronts rate-limit aggressive clients
```

## What each product contains

`id, title, handle, body_html, vendor, product_type, tags, created_at, updated_at, published_at, options, images[], variants[]`

Each variant has `id, title, sku, price, compare_at_price, option1–3, grams, requires_shipping, taxable, available` and its position.

**Not included:** inventory quantity, cost per item, metafields, sales data, unpublished or draft products.

## Useful tricks

- **Newest products first.** Sort the results by `created_at` to see what a store launched recently.
- **Price changes.** Snapshot weekly and diff `variants[].price` and `compare_at_price`.
- **Assortment by type.** Group by `product_type` and `vendor`.

## Why you get 403, 404 or HTML instead

- **403.** Bot protection on the store, or your request rate was too high. Stop. Don't rotate IPs or spoof browsers to get around it.
- **404 or HTML.** The site may be headless (Hydrogen or another custom frontend) and not serve the Online Store routes. It may also not be on Shopify at all.
- **Only some products show up.** The feed only includes products published to the Online Store sales channel.

## Don't want to write code?

*Disclosure: we make this.* [Shopify Product Downloader](CWS_LINK) is a free Chrome extension that does the paging for you and saves the result as a Shopify-import-ready CSV or JSON. It can also start from the store's **Best Selling** order.

## Use the data responsibly

The feed is public, but the product photos and descriptions in it are usually copyrighted. Use it for research and analysis, not to clone listings. Keep request rates low.
