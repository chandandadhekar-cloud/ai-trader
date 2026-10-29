# seo-growth: growth ops for Shopify Product Downloader & Spy Tool

This is a self-contained project for SEO, backlink and outreach work on the Chrome extension
[`ccbmjjcmoaiiebhodnmjekhbmgcakjhb`](https://chromewebstore.google.com/detail/shopify-product-downloade/ccbmjjcmoaiiebhodnmjekhbmgcakjhb).
It lives in its own folder and doesn't touch the trading app in the rest of this repo.

> **Read `reports/00-compliance-blockers.md` first.** All outward promotion is on hold until the extension
> stops injecting Amazon affiliate tags and collecting browsing history (task T-001).

## Layout

| Path | What |
|---|---|
| `growth.py` | CLI and scheduled jobs (Python 3.9+ stdlib only) |
| `seeds/*.csv` | Initial research: 60 prospects, 39 keywords, tasks, content. Loaded by `init` |
| `records/*.csv` | Snapshot of the database, rewritten after every run. Review it and commit it |
| `reports/00-03*.md` | Compliance, product audit, competitors, strategy and keyword map |
| `reports/auto/` | Generated daily, weekly and monthly reports |
| `content/guides/` | 3 SEO guides (drafts, facts tested 2026-10-29) |
| `content/social-posts.md`, `content/video-script.md` | Social and YouTube drafts |
| `outreach/` | Personalised pitches and directory copy (**unsent**) |
| `site/` | Static website builder. `site/public/` is the built output |
| `deploy/` | systemd timers, cron alternative, installer |
| `var/` (gitignored) | `growth.db` (SQLite), logs, rotating backups (last 21) |

## Use it

```bash
python3 growth.py init                 # create DB, load seeds/ and records/ (idempotent)
python3 growth.py list                 # top prospects
python3 growth.py due                  # follow-ups due today
python3 growth.py set 1 --status contacted --contacted --next-date 2026-11-06 --next-action "follow up once"
python3 growth.py add-backlink https://site.com/page --notes "Do Dropshipping listicle"   # records it, then verifies it
python3 growth.py run weekly           # what the timer runs
python3 growth.py import prospects new.csv   # add rows (existing rows kept; --overwrite to replace)
```

## What the scheduled jobs do

They only make read-only HTTP GETs. They check robots.txt for third-party sites, pause 1.5 s per host, retry 429/5xx up to 3 times with backoff (2, 4, 8 s), and time out after 20 s. They **never** send email, post, log in or submit anything.

| Job | Steps |
|---|---|
| daily | listing snapshot, verify 10 oldest-checked backlinks, list follow-ups due |
| weekly | the daily steps plus: verify all backlinks, competitor snapshots, new autocomplete keywords, scan listicle and resource prospects for new mentions of us |
| monthly | the weekly steps plus: channel review by opportunity type and status, user-count trend |

Every step is isolated, so one failure is logged and the rest of the run continues; the run is then marked `partial`. A non-blocking file lock exits with code 75 if another job is already running, so runs never overlap. Each run backs up the DB, exports `records/`, and writes `reports/auto/<date>-<job>.md`.

## Scheduling

This was built in a short-lived cloud container that has no cron and doesn't persist, so nothing is scheduled yet. To run it on your VPS:

```bash
git clone … && cd ai-trader/seo-growth
sudo ./deploy/install.sh    # creates user growthops, copies to /opt/seo-growth, enables 3 timers
systemctl list-timers 'growth-ops-*'
journalctl -u 'growth-ops@*' -n 50
```

The schedule is daily at 06:20, Monday at 07:10, and the 1st of each month at 08:05 (server time, with up to 20 min of random delay). The units run as an unprivileged user with `ProtectSystem=strict`. No ports are opened and there is no dashboard.
Prefer cron? Use `deploy/crontab.example` instead of the timers, not alongside them.

**Disable:** `sudo systemctl disable --now growth-ops-daily.timer growth-ops-weekly.timer growth-ops-monthly.timer`
**Remove:** also run `sudo rm /etc/systemd/system/growth-ops*` and `sudo systemctl daemon-reload`.

## Website

```bash
pip install markdown
SITE_URL=https://your-domain python3 site/build.py   # writes site/public/
```

Host `site/public/` on any static host, for example GitHub Pages or Cloudflare Pages (both free). Then add the URL as the homepage in the Chrome Web Store dashboard and verify it in Google Search Console. **Don't publish until T-001 ships.** The privacy page is a placeholder for the corrected policy.

## Re-checking the extension package after a release

```bash
mkdir -p /tmp/crx && cd /tmp/crx
curl -sSL -o ext.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx2,crx3&x=id%3Dccbmjjcmoaiiebhodnmjekhbmgcakjhb%26uc"
python3 -c "import zipfile,io;b=open('ext.crx','rb').read();zipfile.ZipFile(io.BytesIO(b[b.find(b'PK\x03\x04'):])).extractall('x')"
grep -c amazon x/manifest.json; grep -l "history'\]\['search" -r x || echo "no history collection"
```

## Data and privacy

The database holds only public business contact points (site contact emails and forms). It stores no personal data about individuals beyond named article authors, and no credentials. Don't put passwords, OTPs or session cookies in any file here.
