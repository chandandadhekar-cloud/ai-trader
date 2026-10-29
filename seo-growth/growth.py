#!/usr/bin/env python3
"""Growth ops tracker for the Shopify Product Downloader & Spy Tool Chrome extension.

Stdlib only. State lives in $GROWTH_HOME/var (SQLite DB, logs, backups); human-readable
snapshots are exported to records/*.csv so they can be reviewed and versioned.

Jobs only *read* the public web (listing pages, prospect pages, autocomplete). They never
send email, submit forms, post, or log in anywhere. Outreach stays a manual, approved step.
"""
import argparse
import csv
import datetime as dt
import fcntl
import html
import json
import logging
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

HOME = os.path.abspath(os.environ.get("GROWTH_HOME", os.path.dirname(os.path.abspath(__file__))))
VAR = os.path.join(HOME, "var")
DB_PATH = os.path.join(VAR, "growth.db")
LOG_DIR = os.path.join(VAR, "logs")
BACKUP_DIR = os.path.join(VAR, "backups")
RECORDS = os.path.join(HOME, "records")
SEEDS = os.path.join(HOME, "seeds")
REPORTS = os.path.join(HOME, "reports", "auto")

EXT_ID = "ccbmjjcmoaiiebhodnmjekhbmgcakjhb"
LISTING_URL = f"https://chromewebstore.google.com/detail/shopify-product-downloade/{EXT_ID}?hl=en"
# Anything linking to one of these counts as a backlink to us. Add the website domain once it exists.
TARGET_PATTERNS = [EXT_ID] + [p for p in os.environ.get("GROWTH_TARGET_DOMAINS", "").split(",") if p]
BRAND_TERMS = ["Shopify Product Downloader & Spy", "Shopify Product Downloader &amp; Spy", EXT_ID]

COMPETITORS = {
    "free-shopify-product-scraper": "https://chromewebstore.google.com/detail/free-shopify-product-scra/cpgnbnkicmfhkglagioeamammaefejeg?hl=en",
    "shopify-spy-scraper-parser": "https://chromewebstore.google.com/detail/shopify-scraper-parser-sh/injdgfhiepghpnihhgmkejcjnoohaibm?hl=en",
    "koala-inspector": "https://chromewebstore.google.com/detail/shopify-spy-tool-sales-tr/hjbfbllnfhppnhjdhhbmjabikmkfekgf?hl=en",
    "meetanshi-shopify-scraper": "https://chromewebstore.google.com/detail/shopify-products-scraper/ephoekniabklgfanmiommibapgbingmj?hl=en",
    "name-clash-shopify-product-downloader": "https://chromewebstore.google.com/detail/shopify-product-downloade/fappdhgcmmejmmeigmgbnddnjefdkonh?hl=en",
}

KEYWORD_SEEDS = [
    "shopify product downloader", "shopify product export", "export shopify products",
    "shopify product scraper", "shopify scraper", "download shopify products",
    "shopify product research", "shopify competitor analysis", "shopify spy",
    "shopify products.json", "shopify theme detector", "shopify app detector",
    "shopify best sellers", "copy products from shopify store",
    "import products from another shopify store", "shopify store analyzer",
]

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 growth-ops-research"
HTTP_TIMEOUT = 20
POLITE_DELAY = 1.5

