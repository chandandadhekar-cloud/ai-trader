type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';

export interface LogRecord {
  ts: number;
  level: Level;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

const recent: LogRecord[] = [];
const MAX_RECENT = 1000;

export function setLogLevel(l: Level): void {
  minLevel = l;
}

export function recentLogs(limit = 200, level?: Level): LogRecord[] {
  const out = level ? recent.filter((r) => ORDER[r.level] >= ORDER[level]) : recent;
  return out.slice(-limit).reverse();
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const rec: LogRecord = { ts: Date.now(), level, module, msg, data };
    recent.push(rec);
    if (recent.length > MAX_RECENT) recent.shift();
    if (process.env.NODE_ENV === 'test' && level !== 'error') return;
    const line = JSON.stringify({ t: new Date(rec.ts).toISOString(), l: level, m: module, msg, ...data });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}
