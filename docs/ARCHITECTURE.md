# Architecture and plan coverage

## Runtime flow

```
 Upstox WS (A: Full ≤1,500 · B: LTPC ≤2,000) ─┐
 Upstox REST sweeps (C: 500 keys/call)  ───────┼─► tick ─► freak filter ─► QuoteBook ─► BarBuilder (1-min)
 Delta tickers · synthetic market       ───────┘                │                         │
                                                                ▼                         ▼
                                                         PaperBroker fills         Scanner (per-minute cross-section
                                                                                   + 1-s live pass) ─► anomaly
                                                                                          │
         research.request ◄──────────── severity ≥ threshold / open position ◄───────────┘
                │
   Fact pack (<2 s, no LLM) ─► fast (Haiku 4.5) | deep (Opus 5: 3 analysts → skeptic → 2 judges)
                │                                   | deterministic fallback
   verify (citations, timestamps, source priority) ─► calibrate ─► verdict mapper ─► research.verdict (TTL)
                                                                                          │
 1-minute decision loop:  gates (session, surveillance, staleness, compliance, reconcile)  │
   strategies ─► ensemble ─► meta-label veto/size ─► risk sizing ─► OMS ◄── fresh verdicts ┘
                                                             │
                              marketable LIMIT entry ─► broker ─► fill ─► broker-side SL placed & acked
                              position monitor: targets, time stops, square-off, PROTECT, stop maintenance
```

All components communicate over an in-process event bus. Topics keep bounded, ordered logs with isolated handlers, like Redis Streams consumer groups. The research consumer never blocks the decision loop. Validation backtests run in a worker thread.

## Plan coverage

Status key: ✅ implemented and tested · 🟡 implemented, needs live verification or data · ⬜ not implemented yet.

### P0: blocks live trading or can cause large losses

| Plan item | Where | Status |
|---|---|---|
| Static-IP egress check (primary/secondary), fail-closed live gate | `brokers/compliance.ts` | ✅ |
| `X-Algo-Name` on every order call; recorded on every order row | `brokers/upstox/rest.ts`, `oms/oms.ts` | ✅ |
| Token-bucket OPS guard (hard cap < 10, alert at 5), Upstox 25/s · 250/min · 1000/30 min | `brokers/throttle.ts` | ✅ |
| Daily login flow, logout before next trading day | `api/server.ts` (callback), `app.ts` (23:45 IST) | 🟡 |
| NSE files: REG_IND, sec_list, fo_secban, bulk/block; daily download, manual upload, fail-closed | `surveillance/*` | 🟡 (parsers are header-driven; confirm against current file layouts) |
| Never initiate on T2T/BE, GSM, tight ASM, ESM, IBC; F&O ban = reduce-only | `surveillance/tradability.ts` | ✅ |
| Band proximity (1.5 × ATR), band-lock = exit-impossible, dynamic F&O band flex in the simulator | `surveillance/bands.ts`, `sim/fillSimulator.ts` | ✅ |
| Overfitting controls: CPCV + embargo, DSR, PBO (CSCV), White RC / Hansen SPA, trial registry | `ml/cv.ts`, `validation/*` | ✅ |
| LLM look-ahead: LLM verdicts not replayed in backtests; training-cutoff setting; perturbation tests | `sim/backtester.ts`, `LLM_TRAINING_CUTOFF` | 🟡 (counterfactual perturbation suite ⬜) |
| Broker-side protective orders placed at entry, confirmed before a trade counts as open; flatten + P0 on failure | `oms/oms.ts` | ✅ (intraday SL; GTT helper for delivery exists, not wired ⬜) |
| Delta cancel-after dead-man timer | `brokers/delta/rest.ts` | 🟡 (verify endpoint with Delta) |
| Startup and periodic reconciliation; entries blocked until clean or acknowledged | `oms/oms.ts` | ✅ |
| Idempotency ledger (deterministic client order ids, primary key) | `oms/oms.ts`, `db/database.ts` | ✅ |

### P1: edge quality and data correctness

