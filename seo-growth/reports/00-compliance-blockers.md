# 00 — Compliance blockers (read first)

**Status:** blocks all outward promotion (outreach, directory submissions, community posts, paid placements).
**Found:** 2026-10-29, by downloading the published v5.0.2 package from Google's update service and reading its manifest and JS. Nothing was executed.

## Why this comes before marketing

Every backlink, directory listing and article we earn points at one Chrome Web Store URL. If the item is taken down for a policy violation, all of that work points at a dead page. Reviewers we pitch (Do Dropshipping does "hands-on testing") and security aggregators (Extension Auditor already flags competitors for broad permissions) would see the behaviour below. Sending more users to it before it is fixed would also expose them to data collection they were not clearly told about. Fixing this is the highest-return growth task available.

## Findings (v5.0.2, verified in code)

| # | Behaviour | Where | Chrome Web Store policy it conflicts with |
|---|---|---|---|
| 1 | On any Amazon page (all 20 country domains), once per 12 hours, rewrites the URL to set `tag=279587898-21`, **replacing any existing affiliate tag**, then redirects. No user action involved. | `popup/assets/js/amazon_affiliate.js` (content script, `run_at: document_start`) | [Affiliate Ads](https://developer.chrome.com/docs/webstore/program-policies/affiliate-ads): "Related user action is required before the inclusion of each affiliate code, link, or cookie"; prohibits "adding, replacing, or applying affiliate codes … in URLs without the user's explicit knowledge"; requires a direct user benefit tied to core functionality. Likely also conflicts with the Amazon Associates operating agreement. |
| 2 | Reads browser history (up to 10,000 entries, starting 7 days back, then incrementally), all open tab URLs and titles, and search queries typed into Google/Bing/Yahoo/DuckDuckGo. Looks up city/region/ISP via `ipapi.co`. POSTs it all, keyed to the user's Google account email, to `https://orbitags.com/shopify_api`. | `service-worker.js` (`pullAndMergeBrowseHistory`, `backgroundFlush`), `popup/assets/js/custom.js` (`pullBrowserHistory`, `captureSearchesFromTabs`, `flushToAPI`) | [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use): "Collection and use of web browsing activity is prohibited, except to the extent required for a user-facing feature" described prominently in the listing and the UI; data must be "necessary for the extension's disclosed single purpose". The listing's privacy section certifies data is "not being used … for purposes that are unrelated to the item's core functionality". |
| 3 | JS is obfuscated (`/* Protected build */`, hex literals, bracket-string property access, `\x20`-escaped strings). | `custom.js`, `service-worker.js`, `amazon_affiliate.js` | [Code Readability](https://developer.chrome.com/docs/webstore/program-policies/code-readability): "Developers must not obfuscate code or conceal functionality." Minification is allowed; this goes beyond it. |
| 2b | The sign-in consent screen (`register.html`) says it collects "Shopify & ecommerce store pages you visit & search" and "Open browser tabs (used for store analytics)". The code collects **all** history and **all** search-engine queries. It filters only browser-internal URLs, not non-ecommerce sites. | `register.html` vs `custom.js` | The disclosure understates the collection. That makes finding 2 worse, not better. |
| 4 | Permissions are broader than the downloader needs: `history`, `tabs`, `identity`, `system.display`, `host_permissions: *://*/*`. | `manifest.json` | Not a violation by itself, but it inflates the install warning ("Read and change all your data on all websites", "Read your browsing history"), which lowers install conversion and security-scanner scores. |

## Fix checklist (ship as v5.0.3)

1. Delete `amazon_affiliate.js` and its `content_scripts` entry. If you want affiliate revenue, use a visible, user-clicked link inside the popup that is disclosed there and on the listing (for example, the Shopify app partner links already in the app-detection UI).
2. Remove history, tab and search-query collection and the `ipapi.co` lookup. Keep only what a user-facing feature needs, such as the stores a user adds and download events, and only with consent.
3. Drop the `history` permission. Replace `*://*/*` with optional host permissions requested per store when the user clicks "Add Store", or with `activeTab`. Drop `tabs`, `identity`, `system.display` unless a visible feature needs them.
4. Ship readable, minified-only builds.
5. Update the Chrome Web Store privacy practices form and the privacy policy so they match exactly what is collected.
6. In the listing, replace the vague "uses affiliate programs" line with a specific one, such as "Some app links in the Apps tab are affiliate links."

Once v5.0.3 is live, re-run `python3 growth.py baseline` and unpack the new package again (commands in README) to confirm items 1 to 4 are gone. Then move T-010 and T-011 out of `blocked`.

## Not verified

- I did not run the extension or observe network traffic. The findings come from reading the shipped code.
- I don't know what `orbitags.com` stores or how long it keeps data.
- I did not check whether the developer account received any policy warnings.
