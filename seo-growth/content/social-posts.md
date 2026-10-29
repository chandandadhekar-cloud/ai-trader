# Social posts pack (owner accounts; post after T-001)

Every post teaches something useful on its own, and the extension appears as one option with the affiliation disclosed. Link to the guide on our site (after T-008), not straight to the store, so the site earns the authority.

## LinkedIn 1: carousel or text
**Hook:** Your competitor's whole product catalog is public. Here's how to read it in 5 minutes.
1. Add `/products.json?limit=250` to almost any Shopify store URL. That's 250 products per page, with variants, prices and tags.
2. Add `&page=2`, `&page=3`… until it comes back empty.
3. Add `?sort_by=best-selling` to a collection URL to see the store's own sales ranking.
4. View source and search for `Shopify.theme` to find the theme.
5. Group by product_type × price band. That's their assortment strategy.
What you *can't* see: inventory, sales, margins. Anyone quoting a competitor's exact revenue is estimating.
(I built a free extension that does steps 1–4 and outputs a Shopify CSV. Link in comments.)

## X thread (5 posts)
1. Every Shopify store publishes a JSON feed of its products. Most store owners don't know, and most researchers don't use it well. 🧵
2. `/products.json?limit=250&page=1` gives 250 products. 250 is the hard cap; asking for 500 still returns 250.
3. `/collections/all?sort_by=best-selling` shows the store's own best-seller ranking. That's order, not sales numbers.
4. View source and search for `Shopify.theme`. `theme_store_id: null` means a custom theme.
5. Full guide with the limits we tested: [guide URL]. Disclosure: I make a free extension that automates this.

## Reddit answer template (only where someone asks how to get another store's products)
> If it's your own store, use Products › Export in the admin. It's more complete than anything external.
> If it's someone else's: most Shopify stores serve `/products.json?limit=250&page=N` (250 max per page, keep paging until it's empty). That gives you titles, variants, prices and tags, but no inventory or sales.
> If you'd rather not reshape the JSON yourself, there are free extensions that output Shopify's CSV format. Disclosure: I make one (Shopify Product Downloader); Shopify Spy is another.
> Either way, don't reuse their photos or descriptions. That's usually a copyright problem.
