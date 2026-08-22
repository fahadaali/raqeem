import { registerJob } from '../queue.js';
import { runImport } from './importer.js';
import { runRollover } from './rollover.js';
import { recomputeAll } from './kpi.js';
import { checkSLA, checkTaskDeadlines } from './sla.js';
import { runDailyBackup } from './backup.js';
import { runSubscriptionCycle } from './subscriptions.js';
import { snapshotMetrics } from './metrics.js';
import { pruneJobRuns, runJob } from './runner.js';
import { pruneLoginAttempts } from '../security.js';

/** تسجيل معالجات الطابور (مشتركة بين البيئتين) */
export function registerAllJobs() {
  registerJob('data.import', (app, payload) => runImport(app, payload));
  registerJob('term.rollover', (app, payload) => runRollover(app, payload));
}

/** صيانة يومية خفيفة: لقطة المؤشرات وتقليم السجلات */
async function dailyMaintenance(app) {
  const metrics = await snapshotMetrics(app);
  const jobs = await pruneJobRuns(app, { keepDays: 30 });
  const logins = await pruneLoginAttempts(app, { keepDays: 90 });
  return { metrics: { date: metrics.date, mrr: metrics.mrr, tenants: metrics.tenants_total }, pruned: { jobs, logins } };
}

/**
 * الوظائف الدورية — تُستدعى من setInterval على Node ومن Cron Triggers على Cloudflare.
 * كل واحدة تمرّ عبر `runJob` فيُحفظ لها أثر تشغيل قابل للمراجعة من لوحة المالك.
 */
const RAW = {
  sla: async (app) => ({ escalated: await checkSLA(app) }),
  kpi: async (app) => ({ updated: await recomputeAll(app) }),
  deadlines: (app) => checkTaskDeadlines(app),
  backup: (app) => runDailyBackup(app),
  subscriptions: (app) => runSubscriptionCycle(app),
  metrics: (app) => dailyMaintenance(app)
};

export const JOB_KEYS = Object.keys(RAW);

export const periodic = Object.fromEntries(
  Object.entries(RAW).map(([name, fn]) => [name, (app, opts = {}) => runJob(app, name, fn, opts)]));

/** تشغيل مباشر بلا تسجيل — للاستخدام داخل وظائف أخرى */
export const periodicRaw = RAW;
