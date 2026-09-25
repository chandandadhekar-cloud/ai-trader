process.env.NODE_ENV = 'test';
import { Db } from '../src/db/database.ts';
import { EventBus } from '../src/core/events.ts';
import { AuditLog } from '../src/governance/auditLog.ts';

export function memDb(): { db: Db; bus: EventBus; audit: AuditLog } {
  const db = new Db(':memory:');
  const bus = new EventBus();
  const audit = new AuditLog(db);
  return { db, bus, audit };
}

export const flush = () => new Promise<void>((r) => setImmediate(r));

/** Seeded normal generator for statistical tests. */
export function gaussian(seed = 1): () => number {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
