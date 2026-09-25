# Operations runbook

## Daily routine (IST)

| Time | Action | Automated? |
|---|---|---|
| 08:30 | NSE surveillance files downloaded; check **Surveillance** shows today's date | yes. If the download fails, upload the files manually |
| 08:45 | Complete the **Upstox login** from **Compliance**; confirm no blockers and a fresh egress-IP check | login is manual |
| 09:00–09:15 | Pre-open (revised schedule since 7 Sep 2026). No entries; the gap scanner uses the pre-open price | yes |
| 09:15–14:45 | Entries allowed (last entry 14:45 for CAS stocks, 15:00 otherwise) | yes |
| 14:55 / 15:10 / 15:20 | Intraday square-off: CAS equity / non-CAS equity / F&O | yes |
| 15:15 | The exchange cancels stop orders on CAS stocks. Positions must already be flat (they are, via the 14:55 square-off) | — |
| after close | Review Dashboard, Strategies (decay monitor), Research calibration, Tax | manual |
| 23:45 | Upstox session logout | yes |

## Kill switch

- **Engage** from the Dashboard or Risk page. This blocks all new entries; broker-side stops stay live. Tick "flatten" to exit everything with marketable limit orders.
- It engages automatically at the drawdown halt (default 10%). A daily loss beyond the limit (default 2%) blocks entries for the rest of the day.
- **Disengaging needs a written note**, which goes to the audit log.

## Broker down / API errors

1. Engage the kill switch (no new entries).
2. The broker-side stop orders placed at entry stay in force at the exchange.
3. If you must flatten and the API is unavailable, use the Upstox app or web to exit positions.
4. When the API is back, run **Compliance → Run reconciliation**. If the books differ, fix them at the broker, then **Acknowledge** with a note. Entries stay blocked until you do.

## Node crash / restart

- systemd restarts the service. At startup the OMS reconciles broker orders and positions against its state before any new signal, and re-places missing broker-side stops.
- The external watchdog (separate host) alerts after 60 s of silence. If `WATCHDOG_EXIT_ALL=true`, it also calls Upstox exit-all from its own registered IP.

## Feed disconnects

- WebSockets reconnect with exponential backoff. On reconnect, missing 1-minute bars are backfilled from intraday candles and marked `backfilled`.
- Stale instruments are blocked for entries. Open positions keep relying on broker-side stops.

## Changing static IP

- Upstox allows one IP change per week, and a change invalidates the access token. Update `STATIC_IP_*`, restart, log in again, and run the egress check.

## Backups and disaster recovery

- Take hourly online snapshots with `npm run backup -- /var/backups/tradeai` and ship them to object storage (for example with rclone).
- Keep a warm standby VPS on the **secondary** registered IP with the code deployed and the latest snapshot restored. It stays disabled until failover.
- Keep the audit log and order history for at least 5 years.

## Promoting a strategy

1. The strategy runs in shadow for ≥ 4 weeks, then paper for ≥ 8 weeks (plan section G).
2. Run a validation backtest on stored bars. All gates must pass: DSR > 0.95, PBO < 0.2, positive after-cost expectancy, survives 2× slippage, stable folds.
3. Micro-live at 10–20% of target size (lower `riskPerTrade`). Stop if live expectancy falls below 50% of the backtest with statistical confidence (the decay monitor shows this).
4. Scale at most monthly, and only while the live Sharpe confidence interval overlaps the backtest estimate.

## Changing prompts or models

Run `npm run eval:research` (the cascade), plus `-- --fast` and `-- --deep`, before and after the change. Compare accuracy **and** cost per case; only switch to a larger model (for example `LLM_DEEP_MODEL=gpt-6-astra`) if the eval shows it fixes real mistakes. Citation validity must stay above 95% and p95 fast-path latency below 20 s. The prompt version is stored on every verdict.
