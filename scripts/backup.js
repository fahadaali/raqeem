import { createNodeContainer } from '../server/node/container.js';
import { runBackup } from '../server/node/backup.js';
const app = createNodeContainer();
const r = await runBackup(app);
console.log(`✔ تم إنشاء نسخة احتياطية: ${r.file} (${(r.size / 1024).toFixed(1)} كيلوبايت) — محفوظ ${r.kept} نسخة`);
await app.db.close();
