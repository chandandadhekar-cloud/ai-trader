// Online SQLite backup (consistent snapshot while the app runs). Schedule hourly
// and ship the file to object storage (plan §P2.17), e.g. via cron:
//   0 * * * *  cd /opt/tradeai && npm run backup -- /var/backups/tradeai && rclone copy /var/backups/tradeai remote:tradeai
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from '../config/settings.ts';

const s = loadSettings();
const dir = process.argv[2] ?? 'data/backups';
mkdirSync(dir, { recursive: true });
const out = join(dir, `tradeai-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(s.DB_PATH);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
process.stdout.write(`backup written: ${out}\n`);
