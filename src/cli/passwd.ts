// Prints an scrypt hash for ADMIN_PASSWORD_HASH. Usage: npm run admin:passwd -- '<password>'
import { hashPassword } from '../api/auth.ts';

const pw = process.argv[2];
if (!pw || pw.length < 12) {
  process.stderr.write('usage: npm run admin:passwd -- "<password of at least 12 characters>"\n');
  process.exit(1);
}
process.stdout.write(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}\n`);