| Plan item | Where | Status |
|---|---|---|
| PIT instrument master (ISIN history, universe by date), corp-action factors kept separate | `refdata/*` | 🟡 (API present; history must be loaded) |
| Session calendar: pre-open (revised 7 Sep 2026), CAS (3 Aug 2026), holidays, Muhurat, cut-offs | `config/calendar.ts` | ✅ (refresh holidays yearly) |
| Freak-trade filter | `surveillance/freakTrade.ts` | ✅ |
| Option chain snapshots, IV-rank, PCR, basis/rollover | `brokers/upstox/rest.ts` (`optionChain`) | ⬜ |
| OI spike with build-up quadrant, IV jump | `scanner/scanner.ts` | ✅ (needs F&O keys subscribed) |
| FII/DII flows, GIFT Nifty, US futures, DXY, USD/INR, Brent | fact pack `globalCues` | 🟡 (only instruments you subscribe) |
| Cost realism: effective-dated STT/exchange/SEBI/stamp/GST; Delta maker/taker + GST + TDS; √-impact slippage | `sim/fees.ts`, `sim/fillSimulator.ts` | ✅ |
| ≤ 1% of 1-minute volume cap | `risk/engine.ts` | ✅ |
| Capacity study (2×/5×/10× size) | — | ⬜ |
| Meta-labeling on triple-barrier labels; veto + bet size | `ml/*`, `engine/decisionLoop.ts` | ✅ |
| Decay/drift: live-vs-backtest Sharpe CI, Page–Hinkley, PSI/KS | `ml/drift.ts`, `/api/drift` | ✅ (auto-demotion is advisory in the UI) |

### P2: operations, observability, governance

| Plan item | Where | Status |
|---|---|---|
| Prometheus metrics (tick lag, WS reconnects, gaps backfilled, ack latency, rejections, OPS peak, LLM p95/cost, open risk) | `ops/metrics.ts`, `/metrics` | ✅ |
| Telegram + P0 webhook alerts; external heartbeat watchdog with optional exit-all | `ops/alerts.ts`, `ops/watchdog.ts` | ✅ |
| Clock skew and per-instrument staleness; stale data blocks entries | `core/clock.ts`, `marketdata/staleness.ts` | ✅ (run chrony on the host) |
| Append-only, hash-chained audit log | `governance/auditLog.ts` | ✅ |
| DR: WAL-mode SQLite with online backups, warm standby on the secondary IP, runbook | `cli/backup.ts`, `docs/RUNBOOK.md` | 🟡 |
| Tax ledgers (speculative / F&O / STCG / LTCG / VDA) | `analytics/taxLedger.ts` | ✅ (estimates; confirm with a CA) |

### Scanner (§B), research agent (§C), AI (§D)

| Plan item | Status |
|---|---|
| Tiered coverage A/B/C/D within Upstox caps; dynamic promotion with LRU eviction | ✅ (`scanner/promotion.ts`, `brokers/upstox/feed.ts`) |
| Vol-adjusted shock with U-shaped time-of-day profile; RVOL vs same minute over 20 days (plus 5-minute burst); sector-relative residual; index shock (macro path); gap vs index; band; CUSUM + BOCPD | ✅ |
| Unusual options activity; crypto funding/basis detectors | ⬜ (types reserved) |
| Debounce, severity, index-explains-> 70% suppression, log everything, forward-return labels | ✅ |
| Fact pack, fast path, deep multi-agent path with skeptic and self-consistency, mandatory citations, primary-source priority, post-hoc timestamp check, priced-in rule, calibration, verdict → deterministic action | ✅ |
| Numbers extraction from filings by code | ⬜ |
| RAG over a filings index (pgvector) | ⬜ |
| Local FinBERT/DeBERTa first pass | 🟡 (lexicon placeholder in `research/localNlp.ts`) |
| Versioned prompts, pinned models, golden-set regression eval | ✅ (starter golden set; expand to 500–1,000 labelled cases) |

## Deliberate substitutions

- **SQLite (WAL) instead of Postgres/Timescale; in-process bus instead of Redis Streams.** One node, no external services, zero-build deploy. The SQL is portable, and the bus interface is small enough to swap for Redis Streams when components move to separate processes.
- **Upstox order updates are polled** (every 2 s) instead of read from the portfolio stream WebSocket. This is simpler and robust, and well inside rate limits. The stream authorize endpoint is wrapped for a later upgrade.
- **Delta market data uses REST polling** (5 s); the WebSocket feed is not wired yet.

## Unverified facts to confirm before live (from the plan's caveats)

- Upstox order-API rate-limit categories under the 5 May 2025 circular; set `OPS_HARD_LIMIT` below them.
- Multi-order per-request cap (10 vs 25). The code uses 10.
- The reported end of API market orders: the OMS never sends MARKET/SL-M to Upstox.
- Delta India WebSocket limits and the exact `cancel_after` endpoint semantics.
- NSE file layouts (REG_IND column names in particular). The parsers throw rather than guess.
- Tax treatment, especially of INR-settled perpetuals, with a chartered accountant.
