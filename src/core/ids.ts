import { randomBytes, createHash } from 'node:crypto';

/** Time-sortable id: 12 hex chars of ms timestamp + 10 random hex chars. */
export function newId(prefix = ''): string {
  const ts = Date.now().toString(16).padStart(12, '0');
  return `${prefix}${ts}${randomBytes(5).toString('hex')}`;
}

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON for hashing (sorted keys). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}
