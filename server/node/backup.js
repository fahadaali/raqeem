import fs from 'node:fs';
import path from 'node:path';
import { gzip } from '../core/zip.js';
import { ROOT } from './env.js';

/** النسخ الاحتياطي اليومي الآلي (البند ١٠) — للتشغيل الذاتي.
 *  على Cloudflare يتولى D1 النسخ الاحتياطي (Time Travel) تلقائياً. */
export async function runBackup(app) {
  const dir = path.resolve(ROOT, app.cfg.backup.dir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const raw = path.join(dir, `noor-${stamp}.db`);
  await app.db.backup(raw);
  const gz = raw + '.gz';
  fs.writeFileSync(gz, await gzip(new Uint8Array(fs.readFileSync(raw))));
  fs.unlinkSync(raw);

  const files = fs.readdirSync(dir).filter(f => f.startsWith('noor-') && f.endsWith('.gz')).sort().reverse();
  for (const old of files.slice(app.cfg.backup.keep)) fs.unlinkSync(path.join(dir, old));
  return { file: path.basename(gz), size: fs.statSync(gz).size, kept: Math.min(files.length, app.cfg.backup.keep) };
}
