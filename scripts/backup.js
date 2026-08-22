import { runBackup } from '../server/jobs/backup.js';
const r = await runBackup();
console.log(`✔ تم إنشاء نسخة احتياطية: ${r.file} (${(r.size / 1024).toFixed(1)} كيلوبايت) — محفوظ ${r.kept} نسخة`);
