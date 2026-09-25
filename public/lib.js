// Shared helpers for the admin console: API client, formatting, DOM, charts.

export class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (init.method !== 'GET') init.headers['X-Requested-With'] = 'tradeai';
  const res = await fetch(path, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`);
  return data;
}
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v === undefined || v === null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v && v.__raw) out += v.__raw;
      else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.__raw : esc(x))).join('');
      else out += esc(v);
    }
  });
  return { __raw: out };
}
export const raw = (s) => ({ __raw: s });

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt = {
  inr: (v) => (v === undefined || v === null || !Number.isFinite(+v) ? '—' : `₹${inr.format(+v)}`),
  inr2: (v) => (v === undefined || v === null || !Number.isFinite(+v) ? '—' : `₹${inr2.format(+v)}`),
  num: (v, d = 2) => (v === undefined || v === null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })),
  int: (v) => (v === undefined || v === null || !Number.isFinite(+v) ? '—' : inr.format(+v)),
  pct: (v, d = 2) => (v === undefined || v === null || !Number.isFinite(+v) ? '—' : `${(+v * 100).toFixed(d)}%`),
  signPct: (v, d = 2) => (v === undefined || v === null || !Number.isFinite(+v) ? '—' : `${v >= 0 ? '+' : ''}${(+v * 100).toFixed(d)}%`),
  time: (ts) => (ts ? new Date(ts).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '—'),
  dt: (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'),
  date: (ts) => (ts ? new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—'),
  ago: (ts) => {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
  cls: (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : ''),
};

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

let toastTimer;
export function toast(msg, isErr = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast${isErr ? ' err' : ''}`;
  el.setAttribute('role', isErr ? 'alert' : 'status');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

export function badge(text, kind = '') {
  return html`<span class="badge ${kind}">${text}</span>`;
}

export function statusBadge(ok, okText = 'OK', badText = 'Issue', warn = false) {
  return ok ? html`<span class="badge good"><span class="dot good"></span>${okText}</span>` : html`<span class="badge ${warn ? 'warn' : 'crit'}"><span class="dot ${warn ? 'warn' : 'crit'}"></span>${badText}</span>`;
}

const VERDICT_KIND = { REACT: 'info', FADE: 'warn', PROTECT: 'crit', BLOCK: 'crit', IGNORE: '', UNCERTAIN: '' };
export const verdictBadge = (v) => badge(v, VERDICT_KIND[v] ?? '');

export function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return html`<div class="empty">${opts.empty || 'Nothing to show yet.'}</div>`;
  const head = cols.map((c) => html`<th class="${c.num ? 'num' : ''}" scope="col">${c.label}</th>`);
  const body = rows.map((r, i) => {
    const cells = cols.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      return html`<td class="${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''}">${v && v.__raw ? v : v === undefined || v === null || v === '' ? '—' : v}</td>`;
    });
    return html`<tr class="${opts.onRow ? 'clickable' : ''}" data-row="${i}" ${raw(opts.onRow ? 'tabindex="0"' : '')}>${cells}</tr>`;
  });
  return html`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function bindRows(container, rows, onRow) {
  $$('tr[data-row]', container).forEach((tr) => {
    const go = () => onRow(rows[+tr.dataset.row]);
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

export function drawer(content) {
  closeDrawer();
  const bg = document.createElement('div');
  bg.className = 'drawer-bg';
  bg.id = 'drawer-bg';
  const d = document.createElement('div');
  d.className = 'drawer';
  d.id = 'drawer';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = `<button class="close ghost" aria-label="Close">✕</button>${content.__raw ?? esc(content)}`;
  bg.addEventListener('click', closeDrawer);
  d.querySelector('.close').addEventListener('click', closeDrawer);
  document.body.append(bg, d);
  const onKey = (e) => { if (e.key === 'Escape') { closeDrawer(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return d;
}
export function closeDrawer() {
  $('#drawer')?.remove();
  $('#drawer-bg')?.remove();
}

// ---------------------------------------------------------------------------
// Charts (inline SVG). Single-series line/area with crosshair tooltip, and
// vertical bars with per-bar tooltip. Colours come from CSS tokens.

function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

/**
 * points: [{x: number(ms), y: number}], opts: {yFmt, xFmt, height, baseline}
 */
export function lineChart(el, points, opts = {}) {
  if (!points.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }
  const W = Math.max(el.clientWidth || 600, 280);
  const H = opts.height || 220;
  const m = { l: 64, r: 12, t: 10, b: 26 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ticks = niceTicks(Math.min(...ys, opts.baseline ?? Infinity), Math.max(...ys, opts.baseline ?? -Infinity));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const sx = (x) => m.l + ((x - x0) / Math.max(x1 - x0, 1)) * (W - m.l - m.r);
  const sy = (y) => m.t + (1 - (y - y0) / Math.max(y1 - y0, 1e-12)) * (H - m.t - m.b);
  const yFmt = opts.yFmt || ((v) => fmt.num(v, 0));
  const xFmt = opts.xFmt || ((v) => fmt.dt(v));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const area = `${path}L${sx(x1).toFixed(1)},${sy(y0)}L${sx(x0).toFixed(1)},${sy(y0)}Z`;
  const grid = ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${m.l - 8}" y="${sy(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join('');
  const xt = [x0, x0 + (x1 - x0) / 2, x1].map((x, i) => `<text x="${sx(x)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${esc(opts.xTick ? opts.xTick(x) : fmt.date(x))}</text>`).join('');
  const base = opts.baseline !== undefined ? `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${sy(opts.baseline)}" y2="${sy(opts.baseline)}"/>` : '';
  el.classList.add('chart');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'chart')}"><g class="axis">${grid}${xt}</g>${base}<path class="area" d="${area}"/><path class="line" d="${path}"/><line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/><circle class="hoverdot" r="4.5" visibility="hidden"/><rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/></svg><div class="tooltip" hidden></div>`;
  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.hoverdot');
  const tip = el.querySelector('.tooltip');
  const hit = svg.querySelector('.hit');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(sx(p.x) - px); if (d < bd) { bd = d; best = i; } });
    const p = points[best];
    cross.setAttribute('x1', sx(p.x)); cross.setAttribute('x2', sx(p.x)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', sx(p.x)); dot.setAttribute('cy', sy(p.y)); dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<div class="muted">${esc(xFmt(p.x))}</div><div class="v">${esc(opts.tipFmt ? opts.tipFmt(p.y) : yFmt(p.y))}</div>`;
    const left = (sx(p.x) / W) * r.width;
    tip.style.left = `${Math.min(Math.max(left + 12, 0), r.width - tip.offsetWidth)}px`;
    tip.style.top = `${(sy(p.y) / H) * r.height - 50}px`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
}

