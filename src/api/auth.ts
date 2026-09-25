// Admin authentication: scrypt password hashes, random session tokens stored
// hashed in the DB, HttpOnly + SameSite=Strict cookies, login rate limiting.
// Mutating requests must also carry `X-Requested-With: tradeai` (CSRF defence in
// depth on top of SameSite).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/database.ts';
import { sha256 } from '../core/ids.ts';

const N = 16384;
const R = 8;
const P = 1;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export class AuthService {
  private db: Db;
  private user: string;
  private envHash?: string;
  private ttlMs: number;
  private attempts = new Map<string, { n: number; until: number }>();

  constructor(db: Db, user: string, envHash: string | undefined, ttlHours: number, dbPath: string) {
    this.db = db;
    this.user = user;
    this.envHash = envHash;
    this.ttlMs = ttlHours * 3600_000;
    if (!envHash && !this.storedHash()) {
      // First run: generate a strong password, store only its hash, and write it once
      // to a 0600 file next to the database for the operator to read and delete.
      const pw = randomBytes(12).toString('base64url');
      this.setPasswordHash(hashPassword(pw));
      const file = join(dirname(dbPath === ':memory:' ? 'data/x' : dbPath), 'INITIAL_ADMIN_PASSWORD.txt');
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `user: ${user}\npassword: ${pw}\nChange it after first login, then delete this file.\n`, { mode: 0o600 });
      } catch {
        /* ignore */
      }
      process.stdout.write(`\n  Initial admin credentials → user "${user}", password written to ${file}\n\n`);
    }
  }

  private storedHash(): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'admin_password_hash'")?.value;
  }

  private setPasswordHash(h: string): void {
    this.db.run("INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES ('admin_password_hash', ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", h, Date.now());
  }

  login(user: string, pw: string, ip: string): { token: string; expiresAt: number } | { error: string; retryAfterMs?: number } {
    const a = this.attempts.get(ip);
    if (a && a.until > Date.now()) return { error: 'too many attempts', retryAfterMs: a.until - Date.now() };
    const hash = this.envHash ?? this.storedHash();
    const ok = !!hash && user === this.user && verifyPassword(pw, hash);
    if (!ok) {
      const n = (a?.n ?? 0) + 1;
      this.attempts.set(ip, { n, until: n >= 5 ? Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (n - 5)) : 0 });
      return { error: 'invalid credentials' };
    }
    this.attempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.db.run('INSERT INTO admin_sessions (token_hash, user, created_at, expires_at, ip) VALUES (?,?,?,?,?)', sha256(token), user, Date.now(), expiresAt, ip);
    return { token, expiresAt };
  }

  session(token: string | undefined): { user: string } | undefined {
    if (!token) return undefined;
    const r = this.db.get<{ user: string; expires_at: number }>('SELECT user, expires_at FROM admin_sessions WHERE token_hash = ?', sha256(token));
    if (!r || r.expires_at < Date.now()) return undefined;
    return { user: r.user };
  }

  logout(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM admin_sessions WHERE token_hash = ?', sha256(token));
  }

  changePassword(current: string, next: string): string | undefined {
    if (this.envHash) return 'password is set via ADMIN_PASSWORD_HASH; change it in the environment';
    const h = this.storedHash();
    if (!h || !verifyPassword(current, h)) return 'current password is incorrect';
    if (next.length < 12) return 'new password must be at least 12 characters';
    this.setPasswordHash(hashPassword(next));
    this.db.run('DELETE FROM admin_sessions');
    return undefined;
  }
}
