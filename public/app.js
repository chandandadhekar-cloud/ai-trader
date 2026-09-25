// TradeAI admin console: hash-routed single-page app over the admin API.
import { api, post, put, html, raw, esc, fmt, $, $$, toast, badge, statusBadge, verdictBadge, table, bindRows, drawer, closeDrawer, lineChart, barChart, ApiError } from './lib.js';

const state = { overview: null, user: null, es: null, feed: [], page: null };

const ICON = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
};

const NAV = [
  ['dashboard', 'Dashboard'], ['trading', 'Positions & orders'], ['scanner', 'Scanner'], ['research', 'Research'],
  ['strategies', 'Strategies'], ['risk', 'Risk & config'], ['validation', 'Validation'], ['sep'],
  ['surveillance', 'Surveillance'], ['compliance', 'Compliance'], ['tax', 'Tax & P&L'], ['audit', 'Audit & logs'], ['settings', 'Settings'],
];

// ---------------------------------------------------------------------------
// boot / auth

async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    renderShell();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) renderLogin();
    else document.getElementById('root').innerHTML = `<div class="login-wrap"><div class="card">Cannot reach the TradeAI server: ${esc(e.message)}</div></div>`;
  }
}

function renderLogin() {
  const root = document.getElementById('root');
  root.innerHTML = html`<div class="login-wrap"><div class="card login">
    <div class="brand">${raw(ICON.logo)} TradeAI</div>
    <h1>Sign in</h1><div class="muted">Admin console</div>
    <form id="login-form">
      <label class="field">User<input name="user" autocomplete="username" required value="admin"></label>
      <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="error" id="login-err" role="alert"></div>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <p class="muted" style="font-size:12px">First run: the initial password is written to <code>data/INITIAL_ADMIN_PASSWORD.txt</code>.</p>
  </div></div>`.__raw;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/auth/login', { method: 'POST', body: { user: f.get('user'), password: f.get('password') } });
      state.user = f.get('user');
      renderShell();
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
}

function renderShell() {
  const root = document.getElementById('root');
  root.innerHTML = html`<div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand">${raw(ICON.logo)} TradeAI</div>
      <nav class="nav" aria-label="Main">${NAV.map(([id, label]) => (id === 'sep' ? raw('<div class="sep"></div>') : html`<a href="#/${id}" data-nav="${id}">${label}</a>`))}</nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="menu-btn ghost" id="menu-btn" aria-label="Menu">☰</button>
        <span id="top-mode"></span><span id="top-session"></span><span id="top-kill"></span>
        <span class="spacer"></span>
        <span class="mono muted hide-sm" id="top-clock"></span>
        <button class="ghost sm" id="theme-btn" aria-label="Toggle theme">◐</button>
        <span class="secondary hide-sm">${state.user}</span>
        <button class="sm" id="logout-btn">Sign out</button>
      </header>
      <main class="content" id="page"></main>
    </div>
  </div>`.__raw;
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#logout-btn').addEventListener('click', async () => { await post('/api/auth/logout'); state.es?.close(); renderLogin(); });
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ta-theme', next); } catch { /* ignore */ }
    route();
  });
  startStream();
  window.addEventListener('hashchange', route);
  route();
}

function startStream() {
  state.es?.close();
  const es = new EventSource('/api/stream');
  state.es = es;
  es.addEventListener('overview', (e) => {
    state.overview = JSON.parse(e.data);
    renderTopbar();
    if (state.page === 'dashboard') updateDashboard();
  });
  for (const topic of ['anomaly', 'research.verdict', 'signal', 'order.update', 'fill', 'alert', 'killswitch', 'risk.event', 'system']) {
    es.addEventListener(topic, (e) => {
      const data = JSON.parse(e.data);
      state.feed.unshift({ topic, data, ts: Date.now() });
      if (state.feed.length > 200) state.feed.pop();
      if (state.page === 'dashboard') renderFeed();
      if (topic === 'alert' && (data.severity === 'P0' || data.severity === 'P1')) toast(`${data.severity}: ${data.title}`, true);
    });
  }
  es.onerror = () => { /* EventSource reconnects automatically */ };
}

function renderTopbar() {
  const o = state.overview;
  if (!o) return;
  $('#top-mode').innerHTML = html`${badge(o.mode === 'live' ? 'LIVE' : 'PAPER', o.mode === 'live' ? 'crit' : 'info')} ${o.dataSource === 'synthetic' ? badge('SYNTHETIC DATA', 'warn') : badge('Upstox data', 'good')}`.__raw;
  const ph = o.session.equity;
  $('#top-session').innerHTML = o.dataSource === 'synthetic'
    ? html`${badge('SIMULATED SESSION', 'good')}`.__raw
    : html`${badge(ph.isTradingDay ? `NSE ${ph.phase.replaceAll('_', ' ')}` : `NSE closed · ${ph.holiday || ''}`, ph.phase === 'CONTINUOUS' ? 'good' : '')}`.__raw;
  $('#top-kill').innerHTML = o.killSwitch.engaged ? html`<span class="badge crit"><span class="dot crit"></span>KILL SWITCH ON</span>`.__raw : '';
  $('#top-clock').textContent = `${o.ist} IST`;
}

