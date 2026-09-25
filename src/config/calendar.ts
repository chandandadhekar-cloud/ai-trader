// Indian exchange session calendar (plan §P1.8).
// Effective-dated so backtests replay the rules that applied on each date:
//  - Closing Auction Session (CAS) for F&O-eligible cash stocks, live 3 Aug 2026
//    (SEBI circular 16 Jan 2026): continuous trading for CAS stocks stops 15:15,
//    CAS 15:15–15:35, buffer to 15:50, post-close 15:50–16:00. Equity derivatives
//    trade until 15:40. Stop-loss orders on CAS stocks are auto-cancelled at 15:15.
//  - Revised pre-open from 7 Sep 2026: 09:00–09:05 limit+market entry,
//    09:05–09:10 limit-only with random close 09:08–09:10, 09:10–09:12 matching,
//    09:12–09:15 transition. Before that: 09:00–09:08 entry, 09:08–09:12 matching.
// Holidays and special sessions must be refreshed from the NSE circular each year.

import { istMinuteOfDay, istParts, istToEpoch } from '../core/clock.ts';

export const CAS_LIVE_DATE = '2026-08-03';
export const NEW_PREOPEN_DATE = '2026-09-07';

/** NSE equity / equity-derivatives trading holidays (NSE circular for CY2026). */
export const NSE_HOLIDAYS: Record<string, string> = {
  '2026-01-15': 'Municipal Corporation Election - Maharashtra',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali-Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
};

export interface SpecialSession {
  date: string;
  name: string;
  /** IST HH:MM; undefined until the exchange publishes timings. */
  start?: string;
  end?: string;
  /** Mock / DR sessions must never be traded live. */
  tradeable: boolean;
}

export const SPECIAL_SESSIONS: SpecialSession[] = [
  { date: '2026-11-08', name: 'Muhurat Trading (Diwali Laxmi Pujan) — timings TBA by NSE', tradeable: false },
];

export type SessionPhase =
  | 'CLOSED'
  | 'PRE_OPEN_ORDER_ENTRY'
  | 'PRE_OPEN_LIMIT_ONLY'
  | 'PRE_OPEN_MATCHING'
  | 'PRE_OPEN_BUFFER'
  | 'CONTINUOUS'
  | 'CAS_TRANSITION'
  | 'CAS_ORDER_ENTRY'
  | 'CAS_LIMIT_ONLY'
  | 'CAS_MATCHING'
  | 'CAS_BUFFER'
  | 'POST_CLOSE'
  | 'SPECIAL';

export interface SessionState {
  date: string;
  isTradingDay: boolean;
  holiday?: string;
  phase: SessionPhase;
  /** New entries are allowed only in continuous trading, never in auctions. */
  entriesAllowed: boolean;
  /** Stop/SL orders are not accepted during auctions and are cancelled at CAS start. */
  stopOrdersAllowed: boolean;
  minuteOfDay: number;
}

export type InstrumentClass = 'EQ_CAS' | 'EQ_NON_CAS' | 'FO' | 'INDEX';

const hm = (h: number, m: number) => h * 60 + m;

