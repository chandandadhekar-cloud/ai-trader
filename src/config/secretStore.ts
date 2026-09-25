// Encryption at rest for secrets saved from the admin console (API keys, tokens).
// AES-256-GCM with a random 32-byte master key kept OUTSIDE the database:
//  - TRADEAI_MASTER_KEY (base64) in the environment, if provided, else
//  - `<data dir>/.master.key`, generated on first use with mode 0600.
// Back the key file up separately from database backups: without it the stored
// secrets cannot be decrypted (they can simply be re-entered in the console).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class SecretBox {
  private key: Buffer;

  constructor(dbPath: string, envKey = process.env.TRADEAI_MASTER_KEY) {
    if (envKey) {
      this.key = Buffer.from(envKey, 'base64');
      if (this.key.length !== 32) throw new Error('TRADEAI_MASTER_KEY must be 32 bytes, base64-encoded');
      return;
    }
    const file = join(dbPath === ':memory:' ? 'data' : dirname(dbPath), '.master.key');
    if (existsSync(file)) {
      this.key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    } else {
      this.key = randomBytes(32);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, this.key.toString('base64') + '\n', { mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error(`invalid master key in ${file}`);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(box: string): string {
    const [v, iv, tag, ct] = box.split(':');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unrecognised secret format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
}