function route() {
  closeDrawer();
  $('#sidebar')?.classList.remove('open');
  const page = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
  state.page = page;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  const el = $('#page');
  const fn = PAGES[page] || PAGES.dashboard;
  el.innerHTML = '<div class="empty">Loading…</div>';
  Promise.resolve(fn(el)).catch((e) => {
    if (e instanceof ApiError && e.status === 401) return renderLogin();
    el.innerHTML = html`<div class="banner crit">Failed to load: ${e.message}</div>`.__raw;
  });
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// dashboard

function kpi(label, value, sub, cls = '') {
  return html`<div class="card kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub ?? ''}</div></div>`;
}

async function pageDashboard(el) {
  el.innerHTML = html`
    <div class="page-head"><h1>Dashboard</h1><span class="spacer"></span>
      <button class="danger" id="kill-btn">Engage kill switch</button></div>
    <div id="dash-banners"></div>
    <div class="kpis" id="dash-kpis"></div>
    <div class="grid g21">
      <div class="card"><h2>Equity (paper book)</h2><div id="eq-chart"></div></div>
      <div class="card"><h2>System health</h2><ul class="health-list" id="health"></ul></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Live activity</h2><div class="toolbar seg" id="feed-filter" role="group" aria-label="Feed filter">
        <button class="on" data-f="all">All</button><button data-f="anomaly">Anomalies</button><button data-f="research.verdict">Verdicts</button><button data-f="signal">Signals</button><button data-f="order">Orders</button><button data-f="alert">Alerts</button></div>
        <div class="feed" id="feed"></div></div>
      <div class="card"><h2>Open positions</h2><div id="dash-pos"></div></div>
    </div>`.__raw;
  $('#kill-btn').addEventListener('click', () => killDialog());
  $$('#feed-filter button').forEach((b) => b.addEventListener('click', () => {
    $$('#feed-filter button').forEach((x) => x.classList.toggle('on', x === b));
    state.feedFilter = b.dataset.f;
    renderFeed();
  }));
  if (!state.feed.length) {
    const [an, vd, sg] = await Promise.all([api('/api/events?topic=anomaly&limit=30'), api('/api/events?topic=research.verdict&limit=20'), api('/api/events?topic=signal&limit=20')]);
    state.feed = [...an, ...vd, ...sg].map((e) => ({ topic: e.topic, data: e.data, ts: e.ts })).sort((a, b) => b.ts - a.ts);
  }
  renderFeed();
  updateDashboard();
  const eq = await api('/api/equity?since=' + (Date.now() - 3 * 86400_000));
  lineChart($('#eq-chart'), eq.map((r) => ({ x: r.ts, y: r.equity })), { yFmt: (v) => fmt.inr(v), label: 'Paper equity', xTick: (x) => fmt.time(x), tipFmt: (v) => fmt.inr2(v) });
  const pos = await api('/api/positions');
  $('#dash-pos').innerHTML = table([
    { label: 'Symbol', render: (p) => html`<b>${p.symbol}</b> <span class="muted">${p.book}</span>` },
    { label: 'Strategy', key: 'strategyId' },
    { label: 'Qty', key: 'qty', num: true },
    { label: 'Avg', render: (p) => fmt.num(p.avgPrice), num: true },
    { label: 'LTP', render: (p) => fmt.num(p.ltp), num: true },
    { label: 'P&L', render: (p) => html`<span class="${fmt.cls(p.unrealized)}">${fmt.inr(p.unrealized)}</span>`, num: true },
    { label: 'Stop', render: (p) => html`${fmt.num(p.stopPrice)} ${p.protectiveConfirmed ? badge('at broker', 'good') : badge('unconfirmed', 'warn')}` },
  ], pos, { empty: 'No open positions.' }).__raw;
}

function updateDashboard() {
  const o = state.overview;
  if (!o || !$('#dash-kpis')) return;
  const b = o.books.live ?? o.books.paper;
  const book = o.books.live ? 'live' : 'paper';
  $('#dash-kpis').innerHTML = html`
    ${kpi(`Equity (${book})`, fmt.inr(b.equity), `start ${fmt.inr(b.startingCapital)}`)}
    ${kpi('Day P&L', fmt.signPct(b.dayPnlPct), `realised ${fmt.inr(b.realized)} · fees ${fmt.inr(b.fees)}`, fmt.cls(b.dayPnlPct))}
    ${kpi('Drawdown', fmt.pct(b.drawdown), 'halt at risk config limit', b.drawdown > 0.05 ? 'neg' : '')}
    ${kpi('Open positions', fmt.int(b.openPositions), `open risk ${fmt.inr(b.openRisk)}`)}
    ${kpi('Anomalies', fmt.int(o.scanner.anomalies), `${fmt.int(o.scanner.suppressed)} index-suppressed`)}
    ${kpi('Research verdicts', fmt.int(o.research.completed), `LLM ${o.research.llmAvailable ? 'on' : 'off (deterministic)'} · $${fmt.num(o.research.usage.costUsd, 2)} today`)}
    ${kpi('Signals', fmt.int(o.loop.signals), `${o.loop.accepted} accepted · ${o.loop.rejected} rejected · ${o.loop.shadow} shadow`)}`.__raw;
  const banners = [];
  if (o.killSwitch.engaged) banners.push(html`<div class="banner crit"><div class="row"><span><b>Kill switch engaged</b> — ${o.killSwitch.reason} (by ${o.killSwitch.by}, ${fmt.ago(o.killSwitch.at)}). New entries are blocked.</span><button class="sm" id="disengage-btn">Disengage…</button></div></div>`);
  if (o.dataSource === 'synthetic') banners.push(html`<div class="banner warn">Synthetic market data (demo). Prices, filings and anomalies are simulated; configure Upstox credentials and <code>DATA_SOURCE=upstox</code> for real data.</div>`);
  if (!o.surveillance.fresh) banners.push(html`<div class="banner warn">Today's NSE surveillance files are not loaded — equity entries are blocked. <a href="#/surveillance">Load them</a>.</div>`);
  if (o.mode === 'live' && !o.compliance.liveReady) banners.push(html`<div class="banner crit">Live mode, but compliance blockers exist: ${o.compliance.blockers.join('; ')}.</div>`);
  $('#dash-banners').innerHTML = banners.map((x) => x.__raw).join('');
  $('#disengage-btn')?.addEventListener('click', () => killDialog(true));
  const h = [];
  const item = (name, ok, detail, warn = false) => h.push(html`<li><span class="dot ${ok ? 'good' : warn ? 'warn' : 'crit'}"></span><span class="name">${name}<div class="muted" style="font-size:12px">${detail}</div></span>${ok ? badge('OK', 'good') : badge(warn ? 'Check' : 'Issue', warn ? 'warn' : 'crit')}</li>`);
  if (o.feed) for (const c of o.feed.connections) item(`Feed ${c.name}`, c.connected, `${c.keys}/${c.cap} keys · ${c.reconnects} reconnects`);
  else item('Market data', o.ticks > 0, `${fmt.int(o.ticks)} ticks · ${o.dataSource}`);
  item('Surveillance files', o.surveillance.fresh, o.dataSource === 'synthetic' ? 'not required in synthetic mode' : o.surveillance.date ? `loaded ${o.surveillance.date}` : 'not loaded — equity entries blocked', true);
  item('Reconciliation', o.reconcile.paper.ok && (!o.reconcile.live || o.reconcile.live.ok), o.reconcile.paper.last ? `last ${fmt.ago(o.reconcile.paper.last.at)}` : 'never');
  item('Compliance (live)', o.compliance.liveReady, o.compliance.liveReady ? 'all checks pass' : `${o.compliance.blockers.length} blocker(s)`, o.mode !== 'live');
  item('Decision loop', o.loop.lastRunAt && Date.now() - o.loop.lastRunAt < 180_000, o.loop.lastRunAt ? `ran ${fmt.ago(o.loop.lastRunAt)} in ${o.loop.lastRunMs} ms` : 'not yet run', true);
  item('Research', o.research.queue < 20, `${o.research.queue} queued · ${o.research.usage.calls} LLM calls today`, true);
  item('Order throttle', o.throttle.peakOps < o.throttle.alertAt, `peak ${o.throttle.peakOps} OPS (cap ${o.throttle.hardLimit}, exchange 10)`, true);
  item('Clock', o.clock.skewMs === undefined || Math.abs(o.clock.skewMs) < 50 || o.dataSource === 'synthetic', o.clock.skewMs !== undefined ? `skew ${o.clock.skewMs} ms` : 'no exchange timestamps yet', true);
  $('#health').innerHTML = h.map((x) => x.__raw).join('');
}

function feedLine(f) {
  const d = f.data;
  switch (f.topic) {
    case 'anomaly': return html`${badge(d.type, d.suppressed ? '' : 'info')} <b>${d.symbol}</b> sev ${fmt.num(d.severity, 0)} ${d.z !== undefined ? `z ${fmt.num(d.z, 1)}` : ''} ${d.suppressed ? raw('<span class="muted">(index-driven)</span>') : ''}`;
    case 'research.verdict': return html`${verdictBadge(d.final)} <b>${d.symbol}</b> ${d.causeCategory} · ${d.direction} · conf ${fmt.num(d.calibratedConfidence, 2)} <span class="muted">${d.path}</span>`;
    case 'signal': return html`${badge(d.decision, d.decision === 'accepted' ? 'good' : d.decision === 'shadow' ? '' : 'warn')} ${d.strategyId} ${d.side} <span class="mono">${d.instrumentKey.split('|').pop()}</span> <span class="muted">${(d.rejectReasons || []).slice(0, 1).join('')}</span>`;
    case 'order.update': return html`Order ${badge(d.status, d.status === 'FILLED' ? 'good' : d.status === 'REJECTED' ? 'crit' : '')} <span class="mono">${d.instrumentKey.split('|').pop()}</span> ${d.strategyId} <span class="muted">${d.reason || ''}</span>`;
    case 'fill': return html`Fill ${d.side} ${d.qty} <span class="mono">${d.instrumentKey.split('|').pop()}</span> @ ${fmt.num(d.price)} <span class="muted">fees ${fmt.inr2(d.fees)}</span>`;
    case 'alert': return html`${badge(d.severity, d.severity === 'P0' ? 'crit' : d.severity === 'P1' ? 'warn' : '')} <b>${d.title}</b> ${d.message}`;
    case 'killswitch': return html`${badge('KILL', 'crit')} ${d.engaged ? 'engaged' : 'disengaged'} — ${d.reason}`;
    default: return html`${badge(f.topic)} ${d.message || d.kind || ''}`;
  }
}

function renderFeed() {
  const el = $('#feed');
  if (!el) return;
  const flt = state.feedFilter || 'all';
  const items = state.feed.filter((f) => flt === 'all' || f.topic === flt || (flt === 'order' && (f.topic === 'order.update' || f.topic === 'fill'))).slice(0, 80);
  el.innerHTML = items.length ? items.map((f) => html`<div class="feed-item"><span class="t">${fmt.time(f.data.ts || f.ts)}</span><span class="body">${feedLine(f)}</span></div>`.__raw).join('') : '<div class="empty">Waiting for events…</div>';
}

function killDialog(disengage = false) {
  const d = drawer(html`<h2>${disengage ? 'Disengage kill switch' : 'Engage kill switch'}</h2>
    <p class="secondary">${disengage ? 'New entries resume after you disengage. Write down why it is safe.' : 'Blocks all new entries immediately. Broker-side stops stay in place.'}</p>
    <form id="kill-form" class="stack">
      <label class="field">${disengage ? 'Note (required)' : 'Reason'}<input name="reason" required minlength="${disengage ? 5 : 1}"></label>
      ${disengage ? '' : raw('<label><input type="checkbox" name="flatten"> Also flatten all positions now</label>')}
      <button class="${disengage ? 'primary' : 'danger'}" type="submit">${disengage ? 'Disengage' : 'Engage'}</button>
    </form>`);
  $('#kill-form', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await act(() => post('/api/killswitch', { engage: !disengage, reason: f.get('reason'), flatten: f.get('flatten') === 'on' }), disengage ? 'Kill switch disengaged' : 'Kill switch engaged');
    closeDrawer();
  });
}

