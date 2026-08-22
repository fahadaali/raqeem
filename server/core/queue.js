import { nowUTC, j } from './sql.js';

/**
 * طوابير المعالجة الخلفية (البند ١٢) — تمنع تجميد الواجهة أثناء العمليات الثقيلة.
 * الطابور مخزَّن في قاعدة البيانات ليعمل على البيئتين:
 *   • Node    : عامل دوري داخل العملية
 *   • Workers : Cloudflare Queues إن رُبطت، وإلا waitUntil + مؤقّت Cron كشبكة أمان
 */
const handlers = new Map();
export const registerJob = (type, fn) => handlers.set(type, fn);
export const jobTypes = () => [...handlers.keys()];

export async function enqueue(app, type, payload = {}, { tenantId = null, runAt = null, maxAttempts = 3 } = {}) {
  const r = await app.db.run(
    `INSERT INTO job_queue(tenant_id,type,payload,run_at,max_attempts) VALUES(?,?,?,?,?)`,
    tenantId, type, JSON.stringify(payload), runAt || nowUTC(), maxAttempts);

  if (app.queueBinding) {
    await app.queueBinding.send({ jobId: r.lastId, type });
  } else if (app.waitUntil) {
    app.waitUntil(drain(app));
  } else if (app.scheduleDrain) {
    app.scheduleDrain();
  }
  return r.lastId;
}

/** ينفّذ الوظائف المعلّقة حتى نفادها أو بلوغ الحد */
export async function drain(app, { max = 25, jobId = null } = {}) {
  let done = 0;
  for (let i = 0; i < max; i++) {
    const job = jobId && i === 0
      ? await app.db.get(`SELECT * FROM job_queue WHERE id=? AND status='queued'`, jobId)
      : await app.db.get(`SELECT * FROM job_queue WHERE status='queued' AND run_at <= ? ORDER BY id LIMIT 1`, nowUTC());
    if (!job) break;

    const claimed = await app.db.run(
      `UPDATE job_queue SET status='running', started_at=?, attempts=attempts+1 WHERE id=? AND status='queued'`,
      nowUTC(), job.id);
    if (!claimed.changes) continue;   // التقطها عامل آخر

    const fn = handlers.get(job.type);
    if (!fn) {
      await app.db.run(`UPDATE job_queue SET status='failed', error=?, finished_at=? WHERE id=?`,
        `لا يوجد معالج للنوع ${job.type}`, nowUTC(), job.id);
      continue;
    }
    try {
      const result = await fn(app, j(job.payload, {}), job);
      await app.db.run(`UPDATE job_queue SET status='done', result=?, finished_at=? WHERE id=?`,
        JSON.stringify(result ?? null), nowUTC(), job.id);
      done++;
    } catch (e) {
      const failed = job.attempts + 1 >= job.max_attempts;
      await app.db.run(`UPDATE job_queue SET status=?, error=?, finished_at=?, run_at=? WHERE id=?`,
        failed ? 'failed' : 'queued', String(e.message).slice(0, 500),
        failed ? nowUTC() : null,
        failed ? job.run_at : new Date(Date.now() + 15000).toISOString(), job.id);
      console.error(`[queue] فشل تنفيذ ${job.type}#${job.id}:`, e.message);
    }
    if (jobId) break;
  }
  return done;
}

/** يعيد الوظائف العالقة في حالة running إلى الطابور (بعد انقطاع مفاجئ) */
export async function requeueStuck(app, olderThanMinutes = 10) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
  const r = await app.db.run(
    `UPDATE job_queue SET status='queued' WHERE status='running' AND started_at < ? AND attempts < max_attempts`, cutoff);
  return r.changes;
}