SCHEMA = """
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY,
  page_url TEXT UNIQUE NOT NULL,
  website TEXT, domain TEXT, opportunity_type TEXT, contact TEXT,
  relevance INTEGER, audience TEXT, quality_notes TEXT, spam_risk TEXT, cost TEXT,
  proposed_target TEXT, priority INTEGER,
  status TEXT DEFAULT 'researched', last_contact TEXT, next_action TEXT, next_action_date TEXT,
  response TEXT, notes TEXT, created TEXT, updated TEXT
);
CREATE TABLE IF NOT EXISTS backlinks (
  id INTEGER PRIMARY KEY,
  source_url TEXT UNIQUE NOT NULL, target_url TEXT, anchor TEXT, link_type TEXT,
  discovered TEXT, last_verified TEXT, status TEXT DEFAULT 'pending', http_status INTEGER,
  quality_notes TEXT
);
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY,
  topic TEXT UNIQUE NOT NULL, target_keyword TEXT, status TEXT, platform TEXT, file_path TEXT,
  published_url TEXT, promotion_status TEXT, results TEXT, updated TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, objective TEXT, priority INTEGER, status TEXT, log TEXT, evidence TEXT,
  failure_reason TEXT, next_action TEXT, updated TEXT
);
CREATE TABLE IF NOT EXISTS keywords (
  keyword TEXT PRIMARY KEY, seed TEXT, source TEXT, first_seen TEXT, last_seen TEXT,
  intent TEXT, cluster TEXT, priority INTEGER, target_page TEXT
);
CREATE TABLE IF NOT EXISTS metrics (
  date TEXT, source TEXT, metric TEXT, value TEXT, PRIMARY KEY (date, source, metric)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, job TEXT, started TEXT, finished TEXT, status TEXT, detail TEXT
);
"""

TABLE_KEYS = {"prospects": "page_url", "backlinks": "source_url", "content": "topic",
              "tasks": "id", "keywords": "keyword", "metrics": None}

log = logging.getLogger("growth")


def today():
    return dt.date.today().isoformat()


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