// ---------------------------------------------------------------------------
// positions & orders

async function pageTrading(el) {
  const liveAvail = !!state.overview?.books.live;
  const bookSel = new URLSearchParams(location.hash.split('?')[1] || '').get('book') || 'paper';
  const [pos, orders, fills, trades] = await Promise.all([api('/api/positions'), api(`/api/orders?book=${bookSel}`), api(`/api/fills?book=${bookSel}&limit=100`), api(`/api/trades?book=${bookSel}`)]);
  el.innerHTML = html`<div class="page-head"><h1>Positions & orders</h1><span class="spacer"></span>
      ${liveAvail ? raw(`<div class="seg"><a class="btn ${bookSel === 'paper' ? 'on' : ''}" href="#/trading?book=paper">Paper</a><a class="btn ${bookSel === 'live' ? 'on' : ''}" href="#/trading?book=live">Live</a></div>`) : ''}
      <button class="danger" id="flatten-btn">Flatten ${bookSel}</button></div>
    <div class="card"><h2>Open positions</h2><div id="pos"></div></div>
    <div class="card" style="margin-top:14px"><h2>Orders</h2><div id="orders"></div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Fills</h2><div id="fills"></div></div>
      <div class="card"><h2>Closed trades</h2><div id="trades"></div></div>
    </div>`.__raw;
  $('#pos').innerHTML = table([
    { label: 'Book', key: 'book' }, { label: 'Symbol', render: (p) => html`<b>${p.symbol}</b>` }, { label: 'Strategy', key: 'strategyId' },
    { label: 'Qty', key: 'qty', num: true }, { label: 'Avg', render: (p) => fmt.num(p.avgPrice), num: true }, { label: 'LTP', render: (p) => fmt.num(p.ltp), num: true },
    { label: 'Unrealised', render: (p) => html`<span class="${fmt.cls(p.unrealized)}">${fmt.inr(p.unrealized)}</span>`, num: true },
    { label: 'Stop', render: (p) => html`${fmt.num(p.stopPrice)} ${p.protectiveConfirmed ? badge('broker ack', 'good') : badge('unconfirmed', 'warn')}` },
    { label: 'Target', render: (p) => fmt.num(p.targetPrice), num: true }, { label: 'Time stop', render: (p) => fmt.time(p.timeStopAt) },
    { label: '', render: (p) => raw(`<button class="sm" data-exit="${esc(p.instrumentKey)}" data-strat="${esc(p.strategyId)}" data-book="${esc(p.book)}">Exit</button>`) },
  ], pos, { empty: 'No open positions.' }).__raw;
  $$('[data-exit]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Exit ${b.dataset.exit} (${b.dataset.strat})?`)) return;
    await act(() => post('/api/positions/exit', { instrumentKey: b.dataset.exit, strategyId: b.dataset.strat, book: b.dataset.book }), 'Exit order sent');
    route();
  }));
  const open = new Set(['PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL']);
  $('#orders').innerHTML = table([
    { label: 'Time', render: (o) => fmt.dt(o.created_at) }, { label: 'Id', render: (o) => html`<span class="mono">${o.client_order_id}</span>` },
    { label: 'Purpose', key: 'purpose' }, { label: 'Instrument', render: (o) => o.instrument_key.split('|').pop() }, { label: 'Side', key: 'side' },
    { label: 'Type', key: 'order_type' }, { label: 'Qty', render: (o) => `${o.filled_qty}/${o.qty}`, num: true },
    { label: 'Price', render: (o) => fmt.num(o.price), num: true }, { label: 'Trigger', render: (o) => fmt.num(o.trigger_price), num: true },
    { label: 'Avg fill', render: (o) => fmt.num(o.avg_fill_price), num: true },
    { label: 'Status', render: (o) => badge(o.status, o.status === 'FILLED' ? 'good' : o.status === 'REJECTED' ? 'crit' : open.has(o.status) ? 'info' : '') },
    { label: 'Reason', render: (o) => o.reason, wrap: true }, { label: 'Algo', key: 'algo_name' },
    { label: '', render: (o) => (open.has(o.status) ? raw(`<button class="sm" data-cancel="${esc(o.client_order_id)}">Cancel</button>`) : '') },
  ], orders, { empty: 'No orders yet.' }).__raw;
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => { await act(() => post(`/api/orders/${b.dataset.cancel}/cancel?book=${bookSel}`), 'Cancel sent'); route(); }));
  $('#fills').innerHTML = table([
    { label: 'Time', render: (f) => fmt.dt(f.ts) }, { label: 'Instrument', render: (f) => f.instrument_key.split('|').pop() }, { label: 'Side', key: 'side' },
    { label: 'Qty', key: 'qty', num: true }, { label: 'Price', render: (f) => fmt.num(f.price), num: true }, { label: 'Charges', render: (f) => fmt.inr2(f.fees), num: true },
  ], fills, { empty: 'No fills yet.' }).__raw;
  $('#trades').innerHTML = table([
    { label: 'Time', render: (t) => fmt.dt(t.ts) }, { label: 'Instrument', render: (t) => t.instrumentKey.split('|').pop() }, { label: 'Strategy', key: 'strategyId' },
    { label: 'Net P&L', render: (t) => html`<span class="${fmt.cls(t.netPnl)}">${fmt.inr(t.netPnl)}</span>`, num: true }, { label: 'R', render: (t) => fmt.num(t.rMultiple), num: true },
  ], trades, { empty: 'No closed trades yet.' }).__raw;
  $('#flatten-btn').addEventListener('click', async () => {
    if (!confirm(`Flatten ALL ${bookSel} positions with marketable limit orders?`)) return;
    await act(() => post('/api/flatten', { book: bookSel, reason: 'manual' }), 'Flatten orders sent');
    route();
  });
}

// ---------------------------------------------------------------------------
// scanner

