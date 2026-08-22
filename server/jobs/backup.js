import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import db from '../db/index.js';
import config from '../config.js';

/** النسخ الاحتياطي اليومي الآلي (البند ١٠) — db.backup غير متزامن ويجب انتظاره */
export async function runBackup() {
  fs.mkdirSync(config.backup.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const raw = path.join(config.backup.dir, `noor-${stamp}.db`);
  await db.backup(raw);
  const gz = raw + '.gz';
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(raw)));
  fs.unlinkSync(raw);

  const files = fs.readdirSync(config.backup.dir)
    .filter(f => f.startsWith('noor-') && f.endsWith('.gz'))
    .sort().reverse();
  for (const old of files.slice(config.backup.keep)) {
    fs.unlinkSync(path.join(config.backup.dir, old));
  }
  return { file: path.basename(gz), size: fs.statSync(gz).size, kept: Math.min(files.length, config.backup.keep) };
}
