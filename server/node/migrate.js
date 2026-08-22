import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeSchema } from '../core/upgrade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(__dirname, '../core/schema.sql');

export async function migrate(app) {
  await app.db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  const added = await upgradeSchema(app);
  if (added.length) console.log('▸ أُضيفت أعمدة مستجدّة:', added.join('، '));
  await app.db.run(`INSERT INTO schema_meta(key,value) VALUES('version','2')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  return true;
}