async function pageScanner(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const params = new URLSearchParams({ limit: '300' });
  for (const k of ['type', 'minSeverity', 'symbol', 'hideSuppressed']) if (q.get(k)) params.set(k, q.get(k));
  const [rows, stats] = await Promise.all([api(`/api/anomalies?${params}`), api('/api/anomalies/stats')]);
  const types = ['RETURN_SHOCK', 'RVOL', 'RESIDUAL', 'GAP', 'BAND_PROXIMITY', 'BAND_HIT', 'OI_SPIKE', 'IV_JUMP', 'UOA', 'CHANGEPOINT', 'INDEX_SHOCK', 'FUNDING_JUMP'];
  el.innerHTML = html`<div class="page-head"><h1>Market-wide anomaly scanner</h1></div>
    <div class="grid g2">
      <div class="card"><h2>Anomalies by type</h2><div id="type-chart"></div></div>
      <div class="card"><h2>Forward returns by type (research asset)</h2><div id="fwd"></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Anomaly log</h2>
      <form class="toolbar" id="flt">
        <select name="type" aria-label="Type"><option value="">All types</option>${types.map((t) => html`<option ${raw(q.get('type') === t ? 'selected' : '')}>${t}</option>`)}</select>
        <input name="minSeverity" type="number" min="0" max="100" placeholder="Min severity" value="${q.get('minSeverity') || ''}" aria-label="Minimum severity" style="width:130px">
        <input name="symbol" placeholder="Symbol" value="${q.get('symbol') || ''}" aria-label="Symbol" style="width:120px">
        <label><input type="checkbox" name="hideSuppressed" value="1" ${raw(q.get('hideSuppressed') ? 'checked' : '')}> Hide index-driven</label>
        <button class="primary" type="submit">Apply</button>
      </form><div id="anoms"></div></div>`.__raw;
  barChart($('#type-chart'), stats.map((s) => ({ label: s.type, value: s.n, tip: `${s.n} anomalies · avg severity ${fmt.num(s.avgSeverity, 0)}` })), { label: 'Anomaly count by type' });
  $('#fwd').innerHTML = table([
    { label: 'Type', key: 'type' }, { label: 'Count', key: 'n', num: true }, { label: 'Labelled', key: 'labelled', num: true },
    { label: 'Avg fwd 5m', render: (s) => html`<span class="${fmt.cls(s.avgFwd5m)}">${fmt.signPct(s.avgFwd5m, 3)}</span>`, num: true },
    { label: 'Avg fwd 30m', render: (s) => html`<span class="${fmt.cls(s.avgFwd30m)}">${fmt.signPct(s.avgFwd30m, 3)}</span>`, num: true },
    { label: 'Suppressed', key: 'suppressed', num: true },
  ], stats).__raw;
  $('#flt').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new URLSearchParams(new FormData(e.target));
    for (const [k, v] of [...f]) if (!v) f.delete(k);
    location.hash = `#/scanner?${f}`;
  });
  $('#anoms').innerHTML = table([
    { label: 'Time', render: (a) => fmt.dt(a.ts) }, { label: 'Symbol', render: (a) => html`<b>${a.symbol}</b>` },
    { label: 'Type', render: (a) => badge(a.type, a.suppressed ? '' : 'info') }, { label: 'Tier', key: 'tier' },
    { label: 'Severity', render: (a) => fmt.num(a.severity, 0), num: true }, { label: 'z', render: (a) => fmt.num(a.details.z, 1), num: true },
    { label: 'RVOL', render: (a) => fmt.num(a.details.rvol, 1), num: true }, { label: 'Resid z', render: (a) => fmt.num(a.details.residualZ, 1), num: true },
    { label: 'Move', render: (a) => html`<span class="${fmt.cls(a.details.ret)}">${fmt.signPct(a.details.ret)}</span>`, num: true },
    { label: 'Index expl.', render: (a) => (a.details.explainedByIndex > 1 ? '>100%' : a.details.explainedByIndex < 0 ? 'opposite' : fmt.pct(a.details.explainedByIndex, 0)), num: true },
    { label: 'Fwd 30m', render: (a) => html`<span class="${fmt.cls(a.fwd_ret_30m)}">${fmt.signPct(a.fwd_ret_30m)}</span>`, num: true },
    { label: 'Status', render: (a) => (a.suppressed ? badge('index-driven') : a.researched ? badge('researched', 'good') : badge('logged')) },
  ], rows, { onRow: true, empty: 'No anomalies match.' }).__raw;
  bindRows($('#anoms'), rows, (a) => {
    const d = drawer(html`<h2>${a.symbol} · ${a.type}</h2>
      <dl class="kv"><dt>Time</dt><dd>${fmt.dt(a.ts)}</dd><dt>Severity</dt><dd>${fmt.num(a.severity, 1)}</dd><dt>Tier</dt><dd>${a.tier}</dd><dt>Price</dt><dd>${fmt.num(a.price)}</dd>
      <dt>Suppressed</dt><dd>${a.suppressed ? 'yes (index explains the move)' : 'no'}</dd></dl>
      <h3 style="margin-top:16px">Detector details</h3><pre class="json">${JSON.stringify(a.details, null, 2)}</pre>
      <div class="toolbar"><button class="primary" id="res-fast">Research (fast)</button><button id="res-deep">Research (deep)</button></div>`);
    $('#res-fast', d).addEventListener('click', () => act(() => post('/api/research', { key: a.key, deep: false }), 'Queued for research'));
    $('#res-deep', d).addEventListener('click', () => act(() => post('/api/research', { key: a.key, deep: true }), 'Queued for deep research'));
  });
}

// ---------------------------------------------------------------------------
// research

async function pageResearch(el) {
  const [rows, cal] = await Promise.all([api('/api/verdicts?limit=200'), api('/api/research/calibration')]);
  const o = state.overview;
  el.innerHTML = html`<div class="page-head"><h1>“Why is it moving” research</h1></div>
    <div class="kpis">
      ${kpi('LLM', o?.research.llmAvailable ? 'Configured' : 'Not configured', o?.research.llmAvailable ? `fast ${o.research.fastModel} · deep ${o.research.deepModel}` : 'deterministic fallback in use')}
      ${kpi('Calls today', fmt.int(o?.research.usage.calls), `cost $${fmt.num(o?.research.usage.costUsd, 2)} · ${o?.research.usage.errors ?? 0} errors`)}
      ${kpi('Completed', fmt.int(o?.research.completed), `${o?.research.cached ?? 0} cached · ${o?.research.failed ?? 0} failed`)}
      ${kpi('Labelled outcomes', fmt.int(cal.labelled), cal.model ? `calibrated on ${cal.model.n}, Brier ${fmt.num(cal.model.brierAfter, 3)}` : 'shrink-to-0.5 until 50 outcomes')}
    </div>
    <div class="grid g2">
      <div class="card"><h2>Research a symbol</h2>
        <form class="toolbar" id="rs-form"><input name="symbol" placeholder="Symbol e.g. RELIANCE" required aria-label="Symbol">
        <label><input type="checkbox" name="deep"> Deep path (multi-agent, self-consistency)</label><button class="primary">Queue</button></form>
        <p class="muted" style="font-size:12.5px">The LLM proposes a label; code verifies citations, timestamps and source priority, then maps it to REACT / FADE / PROTECT / IGNORE / BLOCK. It never sizes or places trades.</p></div>
      <div class="card"><h2>Calibration: hit rate by stated confidence</h2><div id="cal-chart"></div>
        <div class="toolbar" style="margin-top:8px"><button class="sm" id="refit">Refit isotonic calibration</button></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Verdicts</h2><div id="vd"></div></div>`.__raw;
  $('#rs-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await act(() => post('/api/research', { symbol: f.get('symbol'), deep: f.get('deep') === 'on' }), 'Queued');
  });
  $('#refit').addEventListener('click', async () => { const r = await act(() => post('/api/research/calibration/refit')); toast(r.ok ? `Refit on ${r.model.n} outcomes` : 'Not enough labelled outcomes yet (need 10+)'); });
  barChart($('#cal-chart'), cal.bins.map((b) => ({ label: `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`, value: b.n ? b.hits / b.n : 0, tip: b.n ? `${b.hits}/${b.n} correct (${fmt.pct(b.hits / b.n, 0)})` : 'no outcomes' })), { yFmt: (v) => fmt.pct(v, 0), label: 'Hit rate by confidence bucket' });
  $('#vd').innerHTML = table([
    { label: 'Time', render: (v) => fmt.dt(v.ts) }, { label: 'Symbol', render: (v) => html`<b>${v.symbol}</b>` },
    { label: 'Final', render: (v) => verdictBadge(v.final) }, { label: 'Proposed', render: (v) => html`<span class="muted">${v.proposed}</span>` },
    { label: 'Dir', key: 'direction' }, { label: 'Conf (cal.)', render: (v) => `${fmt.num(v.confidence, 2)} (${fmt.num(v.calibrated_confidence, 2)})`, num: true },
    { label: 'Path', key: 'path' }, { label: 'Latency', render: (v) => `${fmt.num(v.latency_ms / 1000, 1)}s`, num: true },
    { label: 'Cost', render: (v) => (v.cost_usd ? `$${fmt.num(v.cost_usd, 4)}` : '—'), num: true },
    { label: 'Outcome', render: (v) => (v.outcome_correct === null || v.outcome_correct === undefined ? '—' : v.outcome_correct ? badge('correct', 'good') : badge('wrong', 'crit')) },
  ], rows, { onRow: true, empty: 'No verdicts yet. High-severity anomalies are researched automatically.' }).__raw;
  bindRows($('#vd'), rows, async (v) => {
    const b = await api(`/api/verdicts/${v.id}`);
    const src = b.factPack?.sources || [];
    drawer(html`<h2>${b.symbol} ${verdictBadge(b.final)}</h2>
      <p>${b.causeSummary}</p>
      <dl class="kv"><dt>Category</dt><dd>${b.causeCategory}</dd><dt>Direction</dt><dd>${b.direction}</dd><dt>New information</dt><dd>${b.isNewInformation ? 'yes' : 'no'}</dd>
        <dt>Confidence</dt><dd>${fmt.num(b.confidence, 2)} raw · ${fmt.num(b.calibratedConfidence, 2)} calibrated</dd><dt>Persistence</dt><dd>${b.expectedPersistence}</dd>
        <dt>Path / model</dt><dd>${b.path} ${b.model || ''} · prompt ${b.promptVersion}</dd><dt>Latency</dt><dd>${fmt.num(b.latencyMs / 1000, 1)} s (fact pack ${b.factPack?.buildMs} ms)</dd>
        <dt>Expires</dt><dd>${fmt.dt(b.expiresAt)}</dd><dt>Priced in</dt><dd>${b.factPack?.pricedIn?.fractionOfTypical !== undefined ? fmt.pct(b.factPack.pricedIn.fractionOfTypical, 0) + ' of typical impact' : 'no history'}${b.factPack?.pricedIn?.minutesSinceFirstPublication !== undefined ? ` · first published ${b.factPack.pricedIn.minutesSinceFirstPublication} min ago` : ''}</dd></dl>
      <h3 style="margin-top:16px">Why code decided ${b.final}</h3><ul>${(b.reasons || []).map((r) => html`<li>${r}</li>`)}</ul>
      <h3>Verified claims</h3>${(b.claims || []).length ? html`<ul>${b.claims.map((c) => html`<li>${c.text} <span class="mono muted">[${c.sourceIds.join(', ')}]</span></li>`)}</ul>` : html`<p class="muted">No claim survived citation checks.</p>`}
      <h3>Fact-pack sources</h3>${table([
        { label: 'Id', render: (s) => html`<span class="mono">${s.id}</span>` }, { label: 'Kind', key: 'kind' }, { label: 'Published', render: (s) => fmt.dt(s.publishedTs) },
        { label: 'vs move', render: (s) => `${s.minutesRelativeToMove > 0 ? '+' : ''}${s.minutesRelativeToMove} min` }, { label: 'Title', key: 'title', wrap: true },
      ], src, { empty: 'No sources found for this symbol.' })}
      ${b.unknowns?.length ? html`<h3>Unknowns</h3><ul>${b.unknowns.map((u) => html`<li>${u}</li>`)}</ul>` : ''}
      <details><summary>Raw trace</summary><pre class="json">${JSON.stringify(b.trace || {}, null, 2)}</pre></details>`);
  });
}

