import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from './env.js';
import { buildConfig } from '../core/config.js';

/** يحذف قاعدة البيانات ثم يعيد بناءها — الحذف قبل فتح أي اتصال */
const cfg = buildConfig(loadEnv());
const file = path.resolve(ROOT, cfg.dbFile);
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
}
console.log('✔ تم حذف قاعدة البيانات السابقة.');

const { createNodeContainer } = await import('./container.js');
const { migrate } = await import('./migrate.js');
const { seed } = await import('../core/seed.js');
const app = createNodeContainer();
await migrate(app);
const id = await seed(app);
console.log('✔ أُعيد بناء قاعدة البيانات وتعبئتها للمستأجر رقم', id);
await app.db.close();
