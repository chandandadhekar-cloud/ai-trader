#!/usr/bin/env python3
"""Build the static marketing site into site/public/.

Usage:  SITE_URL=https://example.com python3 site/build.py
Needs:  pip install markdown
The guides come from content/guides/*.md (front matter + markdown).
"""
import datetime as dt
import html
import os
import re
import shutil

import markdown

ROOT = os.path.dirname(os.path.abspath(__file__))
GUIDES = os.path.join(ROOT, "..", "content", "guides")
OUT = os.path.join(ROOT, "public")
SITE_URL = os.environ.get("SITE_URL", "https://REPLACE-WITH-DOMAIN").rstrip("/")
CWS = "https://chromewebstore.google.com/detail/shopify-product-downloade/ccbmjjcmoaiiebhodnmjekhbmgcakjhb"
EMAIL = "brightgoals20@gmail.com"
PRIVACY_DOC = "https://docs.google.com/document/d/1vGKoRfZTtfHUZjv7xhEUUyXmkL6c_oHMhoT-rWwSRCc/edit?usp=sharing"


def cws_link(medium):
    return f"{CWS}?utm_source=website&utm_medium={medium}"


CSS = """
:root{--bg:#fbfbf9;--fg:#1d1f21;--muted:#5d6166;--card:#fff;--line:#e4e4df;--accent:#0a7a52;--accent-fg:#fff;--code:#f1f1ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121413;--fg:#e8e8e4;--muted:#a3a7a5;--card:#1b1e1c;--line:#2c302d;--accent:#3fbf8a;--accent-fg:#0b1410;--code:#222624}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent)}header,main,footer{max-width:760px;margin:0 auto;padding:0 16px}
header{display:flex;justify-content:space-between;align-items:center;padding-top:20px;gap:12px;flex-wrap:wrap}
header a.brand{font-weight:700;color:var(--fg);text-decoration:none}nav a{margin-left:14px;color:var(--muted);text-decoration:none;font-size:15px}
h1{font-size:clamp(28px,5vw,40px);line-height:1.2;margin:40px 0 12px}h2{margin-top:40px}.lede{font-size:19px;color:var(--muted)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:28px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}.card h3{margin:0 0 6px;font-size:17px}.card p{margin:0;color:var(--muted);font-size:15px}
pre,code{background:var(--code);border-radius:6px;font-size:14px}pre{padding:12px;overflow-x:auto}code{padding:1px 4px}pre code{padding:0}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:15px}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
.note{border-left:3px solid var(--accent);padding:4px 14px;color:var(--muted)}footer{margin-top:60px;padding-bottom:40px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:16px}
"""


def page(title, description, body, path, extra_head=""):
    canonical = f"{SITE_URL}/{path}".rstrip("/") + ("/" if path == "" else "")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><meta name="description" content="{html.escape(description)}">