// ---------------------------------------------------------------------------
// strategies

async function pageStrategies(el) {
  const [rows, drift] = await Promise.all([api('/api/strategies'), api('/api/drift')]);
  el.innerHTML = html`<div class="page-head"><h1>Strategies</h1></div>
    <div class="banner info">Stages: <b>disabled</b> → <b>shadow</b> (signals scored, never sent) → <b>paper</b> → <b>live</b>. Promotion to live requires the latest validation trial to pass every gate (or a written override, which is audited).</div>
    <div id="strats" class="stack"></div>`.__raw;
  $('#strats').innerHTML = rows.map((s) => {
    const d = drift.find((x) => x.strategyId === s.id);
    return html`<div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">${s.name}</h2>${badge(s.stage.toUpperCase(), s.stage === 'live' ? 'crit' : s.stage === 'paper' ? 'info' : '')} ${s.paused ? badge('paused: loss streak', 'warn') : ''}<span class="spacer"></span>
      <select data-stage="${s.id}" aria-label="Stage for ${s.name}">${['disabled', 'shadow', 'paper', 'live'].map((st) => html`<option ${raw(st === s.stage ? 'selected' : '')}>${st}</option>`)}</select></div>
      <p class="secondary" style="margin-top:0">${s.description}</p>
      <div class="grid g4">
        <div><h3>Paper</h3>${s.paper.trades} trades · <span class="${fmt.cls(s.paper.netPnl)}">${fmt.inr(s.paper.netPnl)}</span> · win ${fmt.pct(s.paper.winRate, 0)}</div>
        <div><h3>Shadow</h3>${s.shadow ? `${s.shadow.n} scored · mean R ${fmt.num(s.shadow.meanR)} · ${s.shadow.pending} pending` : '—'}</div>
        <div><h3>Latest trial</h3>${s.latestTrial ? html`${s.latestTrial.passed ? badge('gates passed', 'good') : badge('gates failed', 'crit')} DSR ${fmt.num(s.latestTrial.dsr)} · PBO ${fmt.num(s.latestTrial.pbo)}` : html`<span class="muted">none — run one in Validation</span>`}</div>
        <div><h3>Decay monitor</h3>${d ? (d.demote ? badge('demote to shadow', 'crit') : badge('OK', 'good')) : ''} <span class="muted" style="font-size:12px">${d?.reason || ''}</span></div>
      </div>
      <div class="muted mono" style="margin-top:8px;font-size:12px">${JSON.stringify(s.params)}</div></div>`.__raw;
  }).join('');
  $$('[data-stage]').forEach((sel) => sel.addEventListener('change', async () => {
    let justification;
    if (sel.value === 'live') {
      justification = prompt('Promoting to LIVE. If the latest trial did not pass all gates, give a written justification (>= 20 chars); otherwise leave empty:') || undefined;
    }
    try {
      await post(`/api/strategies/${sel.dataset.stage}/stage`, { stage: sel.value, justification });
      toast('Stage updated');
    } catch (e) { toast(e.message, true); }
    route();
  }));
}

// ---------------------------------------------------------------------------
// risk & config

const FIELD_HELP = {
  riskPerTrade: 'Fraction of equity risked per trade', maxDrawdownHalt: 'Drawdown that engages the kill switch', dailyLossLimit: 'Day loss that halts entries',
  maxOpenPositions: 'Max concurrent positions', maxGrossExposure: 'Gross exposure / equity', maxPositionNotional: 'Single-name notional / equity',
  maxParticipation: 'Share of 1-minute volume per order', bandBufferAtr: 'No entries within N ATR of a price band', maxOpenRisk: 'Sum of stop distances / equity',
  maxPerSector: 'Positions per sector', correlationThreshold: 'Correlation treated as the same bet', maxConsecutiveLosses: 'Losses that pause a strategy for the day', minMetaProb: 'Meta-label veto threshold',
};

async function pageRisk(el) {
  const cfg = await api('/api/config');
  const o = state.overview;
  const form = (name, obj) => html`<form class="card" data-cfg="${name}"><h2>${name[0].toUpperCase() + name.slice(1)}</h2><div class="form-grid">
    ${Object.entries(obj).map(([k, v]) => html`<label class="field" title="${FIELD_HELP[k] || ''}">${k}${typeof v === 'boolean' ? html`<select name="${k}"><option value="true" ${raw(v ? 'selected' : '')}>true</option><option value="false" ${raw(!v ? 'selected' : '')}>false</option></select>` : html`<input name="${k}" type="number" step="any" value="${v}">`}<span class="muted" style="font-size:11.5px">${FIELD_HELP[k] || ''}</span></label>`)}
    </div><div class="toolbar" style="margin-top:12px"><button class="primary" type="submit">Save ${name}</button><span class="muted">Changes apply immediately and are written to the audit log.</span></div></form>`;
  el.innerHTML = html`<div class="page-head"><h1>Risk & configuration</h1><span class="spacer"></span>
      ${o?.killSwitch.engaged ? raw('<button class="primary" id="kill-toggle">Disengage kill switch…</button>') : raw('<button class="danger" id="kill-toggle">Engage kill switch</button>')}</div>
    <div class="stack">${form('risk', cfg.risk)}${form('scanner', cfg.scanner)}${form('research', cfg.research)}
    <div class="card"><h2>Strategy circuit breakers (today)</h2><pre class="json">${JSON.stringify(o?.breakers || {}, null, 2)}</pre></div></div>`.__raw;
  $('#kill-toggle').addEventListener('click', () => killDialog(!!o?.killSwitch.engaged));
  $$('[data-cfg]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(f)) body[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
    await act(() => put(`/api/config/${f.dataset.cfg}`, body), `${f.dataset.cfg} saved`);
  }));
}

