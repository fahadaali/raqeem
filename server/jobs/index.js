import { registerJob, startWorker } from '../lib/queue.js';
import { runImport } from './importer.js';
import { runRollover } from './rollover.js';
import { recomputeAll } from './kpi.js';
import { checkSLA, checkTaskDeadlines } from './sla.js';
import { runBackup } from './backup.js';
import config from '../config.js';

/** جدولة الوظائف الدورية (Cron Jobs) — البنود ٣ و٧ و٨ و١٠ */
export function startJobs() {
  registerJob('data.import', runImport);
  registerJob('term.rollover', runRollover);
  startWorker(4000);

  const safe = (name, fn) => async () => {
    try { const r = await fn(); if (r) console.log(`[job:${name}]`, JSON.stringify(r)); }
    catch (e) { console.error(`[job:${name}] خطأ:`, e.message); }
  };

  const kpiJob = safe('kpi', async () => ({ updated: recomputeAll() }));
  const slaJob = safe('sla', async () => ({ escalated: await checkSLA() }));
  const dueJob = safe('deadlines', async () => await checkTaskDeadlines());
  const backupJob = safe('backup', async () => (config.backup.enabled ? runBackup() : null));

  // تشغيل أولي بعد ١٠ ثوانٍ من الإقلاع
  setTimeout(() => { kpiJob(); slaJob(); }, 10_000).unref?.();

  // كل ١٥ دقيقة: اتفاقيات مستوى الخدمة
  setInterval(slaJob, 15 * 60_000).unref?.();
  // كل ساعة: مؤشرات الأداء
  setInterval(kpiJob, 60 * 60_000).unref?.();

  // يومياً: تنبيهات الاستحقاق + النسخ الاحتياطي
  let lastDaily = '';
  setInterval(() => {
    const now = new Date(Date.now() + 180 * 60000); // بتوقيت الرياض
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 6 && lastDaily !== today + 'd') { lastDaily = today + 'd'; dueJob(); }
    if (now.getUTCHours() === config.backup.hour && lastDaily !== today + 'b') { lastDaily = today + 'b'; backupJob(); }
  }, 5 * 60_000).unref?.();

  console.log('✔ تم تشغيل مجدول الوظائف الخلفية (الترحيل، الاستيراد، المؤشرات، مستوى الخدمة، النسخ الاحتياطي)');
}
