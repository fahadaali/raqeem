import { registerJob } from '../queue.js';
import { runImport } from './importer.js';
import { runRollover } from './rollover.js';
import { recomputeAll } from './kpi.js';
import { checkSLA, checkTaskDeadlines } from './sla.js';
import { runDailyBackup } from './backup.js';

/** تسجيل معالجات الطابور (مشتركة بين البيئتين) */
export function registerAllJobs() {
  registerJob('data.import', (app, payload) => runImport(app, payload));
  registerJob('term.rollover', (app, payload) => runRollover(app, payload));
}

/** الوظائف الدورية — تُستدعى من setInterval على Node ومن Cron Triggers على Cloudflare */
export const periodic = {
  async sla(app) { return { escalated: await checkSLA(app) }; },
  async kpi(app) { return { updated: await recomputeAll(app) }; },
  async deadlines(app) { return checkTaskDeadlines(app); },
  async backup(app) { return runDailyBackup(app); }
};