// ---------------------------------------------------------------------------
// validation

async function pageValidation(el) {
  const [jobs, trials] = await Promise.all([api('/api/backtests'), api('/api/validation/trials?limit=100')]);
  el.innerHTML = html`<div class="page-head"><h1>Validation</h1></div>
    <div class="banner info">Each run backtests the chosen strategies with the live engine, reruns at doubled slippage, backtests a parameter family for PBO (CSCV), deflates the Sharpe by every trial ever registered, applies the gates (DSR &gt; 0.95, PBO &lt; 0.2, positive after-cost expectancy, survives 2× slippage, fold stability) and records the trial.</div>
    <div class="grid g2">
      <form class="card" id="bt-form"><h2>Run a validation backtest</h2><div class="form-grid">
        <label class="field">Strategy<select name="strategy"><option value="all">All (ensemble)</option><option>trend_following</option><option>mean_reversion</option><option>breakout</option></select></label>
        <label class="field">Days<input name="days" type="number" min="5" max="60" value="20"></label>
        <label class="field">Instruments<input name="instruments" type="number" min="3" max="40" value="12"></label>
        <label class="field">Data<select name="source"><option value="synthetic">Synthetic (pipeline check)</option><option value="db">Stored bars</option></select></label>
      </div><div class="toolbar" style="margin-top:12px"><button class="primary">Run</button></div></form>
      <div class="card"><h2>Runs</h2><div id="jobs"></div></div>
    </div>
    <div id="job-detail"></div>
    <div class="card" style="margin-top:14px"><h2>Trial registry (${trials.length})</h2><div id="trials"></div></div>`.__raw;
  $('#bt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await act(() => post('/api/backtests', f), 'Backtest started');
    pollJob(r.id);
  });
  $('#jobs').innerHTML = table([
    { label: 'Started', render: (j) => fmt.dt(j.startedAt) }, { label: 'Params', render: (j) => html`<span class="mono">${JSON.stringify(j.params)}</span>` },
    { label: 'Status', render: (j) => badge(j.status, j.status === 'done' ? 'good' : j.status === 'error' ? 'crit' : 'info') },
    { label: 'Gates', render: (j) => (j.result?.gate ? (j.result.gate.passed ? badge('passed', 'good') : badge('failed', 'crit')) : '') },
  ], jobs, { onRow: true, empty: 'No runs yet.' }).__raw;
  bindRows($('#jobs'), jobs, (j) => pollJob(j.id));
  $('#trials').innerHTML = table([
    { label: 'Time', render: (t) => fmt.dt(t.ts) }, { label: 'Family', key: 'strategyId' }, { label: 'Range', render: (t) => `${t.dataRange.from} → ${t.dataRange.to}` },
    { label: 'Obs', key: 'nObs', num: true }, { label: 'Sharpe/d', render: (t) => fmt.num(t.sharpe, 3), num: true }, { label: 'DSR', render: (t) => fmt.num(t.dsr, 3), num: true },
    { label: 'PBO', render: (t) => fmt.num(t.pbo, 2), num: true }, { label: 'Gates', render: (t) => (t.passed ? badge('passed', 'good') : badge('failed', 'crit')) },
    { label: 'Hypothesis', key: 'hypothesis', wrap: true },
  ], trials, { empty: 'No trials registered yet.' }).__raw;
}

async function pollJob(id) {
  const box = $('#job-detail');
  if (!box) return;
  const j = await api(`/api/backtests/${id}`);
  if (j.status === 'running') {
    box.innerHTML = html`<div class="card" style="margin-top:14px"><h2>Run ${id}</h2><div class="empty">Running backtest + validation family… (this takes a few seconds)</div></div>`.__raw;
    setTimeout(() => { if (state.page === 'validation') pollJob(id); }, 1500);
    return;
  }
  if (j.status === 'error') { box.innerHTML = html`<div class="banner crit" style="margin-top:14px">Run failed: ${j.error}</div>`.__raw; return; }
  const r = j.result;
  const m = r.metrics;
  box.innerHTML = html`<div class="card" style="margin-top:14px"><div class="page-head"><h2 style="margin:0">Run ${id}</h2>${r.gate.passed ? badge('ALL GATES PASSED', 'good') : badge('GATES FAILED', 'crit')}<span class="spacer"></span><span class="muted">trial ${r.trialId}</span></div>
    ${r.warning ? html`<div class="banner warn">${r.warning}</div>` : ''}
    <div class="kpis">${kpi('Return', fmt.signPct(m.totalReturn), `${m.days} days`, fmt.cls(m.totalReturn))}${kpi('Sharpe (ann.)', fmt.num(m.annualisedSharpe), `2× slippage: ${fmt.num(r.doubledSlippage.annualisedSharpe)}`)}${kpi('Max drawdown', fmt.pct(m.maxDrawdown))}${kpi('Trades', fmt.int(m.trades), `win ${fmt.pct(m.winRate, 0)} · PF ${fmt.num(m.profitFactor)}`)}${kpi('Expectancy', fmt.inr(m.expectancy), `per trade after costs · fees ${fmt.inr(m.fees)}`, fmt.cls(m.expectancy))}${kpi('Deflated Sharpe', fmt.num(r.dsr.dsr, 3), `SR₀ ${fmt.num(r.dsr.sr0, 3)} over ${r.dsr.nTrials} trials`)}${kpi('PBO', r.pbo === undefined || r.pbo === null ? 'n/a' : fmt.num(r.pbo, 2), 'CSCV on parameter family')}</div>
    <div class="grid g2"><div><h3>Equity</h3><div id="bt-eq"></div></div>
    <div><h3>Gates</h3>${table([{ label: 'Check', key: 'name', wrap: true }, { label: 'Value', render: (c) => String(c.value) }, { label: 'Threshold', key: 'threshold' }, { label: '', render: (c) => (c.passed ? badge('pass', 'good') : badge('fail', 'crit')) }], r.gate.checks)}</div></div>
    <h3 style="margin-top:14px">Parameter family (PBO input)</h3>${table([{ label: 'Config', key: 'config', wrap: true }, { label: 'Sharpe (ann.)', render: (f) => fmt.num(f.sharpe), num: true }, { label: 'Trades', key: 'trades', num: true }, { label: 'Return', render: (f) => fmt.signPct(f.ret), num: true }], r.family)}
    <h3 style="margin-top:14px">Daily returns</h3><div id="bt-daily"></div></div>`.__raw;
  lineChart($('#bt-eq'), r.equityCurve.map((p) => ({ x: p.ts, y: p.equity })), { yFmt: (v) => fmt.inr(v), label: 'Backtest equity', tipFmt: (v) => fmt.inr2(v) });
  barChart($('#bt-daily'), r.dailyReturns.map((v, i) => ({ label: r.dailyDates[i].slice(5), value: v * 100, tip: `${r.dailyDates[i]}: ${fmt.signPct(v)}` })), { yFmt: (v) => `${fmt.num(v, 2)}%`, label: 'Daily returns' });
}

// ---------------------------------------------------------------------------
// surveillance