export function isWeekend(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

export function isTradingDay(date: string): boolean {
  return !isWeekend(date) && !NSE_HOLIDAYS[date];
}

export function casActive(date: string): boolean {
  return date >= CAS_LIVE_DATE;
}

/** Current NSE session phase for an instrument class at timestamp ts. */
export function sessionState(ts: number, cls: InstrumentClass = 'EQ_NON_CAS'): SessionState {
  const p = istParts(ts);
  const date = p.date;
  const m = p.minuteOfDay;
  const base = { date, minuteOfDay: m };
  if (!isTradingDay(date)) {
    const special = SPECIAL_SESSIONS.find((s) => s.date === date);
    if (special?.start && special.end) {
      const [sh, sm] = special.start.split(':').map(Number);
      const [eh, em] = special.end.split(':').map(Number);
      if (m >= hm(sh, sm) && m < hm(eh, em)) {
        return { ...base, isTradingDay: false, phase: 'SPECIAL', entriesAllowed: special.tradeable, stopOrdersAllowed: special.tradeable };
      }
    }
    return { ...base, isTradingDay: false, holiday: NSE_HOLIDAYS[date] ?? 'Weekend', phase: 'CLOSED', entriesAllowed: false, stopOrdersAllowed: false };
  }

  const closed = (): SessionState => ({ ...base, isTradingDay: true, phase: 'CLOSED', entriesAllowed: false, stopOrdersAllowed: false });
  const phase = (ph: SessionPhase, entries = false, stops = false): SessionState => ({ ...base, isTradingDay: true, phase: ph, entriesAllowed: entries, stopOrdersAllowed: stops });

  if (m < hm(9, 0)) return closed();
  if (cls !== 'FO' && cls !== 'INDEX' && m < hm(9, 15)) {
    if (date >= NEW_PREOPEN_DATE) {
      if (m < hm(9, 5)) return phase('PRE_OPEN_ORDER_ENTRY');
      if (m < hm(9, 10)) return phase('PRE_OPEN_LIMIT_ONLY');
      if (m < hm(9, 12)) return phase('PRE_OPEN_MATCHING');
      return phase('PRE_OPEN_BUFFER');
    }
    if (m < hm(9, 8)) return phase('PRE_OPEN_ORDER_ENTRY');
    if (m < hm(9, 12)) return phase('PRE_OPEN_MATCHING');
    return phase('PRE_OPEN_BUFFER');
  }
  if (m < hm(9, 15)) return closed();

  const cas = casActive(date);
  if (cls === 'FO') {
    const foClose = cas ? hm(15, 40) : hm(15, 30);
    return m < foClose ? phase('CONTINUOUS', true, true) : closed();
  }
  if (cls === 'INDEX') return m < hm(15, 30) ? phase('CONTINUOUS') : closed();
  if (cls === 'EQ_CAS' && cas) {
    if (m < hm(15, 15)) return phase('CONTINUOUS', true, true);
    if (m < hm(15, 20)) return phase('CAS_TRANSITION');
    if (m < hm(15, 25)) return phase('CAS_ORDER_ENTRY');
    if (m < hm(15, 30)) return phase('CAS_LIMIT_ONLY');
    if (m < hm(15, 35)) return phase('CAS_MATCHING');
    if (m < hm(15, 50)) return phase('CAS_BUFFER');
    if (m < hm(16, 0)) return phase('POST_CLOSE');
    return closed();
  }
  if (m < hm(15, 30)) return phase('CONTINUOUS', true, true);
  if (m >= hm(15, 50) && m < hm(16, 0)) return phase('POST_CLOSE');
  return closed();
}

/**
 * Latest minute-of-day for new intraday entries and the forced square-off time.
 * Defaults mirror common broker auto-square-off times post-CAS; keep a margin before them.
 */
export function intradayCutoffs(date: string, cls: InstrumentClass): { lastEntry: number; squareOff: number } {
  if (cls === 'FO') return casActive(date) ? { lastEntry: hm(15, 0), squareOff: hm(15, 20) } : { lastEntry: hm(15, 0), squareOff: hm(15, 15) };
  if (cls === 'EQ_CAS' && casActive(date)) return { lastEntry: hm(14, 45), squareOff: hm(14, 55) };
  return { lastEntry: hm(15, 0), squareOff: hm(15, 10) };
}

/** Previous and next trading days (used for expiry shifting and PIT universes). */
export function shiftTradingDay(date: string, delta: number): string {
  let d = new Date(`${date}T00:00:00Z`);
  let n = Math.abs(delta);
  const step = Math.sign(delta) || 1;
  while (n > 0) {
    d = new Date(d.getTime() + step * 86400000);
    if (isTradingDay(d.toISOString().slice(0, 10))) n--;
  }
  return d.toISOString().slice(0, 10);
}

/** Epoch of the regular 09:15 open on a date. */
export function openEpoch(date: string): number {
  return istToEpoch(date, 9, 15);
}

/** Minutes since 09:15 (negative before the open). Used by intraday profiles. */
export function minutesSinceOpen(ts: number): number {
  return istMinuteOfDay(ts) - hm(9, 15);
}

export const REGULAR_SESSION_MINUTES = 375; // 09:15–15:30
