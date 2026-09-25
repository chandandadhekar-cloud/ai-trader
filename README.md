# TradeAI

An event-driven trading system for Indian equities and F&O (Upstox) and Delta Exchange India crypto perpetuals, built in Node.js/TypeScript from the *TradeAI Gap Analysis and Upgraded Implementation Plan (Sep 2026)*. It includes an admin console for visibility and control.

Design rules carried over from the plan:

- **No trade is the default.** Every entry passes surveillance, compliance, staleness, risk and cost/tax gates.
- **The LLM never sizes or places trades.** It proposes a label; code verifies citations and timestamps and maps the label to an allowed action.
- **Backtest, paper and live share one code path**: the same strategies, risk engine, OMS, fill simulator and decision loop.
- **Accuracy is the wrong goal.** The target is a validated edge after costs and taxes. Validation uses Deflated Sharpe, PBO, CPCV and doubled-slippage tests, and every run is recorded in a trial registry.

> ⚠️ Nothing here is investment advice. Run in **paper** mode for at least 8 weeks, then micro-live, as the plan's section G requires. Live trading needs static-IP egress, a registered Algo Name and your own review of every rule and threshold.

## Quick start

```bash
npm install
npm start                       # paper mode, synthetic market, console on http://127.0.0.1:8080
```

On first run, an admin password is generated and written to `data/INITIAL_ADMIN_PASSWORD.txt`. Sign in, change the password under **Settings**, then delete the file. To set the password yourself, run `npm run admin:passwd -- "<password>"` and put the output in `.env` as `ADMIN_PASSWORD_HASH`.

Requires **Node ≥ 22.18**. TypeScript runs natively through Node's type stripping, so there is no build step.

| Command | Purpose |
|---|---|
| `npm start` / `npm run dev` | Run the node (with `--watch` in dev) |
| `npm test` / `npm run typecheck` / `npm run check` | 68 tests, strict type check, or both |
| `npm run backtest -- --days 20` | CLI backtest (synthetic data, or `--csv file`) |
| `npm run train:meta -- --db data/tradeai.db` | Train the meta-label model; it is saved only if it improves CPCV out-of-sample R |
| `npm run eval:research` | Golden-set regression eval for the research agent (`--deep`, `--deterministic`) |
| `npm run watchdog` | External heartbeat watchdog (run it on another host) |
| `npm run backup -- <dir>` | Consistent online SQLite snapshot |

## Going from synthetic data to real data and real money

1. Copy `.env.example` to `.env`. Set the Upstox API key, secret and redirect URI (`https://<host>/api/upstox/callback`), then set `DATA_SOURCE=upstox`.
2. Complete the **daily Upstox login** from the Compliance page. Tokens expire daily and whenever the registered IP changes. The session is logged out at 23:45 IST.
3. Surveillance files are downloaded at 08:30 IST. If the download fails, equity entries stay blocked until the files are uploaded from the Surveillance page.
4. Keep strategies in `shadow` or `paper` and run validation backtests on stored bars (`Validation → Data: Stored bars`).
5. Before live trading:
   - Set `STATIC_IP_PRIMARY`/`SECONDARY` and `UPSTOX_ALGO_NAME`, then `MODE=live` and `LIVE_TRADING_ENABLED=true`.
   - The Compliance page must show no blockers.
   - A strategy can only be promoted to `live` once its latest trial passes every gate, or with an audited written override.

## Admin console

| Page | What you get |
|---|---|
| **Dashboard** | Equity, day P&L, drawdown, open risk, system-health checklist, live activity (anomalies, verdicts, signals, orders, alerts), kill switch |
| **Positions & orders** | Paper and live books; broker-stop confirmation status; manual exit, cancel and flatten |
| **Scanner** | Anomaly log with filters, per-type counts and forward-return labels, detector details, one-click research |
| **Research** | Verdicts with verified claims, fact-pack sources and why code decided the label; calibration chart; manual research |
| **Strategies** | Stage control (disabled → shadow → paper → live), paper and shadow stats, latest trial gates, decay monitor |
| **Risk & config** | Every runtime limit (risk, scanner, research), editable and audited; circuit breakers |
| **Validation** | Backtest + DSR + PBO + 2× slippage + fold-stability gates in a worker thread; trial registry |
| **Surveillance** | GSM/ASM/ESM/IBC/T2T/F&O-ban state, bands, bulk and block deals, NSE download or manual upload |
| **Compliance** | Algo Name, static IPs, egress check, headers actually sent, OPS throttle, reconciliation, session calendar, Upstox login |
| **Tax & P&L** | Intraday (speculative), F&O (business), STCG, LTCG and crypto VDA ledgers with after-tax P&L |
| **Audit & logs** | Hash-chained audit log with chain verification; recent system logs |

Prometheus metrics are served at `/metrics`. Alert rules are in `deploy/prometheus-alerts.yml`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how each part of the plan is implemented (and what is not yet), and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for operations.