async function pageSurveillance(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const d = await api(`/api/surveillance?filter=${q.get('filter') === 'all' ? 'all' : 'restricted'}`);
  const st = d.status;
  el.innerHTML = html`<div class="page-head"><h1>Surveillance & tradability</h1><span class="spacer"></span><button id="refresh">Download from NSE now</button></div>
    ${st.fresh ? '' : html`<div class="banner warn">Today's files are not loaded: new equity entries are blocked (fail-closed).</div>`}
    <div class="kpis">${kpi('Symbols', fmt.int(st.counts.symbols), st.date ? `as of ${st.date}` : 'not loaded')}${kpi('F&O ban', fmt.int(st.counts.banned), 'reducing trades only')}${kpi('GSM', fmt.int(st.counts.gsm), 'never initiate')}${kpi('ASM', fmt.int(st.counts.asm), 'stage ≥ 2 blocked')}${kpi('ESM', fmt.int(st.counts.esm))}${kpi('T2T / BE', fmt.int(st.counts.t2t), 'never initiate')}</div>
    <div class="grid g2">
      <div class="card"><h2>Sources</h2>${table([{ label: 'File', render: (r) => r[0] }, { label: 'Status', render: (r) => statusBadge(r[1].ok, 'loaded', 'failed') }, { label: 'Rows', render: (r) => fmt.int(r[1].count), num: true }, { label: 'At', render: (r) => fmt.dt(r[1].at) }, { label: 'Error', render: (r) => r[1].error, wrap: true }], Object.entries(st.sources), { empty: 'Nothing loaded yet.' })}</div>
      <form class="card" id="upload"><h2>Manual upload</h2><p class="muted" style="margin-top:0">Paste CSV contents if the download is blocked. Parsers fail loudly on unexpected headers.</p>
        <div class="form-grid">${['secList', 'foSecBan', 'regInd', 'bulk', 'block'].map((k) => html`<label class="field">${k}<input type="file" name="${k}" accept=".csv,text/csv"></label>`)}</div>
        <div class="toolbar" style="margin-top:12px"><button class="primary">Upload</button></div></form>
    </div>
    <div class="card" style="margin-top:14px"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">Symbols</h2><span class="spacer"></span>
      <div class="seg"><a class="btn ${q.get('filter') === 'all' ? '' : 'on'}" href="#/surveillance">Restricted</a><a class="btn ${q.get('filter') === 'all' ? 'on' : ''}" href="#/surveillance?filter=all">All</a></div></div>
      ${table([{ label: 'Symbol', key: 'symbol' }, { label: 'Series', key: 'series' }, { label: 'Band %', key: 'bandPct', num: true }, { label: 'GSM', key: 'gsm', num: true }, { label: 'LT-ASM', key: 'ltAsm', num: true }, { label: 'ST-ASM', key: 'stAsm', num: true }, { label: 'ESM', key: 'esm', num: true }, { label: 'IBC', render: (r) => (r.ibc ? 'yes' : '') }, { label: 'F&O ban', render: (r) => (r.inFnoBan ? badge('BAN', 'crit') : '') }], d.rows, { empty: 'No restricted symbols (or files not loaded).' })}</div>
    <div class="card" style="margin-top:14px"><h2>Bulk / block deals</h2>${table([{ label: 'Date', key: 'date' }, { label: 'Symbol', key: 'symbol' }, { label: 'Kind', key: 'kind' }, { label: 'Client', key: 'client', wrap: true }, { label: 'Side', key: 'side' }, { label: 'Qty', render: (x) => fmt.int(x.qty), num: true }, { label: 'Price', render: (x) => fmt.num(x.price), num: true }], d.deals, { empty: 'No deals loaded.' })}</div>`.__raw;
  $('#refresh').addEventListener('click', async () => { await act(() => post('/api/surveillance/refresh'), 'Refresh attempted'); route(); });
  $('#upload').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const inp of $$('input[type=file]', e.target)) if (inp.files[0]) body[inp.name] = await inp.files[0].text();
    await act(() => post('/api/surveillance/upload', body), 'Files applied');
    route();
  });
}

// ---------------------------------------------------------------------------
// compliance

async function pageCompliance(el) {
  const [c, cal] = await Promise.all([api('/api/compliance'), api('/api/calendar')]);
  const o = state.overview;
  const checks = [
    ['X-Algo-Name configured', c.algoNameConfigured, c.algoName || 'set UPSTOX_ALGO_NAME to the Algo Name registered on your Upstox Algo Trading App'],
    ['Primary static IP registered', !!c.staticIps.primary, c.staticIps.primary ? `${c.staticIps.primary}${c.staticIps.secondary ? ` · secondary ${c.staticIps.secondary}` : ''}` : 'set STATIC_IP_PRIMARY (and optional STATIC_IP_SECONDARY)'],
    ['Egress IP matches a registered IP', c.egressMatches, c.egressIp ? `egress ${c.egressIp} (checked ${fmt.ago(c.egressCheckedAt)})` : c.egressError || 'not checked'],
    ['Daily Upstox login', c.tokenPresent, c.tokenPresent ? 'access token present' : 'log in below (tokens are invalidated daily and after IP changes)'],
    ['OPS throttle below 10/sec', c.opsHardLimit < 10, `hard cap ${c.opsHardLimit} OPS, alert at ${c.opsAlertAt}; exchange threshold 10`],
    ['Live trading switch', o?.liveTradingEnabled, `MODE=${o?.mode}, LIVE_TRADING_ENABLED=${o?.liveTradingEnabled}`],
  ];
  el.innerHTML = html`<div class="page-head"><h1>Compliance (SEBI / NSE retail-algo framework)</h1><span class="spacer"></span><button id="ipcheck">Check egress IP</button></div>
    <div class="banner ${c.liveReady ? 'info' : 'warn'}">${c.liveReady ? 'All live-order prerequisites pass.' : html`Live orders are blocked until: ${c.blockers.join('; ')}.`}</div>
    <div class="grid g2">
      <div class="card"><h2>Checklist</h2><ul class="health-list">${checks.map(([n, ok, d]) => html`<li><span class="dot ${ok ? 'good' : 'crit'}"></span><span class="name">${n}<div class="muted" style="font-size:12px">${d}</div></span>${ok ? badge('OK', 'good') : badge('Missing', 'crit')}</li>`)}</ul>
        ${c.upstoxLoginUrl ? html`<div class="toolbar" style="margin-top:12px"><a class="btn primary" href="${c.upstoxLoginUrl}">Daily Upstox login</a><span class="muted">Redirect URI must point to /api/upstox/callback</span></div>` : html`<p class="muted">Set UPSTOX_API_KEY, UPSTOX_API_SECRET and UPSTOX_REDIRECT_URI to enable the daily login flow.</p>`}</div>
      <div class="card"><h2>Order headers actually sent</h2><dl class="kv"><dt>Paper (last order)</dt><dd class="mono">${JSON.stringify(c.lastPaperHeaders || null)}</dd><dt>Live (last order)</dt><dd class="mono">${JSON.stringify(c.lastLiveHeaders || null)}</dd></dl>
        <h3 style="margin-top:16px">Throttle</h3><dl class="kv"><dt>Current OPS</dt><dd>${o?.throttle.currentOps}</dd><dt>Peak OPS</dt><dd>${o?.throttle.peakOps}</dd><dt>Throttle rejections</dt><dd>${o?.throttle.rejected}</dd><dt>Last logout</dt><dd>${fmt.dt(c.lastLogoutAt)}</dd></dl></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Reconciliation</h2>
        <dl class="kv"><dt>Paper</dt><dd>${statusBadge(o?.reconcile.paper.ok, 'reconciled', 'mismatch')} ${fmt.ago(o?.reconcile.paper.last?.at)}</dd>${o?.reconcile.live ? html`<dt>Live</dt><dd>${statusBadge(o.reconcile.live.ok, 'reconciled', 'mismatch')} ${fmt.ago(o.reconcile.live.last?.at)}</dd>` : ''}</dl>
        <pre class="json">${JSON.stringify(o?.reconcile, null, 2)}</pre>
        <div class="toolbar"><button id="rec-run">Run reconciliation</button><button id="rec-ack">Acknowledge mismatch…</button></div></div>
      <div class="card"><h2>Session calendar</h2><dl class="kv"><dt>Today</dt><dd>${cal.today}</dd><dt>CAS-eligible equity</dt><dd>${cal.phases.casEq.phase}</dd><dt>Non-CAS equity</dt><dd>${cal.phases.nonCasEq.phase}</dd><dt>F&O</dt><dd>${cal.phases.fo.phase}</dd><dt>Closing auction live since</dt><dd>${cal.casLiveDate}</dd><dt>Revised pre-open since</dt><dd>${cal.newPreopenDate}</dd></dl>
        <h3 style="margin-top:12px">Upcoming holidays</h3><ul>${Object.entries(cal.holidays).filter(([d]) => d >= cal.today).slice(0, 6).map(([d, n]) => html`<li>${d} — ${n}</li>`)}</ul>
        ${cal.special.map((s) => html`<div class="muted">${s.date}: ${s.name}</div>`)}</div>
    </div>`.__raw;
  $('#ipcheck').addEventListener('click', async () => { await act(() => post('/api/compliance/check-ip'), 'Egress IP checked'); route(); });
  $('#rec-run').addEventListener('click', async () => { const r = await act(() => post('/api/reconcile/run')); toast(r.ok ? 'Books agree' : 'Mismatch found', !r.ok); route(); });
  $('#rec-ack').addEventListener('click', async () => { const note = prompt('Describe how the mismatch was resolved (>= 5 chars):'); if (note) { await act(() => post('/api/reconcile/ack', { note }), 'Acknowledged'); route(); } });
}

// ---------------------------------------------------------------------------
// tax

async function pageTax(el) {
  const fy = new URLSearchParams(location.hash.split('?')[1] || '').get('fy');
  const d = await api(`/api/tax${fy ? `?fy=${fy}` : ''}`);
  const tot = d.rows.reduce((a, r) => ({ net: a.net + r.netPnl, tax: a.tax + r.estTax, after: a.after + r.afterTax }), { net: 0, tax: 0, after: 0 });
  el.innerHTML = html`<div class="page-head"><h1>Tax-aware P&L · ${d.fy}</h1><span class="spacer"></span>
      <select id="fy" aria-label="Financial year">${[...new Set([d.fy, ...d.fys])].map((f) => html`<option ${raw(f === d.fy ? 'selected' : '')}>${f}</option>`)}</select></div>
    <div class="banner warn">Estimates for planning only (book: ${d.mode}). Confirm treatment with a chartered accountant under the Income-tax Act 2025 numbering; INR-settled crypto perpetuals are treated conservatively as VDAs.</div>
    <div class="kpis">${kpi('Net P&L after charges', fmt.inr(tot.net), '', fmt.cls(tot.net))}${kpi('Estimated tax', fmt.inr(tot.tax))}${kpi('After-tax P&L', fmt.inr(tot.after), '', fmt.cls(tot.after))}</div>
    <div class="card">${table([
      { label: 'Ledger', key: 'bucket' }, { label: 'Trades', key: 'trades', num: true }, { label: 'Gross', render: (r) => fmt.inr(r.grossPnl), num: true },
      { label: 'Charges', render: (r) => fmt.inr(r.charges), num: true }, { label: 'Net', render: (r) => html`<span class="${fmt.cls(r.netPnl)}">${fmt.inr(r.netPnl)}</span>`, num: true },
      { label: 'Est. tax', render: (r) => fmt.inr(r.estTax), num: true }, { label: 'TDS credit', render: (r) => fmt.inr(r.tdsCredit), num: true },
      { label: 'After tax', render: (r) => html`<span class="${fmt.cls(r.afterTax)}">${fmt.inr(r.afterTax)}</span>`, num: true }, { label: 'Treatment', key: 'note', wrap: true },
    ], d.rows)}</div>`.__raw;
  $('#fy').addEventListener('change', (e) => { location.hash = `#/tax?fy=${e.target.value}`; });
}