def setup_logging():
    os.makedirs(LOG_DIR, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.FileHandler(os.path.join(LOG_DIR, f"growth-{dt.date.today():%Y-%m}.log"))
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    log.handlers[:] = [fh, sh]
    log.setLevel(logging.INFO)


def connect():
    os.makedirs(VAR, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    return db


class Lock:
    """Non-blocking exclusive lock so scheduled jobs never overlap."""

    def __init__(self, name="growth"):
        os.makedirs(VAR, exist_ok=True)
        self.path = os.path.join(VAR, f"{name}.lock")

    def __enter__(self):
        self.fh = open(self.path, "w")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.warning("another growth job holds the lock; exiting")
            sys.exit(75)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


# ---------------------------------------------------------------- HTTP

_robots = {}
_last_hit = {}


def allowed_by_robots(url):
    parts = urllib.parse.urlsplit(url)
    if parts.netloc.endswith(("chromewebstore.google.com", "suggestqueries.google.com")):
        return True  # public listing pages / autocomplete API, fetched at very low volume
    base = f"{parts.scheme}://{parts.netloc}"
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                rp.parse(r.read().decode("utf-8", "replace").splitlines())
        except Exception:
            rp.parse([])  # unreachable robots.txt -> treat as allow-all
        _robots[base] = rp
    return _robots[base].can_fetch(USER_AGENT, url)


def fetch(url, retries=3):
    """GET with per-host politeness delay, robots.txt check and exponential backoff.
    Returns (status, text). status 0 means network failure, -1 means disallowed by robots."""
    if not allowed_by_robots(url):
        log.info("robots.txt disallows %s", url)
        return -1, ""
    host = urllib.parse.urlsplit(url).netloc
    wait = POLITE_DELAY - (time.time() - _last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    delay = 2
    for attempt in range(retries + 1):
        _last_hit[host] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en"})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            return e.code, ""
        except Exception as e:
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            log.warning("fetch failed %s: %s", url, e)
            return 0, ""


# ---------------------------------------------------------------- parsing

def parse_listing(page):
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", text))
    text = re.sub(r"\n\s*\n+", "\n", text)
    out = {}
    m = re.search(r"<title>(.*?)</title>", page, re.S)
    if m:
        out["title"] = html.unescape(m.group(1)).replace(" - Chrome Web Store", "").strip()
    m = re.search(r"\n([\d,]+\+?) users?\n", text)
    if m:
        out["users"] = m.group(1).replace(",", "").rstrip("+")
    m = re.search(r"\n(\d\.\d)\n\(\n([\d,.K]+) ratings?", text)
    if m:
        out["rating"], out["rating_count"] = m.group(1), m.group(2)
    for key, label in (("version", "Version"), ("updated", "Updated")):
        m = re.search(rf"\n{label}\n(.*?)\n", text)
        if m:
            out[key] = m.group(1).strip()
    return out


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self._open = [], None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            a = dict(attrs)
            self._open = {"href": a.get("href") or "", "rel": (a.get("rel") or "").lower(), "text": ""}

    def handle_data(self, data):
        if self._open is not None:
            self._open["text"] += data

    def handle_endtag(self, tag):
        if tag == "a" and self._open is not None:
            self._open["text"] = " ".join(self._open["text"].split())
            self.links.append(self._open)
            self._open = None


def find_our_links(page):
    p = LinkParser()
    try:
        p.feed(page)
    except Exception:
        pass
    hits = []
    for link in p.links:
        if any(t in link["href"] for t in TARGET_PATTERNS):
            rel = link["rel"]
            kind = "sponsored" if "sponsored" in rel else "ugc" if "ugc" in rel else "nofollow" if "nofollow" in rel else "follow"
            hits.append({"href": link["href"], "anchor": link["text"][:200], "link_type": kind})
    return hits


# ---------------------------------------------------------------- jobs

def record_metrics(db, source, values):
    for k, v in values.items():
        db.execute("INSERT OR REPLACE INTO metrics(date, source, metric, value) VALUES (?,?,?,?)",
                   (today(), source, k, str(v)))
    db.commit()


def job_baseline(db):
    status, page = fetch(LISTING_URL)
    if status != 200:
        raise RuntimeError(f"listing fetch returned {status}")
    data = parse_listing(page)
    if "users" not in data:
        raise RuntimeError("listing parsed without a user count; page layout may have changed")
    record_metrics(db, "our-listing", data)
    log.info("baseline %s", data)
    return data


def job_competitors(db):
    out = {}
    for name, url in COMPETITORS.items():
        status, page = fetch(url)
        if status == 200:
            out[name] = parse_listing(page)
            record_metrics(db, f"competitor:{name}", out[name])
        else:
            log.warning("competitor %s fetch returned %s", name, status)
    return out


def job_keywords(db):
    new = []
    for seed in KEYWORD_SEEDS:
        q = urllib.parse.urlencode({"client": "firefox", "q": seed})
        status, body = fetch("https://suggestqueries.google.com/complete/search?" + q)
        if status != 200:
            continue
        try:
            suggestions = json.loads(body)[1]
        except (ValueError, IndexError):
            continue
        for kw in suggestions:
            kw = kw.strip().lower()
            cur = db.execute("SELECT keyword FROM keywords WHERE keyword=?", (kw,)).fetchone()
            if cur:
                db.execute("UPDATE keywords SET last_seen=? WHERE keyword=?", (today(), kw))
            else:
                db.execute("INSERT INTO keywords(keyword, seed, source, first_seen, last_seen) VALUES (?,?,?,?,?)",
                           (kw, seed, "google-autocomplete", today(), today()))
                new.append(kw)
    db.commit()
    log.info("keywords: %d new", len(new))
    return new


def job_verify_backlinks(db, sample=None):
    rows = db.execute("SELECT * FROM backlinks ORDER BY COALESCE(last_verified,'') ASC").fetchall()
    if sample:
        rows = rows[:sample]
    changes = []
    for row in rows:
        status, page = fetch(row["source_url"])
        if status in (0, -1):
            continue  # network failure / robots: keep the previous verdict rather than guessing
        hits = find_our_links(page) if status == 200 else []
        new_status = "live" if hits else "lost"
        link_type = hits[0]["link_type"] if hits else row["link_type"]
        anchor = hits[0]["anchor"] if hits else row["anchor"]
        if new_status != row["status"]:
            changes.append((row["source_url"], row["status"], new_status))
        db.execute("UPDATE backlinks SET status=?, http_status=?, link_type=?, anchor=?, last_verified=? WHERE id=?",
                   (new_status, status, link_type, anchor, now(), row["id"]))
    db.commit()
    return changes


def job_scan_mentions(db):
    """Re-check listicle/resource prospects: did they add us (linked or unlinked mention)?"""
    rows = db.execute("SELECT * FROM prospects WHERE opportunity_type IN ('listicle-inclusion','resource-page','awesome-list','directory') "
                      "AND status NOT IN ('rejected','dead')").fetchall()
    found = []
    for row in rows:
        status, page = fetch(row["page_url"])
        if status != 200:
            continue
        hits = find_our_links(page)
        mentioned = any(t in page for t in BRAND_TERMS)
        if hits:
            db.execute("INSERT OR IGNORE INTO backlinks(source_url, target_url, anchor, link_type, discovered, status) VALUES (?,?,?,?,?,?)",
                       (row["page_url"], hits[0]["href"], hits[0]["anchor"], hits[0]["link_type"], today(), "pending"))
            db.execute("UPDATE prospects SET status='placed', updated=? WHERE id=?", (now(), row["id"]))
            found.append((row["page_url"], "linked"))
        elif mentioned:
            db.execute("UPDATE prospects SET notes=COALESCE(notes,'')||? , updated=? WHERE id=?",
                       (f" [{today()}: unlinked mention found - ask for link]", now(), row["id"]))
            found.append((row["page_url"], "unlinked"))
    db.commit()
    return found


def due_followups(db):
    return db.execute("SELECT * FROM prospects WHERE next_action_date IS NOT NULL AND next_action_date<>'' "
                      "AND next_action_date<=? AND status NOT IN ('placed','rejected','dead') "
                      "ORDER BY priority DESC", (today(),)).fetchall()


def backup(db):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    path = os.path.join(BACKUP_DIR, f"growth-{dt.datetime.now():%Y%m%d-%H%M%S}.db")
    dest = sqlite3.connect(path)
    db.backup(dest)
    dest.close()
    keep = sorted(f for f in os.listdir(BACKUP_DIR) if f.endswith(".db"))
    for old in keep[:-21]:
        os.remove(os.path.join(BACKUP_DIR, old))
    return path


def export_csv(db):
    os.makedirs(RECORDS, exist_ok=True)
    for table, key in TABLE_KEYS.items():
        rows = db.execute(f"SELECT * FROM {table} ORDER BY {key or 'date, source, metric'}").fetchall()
        cols = [d[1] for d in db.execute(f"PRAGMA table_info({table})")]
        tmp = os.path.join(RECORDS, f".{table}.csv.tmp")
        with open(tmp, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for r in rows:
                w.writerow([r[c] for c in cols])
        os.replace(tmp, os.path.join(RECORDS, f"{table}.csv"))


def import_csv(db, path, table, overwrite=False):
    """Idempotent load. Default keeps existing rows (DB wins); --overwrite lets the CSV win."""
    cols = [d[1] for d in db.execute(f"PRAGMA table_info({table})")]
    n = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            row = {k: (v if v != "" else None) for k, v in row.items() if k in cols and k != "id"}
            if table == "prospects":
                row.setdefault("created", now())
                row["updated"] = now()
                if row.get("page_url") and not row.get("domain"):
                    row["domain"] = urllib.parse.urlsplit(row["page_url"]).netloc.removeprefix("www.")
            verb = "INSERT OR REPLACE" if overwrite else "INSERT OR IGNORE"
            cur = db.execute(f"{verb} INTO {table}({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
            n += cur.rowcount
    db.commit()
    return n


def write_report(db, job, sections):
    os.makedirs(REPORTS, exist_ok=True)
    counts = {
        "prospects": db.execute("SELECT status, COUNT(*) c FROM prospects GROUP BY status").fetchall(),
        "backlinks": db.execute("SELECT status, COUNT(*) c FROM backlinks GROUP BY status").fetchall(),
        "content": db.execute("SELECT status, COUNT(*) c FROM content GROUP BY status").fetchall(),
    }
    lines = [f"# {job.title()} growth report - {today()}", "",
             "_Generated by growth.py. Only measured values are shown; nothing here is estimated._", ""]
    hist = db.execute("SELECT date, metric, value FROM metrics WHERE source='our-listing' AND metric IN ('users','rating','rating_count') "
                      "ORDER BY date DESC LIMIT 30").fetchall()
    if hist:
        lines += ["## Chrome Web Store listing (public numbers)", "", "| date | metric | value |", "|---|---|---|"]
        lines += [f"| {r['date']} | {r['metric']} | {r['value']} |" for r in hist[:9]]
        lines.append("")
    for name, rows in counts.items():
        lines.append(f"**{name}:** " + (", ".join(f"{r['status']}={r['c']}" for r in rows) or "none"))
    lines.append("")
    for title, body in sections:
        lines += [f"## {title}", "", body or "_nothing_", ""]
    path = os.path.join(REPORTS, f"{today()}-{job}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def fmt_rows(rows, cols):
    if not rows:
        return "_none_"
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        out.append("| " + " | ".join(str(r[c] or "").replace("|", "/")[:90] for c in cols) + " |")
    return "\n".join(out)


def run_job(db, job):
    """Each step is isolated: one failure is logged and the rest of the run continues."""
    started, sections, failures = now(), [], []

    def step(name, fn):
        try:
            return fn()
        except Exception as e:
            log.exception("step %s failed", name)
            failures.append(f"{name}: {e}")
            return None

    data = step("baseline", lambda: job_baseline(db))
    if data:
        sections.append(("Listing snapshot", "\n".join(f"- {k}: {v}" for k, v in data.items())))
    if job == "daily":
        ch = step("verify-backlinks", lambda: job_verify_backlinks(db, sample=10))
        sections.append(("Backlink status changes (sample of 10)", "\n".join(f"- {u}: {a} -> {b}" for u, a, b in ch or [])))
        sections.append(("Follow-ups due", fmt_rows(due_followups(db), ["priority", "domain", "status", "next_action", "next_action_date"])))
    if job in ("weekly", "monthly"):
        ch = step("verify-backlinks", lambda: job_verify_backlinks(db))
        sections.append(("Backlink status changes", "\n".join(f"- {u}: {a} -> {b}" for u, a, b in ch or [])))
        comp = step("competitors", lambda: job_competitors(db)) or {}
        sections.append(("Competitor listings", "\n".join(f"- {k}: users={v.get('users')} rating={v.get('rating')} ({v.get('rating_count')}) updated={v.get('updated')}" for k, v in comp.items())))
        new_kw = step("keywords", lambda: job_keywords(db)) or []
        sections.append(("New autocomplete keywords", "\n".join(f"- {k}" for k in new_kw)))
        found = step("scan-mentions", lambda: job_scan_mentions(db)) or []
        sections.append(("New mentions on prospect pages", "\n".join(f"- {u} ({k})" for u, k in found)))
        sections.append(("Follow-ups due", fmt_rows(due_followups(db), ["priority", "domain", "status", "next_action", "next_action_date"])))
    if job == "monthly":
        by_type = db.execute("SELECT opportunity_type, status, COUNT(*) c FROM prospects GROUP BY 1,2 ORDER BY 1").fetchall()
        sections.append(("Channel review (prospects by type/status)", fmt_rows(by_type, ["opportunity_type", "status", "c"])))
        users = db.execute("SELECT date, value FROM metrics WHERE source='our-listing' AND metric='users' ORDER BY date").fetchall()
        if len(users) >= 2:
            sections.append(("User count trend", f"{users[0]['date']}: {users[0]['value']} -> {users[-1]['date']}: {users[-1]['value']}"))
    if failures:
        sections.append(("Failures", "\n".join(f"- {f}" for f in failures)))
    step("backup", lambda: backup(db))
    step("export", lambda: export_csv(db))
    report = write_report(db, job, sections)
    db.execute("INSERT INTO runs(job, started, finished, status, detail) VALUES (?,?,?,?,?)",
               (job, started, now(), "partial" if failures else "ok", "; ".join(failures)[:2000]))
    db.commit()
    log.info("%s run finished (%s); report %s", job, "partial" if failures else "ok", report)
    return report, failures


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create DB and load seeds + records (idempotent)")
    p = sub.add_parser("import", help="load a CSV into a table")
    p.add_argument("table", choices=list(TABLE_KEYS))
    p.add_argument("path")
    p.add_argument("--overwrite", action="store_true", help="CSV values replace existing rows")
    p = sub.add_parser("run", help="scheduled job")
    p.add_argument("job", choices=["daily", "weekly", "monthly"])
    sub.add_parser("baseline", help="snapshot our listing")
    sub.add_parser("competitors", help="snapshot competitor listings")
    sub.add_parser("keywords", help="expand keywords from autocomplete")
    sub.add_parser("verify-backlinks", help="check every recorded backlink")
    sub.add_parser("scan-mentions", help="check listicle/resource prospects for mentions of us")
    p = sub.add_parser("add-backlink", help="record a backlink to verify")
    p.add_argument("source_url")
    p.add_argument("--notes", default="")
    p = sub.add_parser("set", help="update a prospect by id")
    p.add_argument("id", type=int)
    p.add_argument("--status")
    p.add_argument("--next-action")
    p.add_argument("--next-date")
    p.add_argument("--response")
    p.add_argument("--contacted", action="store_true", help="set last_contact to today")
    p = sub.add_parser("list", help="show prospects")
    p.add_argument("--status")
    p.add_argument("--limit", type=int, default=25)
    sub.add_parser("due", help="follow-ups due today")
    sub.add_parser("export", help="write records/*.csv")
    sub.add_parser("backup", help="snapshot the DB")
    args = ap.parse_args(argv)

    setup_logging()
    with Lock():
        db = connect()
        if args.cmd == "init":
            loaded = {}
            for table in TABLE_KEYS:
                for base in (RECORDS, SEEDS):
                    path = os.path.join(base, f"{table}.csv")
                    if os.path.exists(path):
                        loaded[f"{os.path.basename(base)}/{table}"] = import_csv(db, path, table)
            print(json.dumps(loaded, indent=1))
        elif args.cmd == "import":
            print(import_csv(db, args.path, args.table, overwrite=args.overwrite), "rows written")
        elif args.cmd == "run":
            report, failures = run_job(db, args.job)
            print(report)
            return 1 if failures else 0
        elif args.cmd == "baseline":
            print(json.dumps(job_baseline(db), indent=1))
        elif args.cmd == "competitors":
            print(json.dumps(job_competitors(db), indent=1))
        elif args.cmd == "keywords":
            print("\n".join(job_keywords(db)))
        elif args.cmd == "verify-backlinks":
            for c in job_verify_backlinks(db):
                print(*c)
        elif args.cmd == "scan-mentions":
            for c in job_scan_mentions(db):
                print(*c)
        elif args.cmd == "add-backlink":
            db.execute("INSERT OR IGNORE INTO backlinks(source_url, discovered, status, quality_notes) VALUES (?,?,?,?)",
                       (args.source_url, today(), "pending", args.notes))
            db.commit()
            for c in job_verify_backlinks(db):
                print(*c)
            r = db.execute("SELECT * FROM backlinks WHERE source_url=?", (args.source_url,)).fetchone()
            print(dict(r))
        elif args.cmd == "set":
            fields = {"status": args.status, "next_action": args.next_action, "next_action_date": args.next_date,
                      "response": args.response, "last_contact": today() if args.contacted else None}
            fields = {k: v for k, v in fields.items() if v is not None}
            fields["updated"] = now()
            db.execute(f"UPDATE prospects SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", [*fields.values(), args.id])
            db.commit()
            print(dict(db.execute("SELECT * FROM prospects WHERE id=?", (args.id,)).fetchone()))
        elif args.cmd == "list":
            q, params = "SELECT * FROM prospects", []
            if args.status:
                q, params = q + " WHERE status=?", [args.status]
            rows = db.execute(q + " ORDER BY priority DESC, relevance DESC LIMIT ?", [*params, args.limit]).fetchall()
            print(fmt_rows(rows, ["id", "priority", "domain", "opportunity_type", "status", "next_action"]))
        elif args.cmd == "due":
            print(fmt_rows(due_followups(db), ["id", "priority", "domain", "next_action", "next_action_date"]))
        elif args.cmd == "export":
            export_csv(db)
        elif args.cmd == "backup":
            print(backup(db))
    return 0


if __name__ == "__main__":
    sys.exit(main())