/** bars: [{label, value, tip?}] — vertical bars from a zero baseline (negatives in critical). */
export function barChart(el, bars, opts = {}) {
  if (!bars.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }
  const W = Math.max(el.clientWidth || 600, 280);
  const H = opts.height || 220;
  const m = { l: 56, r: 8, t: 10, b: 44 };
  const vals = bars.map((b) => b.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const ticks = niceTicks(lo, lo === 0 && hi === 0 ? 1 : hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const sy = (y) => m.t + (1 - (y - y0) / Math.max(y1 - y0, 1e-12)) * (H - m.t - m.b);
  const bw = (W - m.l - m.r) / bars.length;
  const gap = Math.max(2, bw * 0.25);
  const yFmt = opts.yFmt || ((v) => fmt.num(v, 0));
  const grid = ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${m.l - 8}" y="${sy(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join('');
  const rects = bars.map((b, i) => {
    const x = m.l + i * bw + gap / 2;
    const top = sy(Math.max(b.value, 0));
    const h = Math.abs(sy(b.value) - sy(0));
    const lbl = bars.length <= 16 ? `<text x="${x + (bw - gap) / 2}" y="${H - m.b + 14}" text-anchor="middle">${esc(String(b.label).slice(0, 12))}</text>` : '';
    return `<rect class="bar ${b.value < 0 ? 'negv' : ''}" x="${x}" y="${top}" width="${Math.max(1, bw - gap)}" height="${Math.max(h, 0.5)}" rx="2"/><rect data-i="${i}" class="hitbar" x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${H - m.t - m.b}" fill="transparent"/>${lbl}`;
  }).join('');
  el.classList.add('chart');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'bar chart')}"><g class="axis">${grid}</g><line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${sy(0)}" y2="${sy(0)}"/><g class="axis">${rects}</g></svg><div class="tooltip" hidden></div>`;
  const tip = el.querySelector('.tooltip');
  const svg = el.querySelector('svg');
  el.querySelectorAll('.hitbar').forEach((r) => {
    r.addEventListener('pointermove', (ev) => {
      const b = bars[+r.dataset.i];
      const box = svg.getBoundingClientRect();
      tip.hidden = false;
      tip.innerHTML = `<div class="muted">${esc(b.label)}</div><div class="v">${esc(b.tip || yFmt(b.value))}</div>`;
      tip.style.left = `${Math.min(ev.clientX - box.left + 12, box.width - tip.offsetWidth)}px`;
      tip.style.top = `${ev.clientY - box.top - 44}px`;
    });
    r.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}