// ---------------------------------------------------------------------------
// audit & logs

async function pageAudit(el) {
  const [rows, logs] = await Promise.all([api('/api/audit?limit=200'), api('/api/logs?limit=300&level=info')]);
  el.innerHTML = html`<div class="page-head"><h1>Audit log & system logs</h1><span class="spacer"></span><button id="verify">Verify hash chain</button></div>
    <div id="verify-res"></div>
    <div class="card"><h2>Audit log (append-only, hash-chained)</h2><div id="audit"></div></div>
    <div class="card" style="margin-top:14px"><h2>Recent logs</h2>${table([
      { label: 'Time', render: (l) => fmt.dt(l.ts) }, { label: 'Level', render: (l) => badge(l.level, l.level === 'error' ? 'crit' : l.level === 'warn' ? 'warn' : '') },
      { label: 'Module', key: 'module' }, { label: 'Message', render: (l) => html`${l.msg} <span class="mono muted">${l.data ? JSON.stringify(l.data).slice(0, 300) : ''}</span>`, wrap: true },
    ], logs)}</div>`.__raw;
  $('#audit').innerHTML = table([
    { label: '#', key: 'id', num: true }, { label: 'Time', render: (r) => fmt.dt(r.ts) }, { label: 'Actor', key: 'actor' }, { label: 'Action', key: 'action' },
    { label: 'Entity', render: (r) => html`<span class="mono">${r.entity || ''}</span>` }, { label: 'Hash', render: (r) => html`<span class="mono muted">${r.hash.slice(0, 12)}…</span>` },
  ], rows, { onRow: true }).__raw;
  bindRows($('#audit'), rows, (r) => drawer(html`<h2>Audit #${r.id} · ${r.action}</h2><dl class="kv"><dt>Time</dt><dd>${fmt.dt(r.ts)}</dd><dt>Actor</dt><dd>${r.actor}</dd><dt>Entity</dt><dd>${r.entity || '—'}</dd><dt>Prev hash</dt><dd class="mono">${r.prev_hash}</dd><dt>Hash</dt><dd class="mono">${r.hash}</dd></dl><h3 style="margin-top:14px">Payload</h3><pre class="json">${JSON.stringify(JSON.parse(r.payload), null, 2)}</pre>`));
  $('#verify').addEventListener('click', async () => {
    const v = await api('/api/audit/verify');
    $('#verify-res').innerHTML = html`<div class="banner ${v.ok ? 'info' : 'crit'}">${v.ok ? `Chain intact: ${v.rows} rows verified.` : `Chain BROKEN at row ${v.brokenAt} (after ${v.rows} valid rows).`}</div>`.__raw;
  });
}

// ---------------------------------------------------------------------------
// settings

async function pageSettings(el) {
  const s = await api('/api/settings');
  el.innerHTML = html`<div class="page-head"><h1>Settings</h1></div>
    <div class="grid g2">
      <form class="card" id="pw"><h2>Change admin password</h2><div class="stack">
        <label class="field">Current<input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field">New (min 12 chars)<input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
        <button class="primary">Change password</button></div></form>
      <form class="card" id="reset"><h2>Reset paper account</h2><p class="secondary">Clears paper positions and restarts with fresh capital. Flatten first.</p>
        <div class="toolbar"><input name="capital" type="number" min="1" value="${s.CAPITAL_INR}" aria-label="Capital"><button class="danger">Reset paper book</button></div></form>
    </div>
    <div class="card" style="margin-top:14px"><h2>Environment (secrets redacted)</h2><p class="muted" style="margin-top:0">Static settings come from the environment / .env and require a restart. Runtime limits live under Risk & config.</p>
      <dl class="kv">${Object.entries(s).map(([k, v]) => html`<dt class="mono">${k}</dt><dd class="mono">${String(v)}</dd>`)}</dl></div>`.__raw;
  $('#pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await act(() => post('/api/auth/password', { current: f.get('current'), next: f.get('next') }), 'Password changed — sign in again');
    renderLogin();
  });
  $('#reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('Reset the paper account?')) return;
    await act(() => post('/api/paper/reset', { capital: Number(new FormData(e.target).get('capital')) }), 'Paper account reset');
  });
}

const PAGES = {
  dashboard: pageDashboard, trading: pageTrading, scanner: pageScanner, research: pageResearch, strategies: pageStrategies,
  risk: pageRisk, validation: pageValidation, surveillance: pageSurveillance, compliance: pageCompliance, tax: pageTax, audit: pageAudit, settings: pageSettings,
};

try {
  const t = localStorage.getItem('ta-theme');
  if (t) document.documentElement.dataset.theme = t;
} catch { /* storage unavailable */ }
boot();