<link rel="canonical" href="{canonical}"><meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(description)}"><meta property="og:type" content="website">
<style>{CSS}</style>{extra_head}</head><body>
<header><a class="brand" href="/">Shopify Product Downloader</a><nav><a href="/guides/">Guides</a><a href="/privacy.html">Privacy</a><a href="{cws_link('nav')}">Add to Chrome</a></nav></header>
<main>{body}</main>
<footer>Free Chrome extension for Shopify catalog research · <a href="mailto:{EMAIL}">{EMAIL}</a> · Not affiliated with Shopify Inc.</footer>
</body></html>"""


def parse_guide(path):
    raw = open(path, encoding="utf-8").read()
    m = re.match(r"---\n(.*?)\n---\n(.*)", raw, re.S)
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"')
    body_md = m.group(2).replace("(CWS_LINK)", f"({cws_link('guide')})")
    body_md = re.sub(r"^# .*\n", "", body_md, count=1)  # title rendered separately
    body = markdown.markdown(body_md, extensions=["tables", "fenced_code"])
    slug = os.path.splitext(os.path.basename(path))[0]
    return slug, meta, body


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "guides"))
    guides = [parse_guide(os.path.join(GUIDES, f)) for f in sorted(os.listdir(GUIDES)) if f.endswith(".md")]
    urls = [""]

    for slug, meta, body in guides:
        ld = ('<script type="application/ld+json">{"@context":"https://schema.org","@type":"TechArticle",'
              f'"headline":{html.escape(meta["title"])!r},"dateModified":"{meta.get("last_tested", "")}"}}</script>').replace("'", '"')
        content = (f'<h1>{html.escape(meta["title"])}</h1><p class="lede">{html.escape(meta["description"])}</p>'
                   f'<p class="note">Last tested {meta.get("last_tested", "")}.</p>{body}'
                   f'<p><a class="btn" href="{cws_link("guide-cta")}">Add to Chrome (free)</a></p>')
        open(os.path.join(OUT, "guides", f"{slug}.html"), "w", encoding="utf-8").write(
            page(meta["title"], meta["description"], content, f"guides/{slug}.html", ld))
        urls.append(f"guides/{slug}.html")

    items = "".join(f'<div class="card"><h3><a href="/guides/{s}.html">{html.escape(m["title"])}</a></h3><p>{html.escape(m["description"])}</p></div>'
                    for s, m, _ in guides)
    open(os.path.join(OUT, "guides", "index.html"), "w", encoding="utf-8").write(
        page("Shopify catalog research guides", "Tested how-to guides for exporting and analysing Shopify store product data.",
             f"<h1>Guides</h1><div class='cards'>{items}</div>", "guides/"))
    urls.append("guides/")

    home = f"""
<h1>Export any Shopify store's products to CSV, free</h1>
<p class="lede">A Chrome extension for dropshippers, merchants and agencies. Add a store, then download its public catalog as a Shopify-import-ready CSV or JSON, and see its best sellers, theme and apps.</p>
<p><a class="btn" href="{cws_link('hero')}">Add to Chrome, it's free</a></p>
<div class="cards">
<div class="card"><h3>Full catalog export</h3><p>All products or one collection: variants, SKUs, prices, vendors, image URLs.</p></div>
<div class="card"><h3>Best sellers first</h3><p>Uses the store's own best-selling order.</p></div>
<div class="card"><h3>Store analyser</h3><p>Theme, detected apps, SEO, product and content scores.</p></div>
<div class="card"><h3>Shopify import format</h3><p>One row per variant, ready for Products › Import.</p></div>
</div>
<h2>How it works</h2>
<ol><li>Open the extension and add a store URL.</li><li>Pick a collection, All Products or Best Selling.</li><li>Choose CSV or JSON and click Download.</li></ol>
<h2>What it can't do</h2>
<p>It only reads data a store publishes publicly. There's no inventory, cost or sales data, and some stores block their public feed. Product photos and descriptions usually belong to the brand, so use exports for research, not to clone listings.</p>
<h2>Guides</h2><div class="cards">{items}</div>
"""
    ld = ('<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication",'
          '"name":"Shopify Product Downloader","applicationCategory":"BrowserApplication","operatingSystem":"Chrome",'
          f'"offers":{{"@type":"Offer","price":"0","priceCurrency":"USD"}},"url":"{CWS}"}}</script>')
    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(
        page("Shopify Product Downloader – Export Store Products to CSV (Free Chrome Extension)",
             "Free Chrome extension: export any public Shopify store's products to CSV or JSON, find best sellers, and see its theme and apps.",
             home, "", ld))

    open(os.path.join(OUT, "privacy.html"), "w", encoding="utf-8").write(page(
        "Privacy policy", "Privacy policy for the Shopify Product Downloader Chrome extension.",
        f"<h1>Privacy policy</h1><p class='note'>OWNER: replace this page with the final policy text, which must match the v5.0.3 data practices. "
        f"Until then the current policy is <a href='{PRIVACY_DOC}'>here</a>.</p>", "privacy.html"))
    urls.append("privacy.html")

    today = dt.date.today().isoformat()
    open(os.path.join(OUT, "sitemap.xml"), "w", encoding="utf-8").write(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"<url><loc>{SITE_URL}/{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls) + "</urlset>\n")
    open(os.path.join(OUT, "robots.txt"), "w", encoding="utf-8").write(f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n")
    print(f"built {len(urls)} pages into {OUT}")


if __name__ == "__main__":
    main()
