// Regulatory plumbing for the SEBI retail-algo framework (mandatory for all brokers
// from 1 Apr 2026) and Upstox's implementation (plan §2, §P0.1):
//  - order APIs (place/modify/cancel/multi/GTT/exit-all) must come from a registered
//    static IP (one primary + one optional secondary per app; each IP belongs to one
//    customer; IP change allowed once a week and invalidates the access token)
//  - every order carries `X-Algo-Name` matching the configured Algo Name (the
//    exchange Algo ID is not required in the header)
//  - sub-10-OPS algos need no exchange registration (only one API key per user may
//    run such an algo); above 10 OPS registration is mandatory → hard cap in throttle.ts
//  - API sessions are logged out before the next trading day
// Live order routing is refused unless every check passes (fail closed).

import type { Settings } from '../config/settings.ts';
import type { EventBus } from '../core/events.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('compliance');

export interface ComplianceStatus {
  algoName?: string;
  algoNameConfigured: boolean;
  staticIps: { primary?: string; secondary?: string };
  egressIp?: string;
  egressCheckedAt?: number;
  egressMatches: boolean;
  egressError?: string;
  tokenPresent: boolean;
  lastLogoutAt?: number;
  opsHardLimit: number;
  opsAlertAt: number;
  liveReady: boolean;
  blockers: string[];
}

export class ComplianceGuard {
  private s: Settings;
  private bus: EventBus;
  private egressIp?: string;
  private egressCheckedAt?: number;
  private egressError?: string;
  lastLogoutAt?: number;
  private tokenPresentFn: () => boolean;
  private fetchImpl: typeof fetch;

  constructor(s: Settings, bus: EventBus, tokenPresent: () => boolean, fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.bus = bus;
    this.tokenPresentFn = tokenPresent;
    this.fetchImpl = fetchImpl;
  }

  /** Headers every Upstox order-API call must carry. */
  orderHeaders(): Record<string, string> {
    if (!this.s.UPSTOX_ALGO_NAME) throw new Error('UPSTOX_ALGO_NAME not configured: orders would be rejected by the broker');
    return { 'X-Algo-Name': this.s.UPSTOX_ALGO_NAME };
  }

  async checkEgressIp(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.s.EGRESS_IP_CHECK_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = (await res.text()).trim();
      const changed = this.egressIp && this.egressIp !== ip;
      this.egressIp = ip;
      this.egressError = undefined;
      if (changed || !this.egressMatches()) {
        log.warn('egress IP check', { ip, matches: this.egressMatches() });
        if (this.s.MODE === 'live' && !this.egressMatches()) {
          this.bus.publish('alert', { severity: 'P0', title: 'Egress IP not registered', message: `Current egress ${ip} is not a registered static IP; live orders blocked.`, ts: Date.now() });
        }
      }
    } catch (e) {
      this.egressError = String((e as Error).message ?? e);
    } finally {
      this.egressCheckedAt = Date.now();
    }
  }

  egressMatches(): boolean {
    if (!this.egressIp) return false;
    return this.egressIp === this.s.STATIC_IP_PRIMARY || this.egressIp === this.s.STATIC_IP_SECONDARY;
  }

  status(): ComplianceStatus {
    const blockers: string[] = [];
    if (!this.s.UPSTOX_ALGO_NAME) blockers.push('X-Algo-Name not configured (UPSTOX_ALGO_NAME)');
    if (!this.s.STATIC_IP_PRIMARY) blockers.push('Primary static IP not configured');
    if (!this.egressMatches()) blockers.push(this.egressIp ? `Egress IP ${this.egressIp} is not registered` : 'Egress IP not verified');
    if (this.egressCheckedAt && Date.now() - this.egressCheckedAt > 10 * 60_000) blockers.push('Egress IP check older than 10 minutes');
    if (!this.tokenPresentFn()) blockers.push('No Upstox access token (daily login required)');
    if (!this.s.LIVE_TRADING_ENABLED) blockers.push('LIVE_TRADING_ENABLED is false');
    if (this.s.MODE !== 'live') blockers.push(`MODE is ${this.s.MODE}`);
    return {
      algoName: this.s.UPSTOX_ALGO_NAME,
      algoNameConfigured: !!this.s.UPSTOX_ALGO_NAME,
      staticIps: { primary: this.s.STATIC_IP_PRIMARY, secondary: this.s.STATIC_IP_SECONDARY },
      egressIp: this.egressIp,
      egressCheckedAt: this.egressCheckedAt,
      egressMatches: this.egressMatches(),
      egressError: this.egressError,
      tokenPresent: this.tokenPresentFn(),
      lastLogoutAt: this.lastLogoutAt,
      opsHardLimit: this.s.OPS_HARD_LIMIT,
      opsAlertAt: this.s.OPS_ALERT_AT,
      liveReady: blockers.length === 0,
      blockers,
    };
  }

  /** Throws unless live order routing is fully compliant. */
  assertLiveOrderAllowed(): void {
    const st = this.status();
    if (!st.liveReady) throw new Error(`live order blocked by compliance: ${st.blockers.join('; ')}`);
  }
}
