import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  db.prepare(`INSERT INTO schema_meta(key,value) VALUES('version','1')
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log('✔ تم إنشاء/تحديث مخطط قاعدة البيانات بنجاح.');
}
