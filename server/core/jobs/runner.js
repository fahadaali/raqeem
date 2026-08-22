import { nowUTC, j } from './../sql.js';

/**
 * مُشغِّل الوظائف الدورية مع سجلّ تشغيل (المستوى ١).
 *
 * كانت الوظائف تعمل بلا أثر: لو فشلت دورة الفوترة ليلة أمس لن يعرف أحد.
 * كل تشغيل الآن يُفتح له صفٌّ عند البدء ويُغلق بالنتيجة أو الخطأ والمدة،
 * فتصير للوحة المالك إجابة عن سؤال «هل النظام يعمل؟».
 */

const MAX_RESULT = 4000;
const trim = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s && s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '…' : s;
};

/**
 * ينفّذ وظيفة ويسجّل تشغيلها.
 * لا يبتلع الخطأ: يسجّله ثم يعيد رميه ليتصرف المنادي.
 */
export async function runJob(app, name, fn, { trigger = 'cron', actorId = null, actorName = null } = {}) {
  const started = Date.now();
  let runId = null;
  try {
    const r = await app.db.run(
      `INSERT INTO job_runs(job,status,trigger,actor_id,actor_name,started_at) VALUES(?,'running',?,?,?,?)`,
      name, trigger, actorId, actorName, nowUTC());
    runId = r.lastId;
  } catch { /* السجل ثانوي — لا يمنع تنفيذ الوظيفة */ }

  try {
    const result = await fn(app);
    if (runId) {
      await app.db.run(
        `UPDATE job_runs SET status='success', finished_at=?, duration_ms=?, result=? WHERE id=?`,
        nowUTC(), Date.now() - started, trim(result), runId).catch(() => {});
    }
    return result;
  } catch (e) {
    if (runId) {
      await app.db.run(
        `UPDATE job_runs SET status='failed', finished_at=?, duration_ms=?, error=? WHERE id=?`,
        nowUTC(), Date.now() - started, String(e?.message || e).slice(0, 1000), runId).catch(() => {});
    }
    throw e;
  }
}

/** آخر تشغيل لكل وظيفة + إحصاء الإخفاقات الحديثة */
export async function jobsHealth(app, { since = 24 } = {}) {
  const from = new Date(Date.now() - since * 3600_000).toISOString();
  const last = await app.db.all(
    `SELECT r.* FROM job_runs r
     JOIN (SELECT job, MAX(id) AS mx FROM job_runs GROUP BY job) m ON m.mx = r.id
     ORDER BY r.job`);
  const failures = await app.db.all(
    `SELECT job, COUNT(*) AS c FROM job_runs WHERE status='failed' AND started_at >= ? GROUP BY job`, from);
  const failMap = Object.fromEntries(failures.map(f => [f.job, f.c]));

  return last.map(r => ({
    job: r.job,
    status: r.status,
    trigger: r.trigger,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: r.duration_ms,
    result: j(r.result, r.result),
    error: r.error,
    failures_24h: failMap[r.job] || 0
  }));
}

/** آخر عمليات التشغيل بترتيب زمني عكسي */
export async function jobRuns(app, { job = null, status = null, limit = 100 } = {}) {
  let where = '1=1';
  const params = [];
  if (job) { where += ' AND job=?'; params.push(job); }
  if (status) { where += ' AND status=?'; params.push(status); }
  const rows = await app.db.all(
    `SELECT * FROM job_runs WHERE ${where} ORDER BY id DESC LIMIT ?`, ...params, Math.min(500, limit));
  return rows.map(r => ({ ...r, result: j(r.result, r.result) }));
}

/** تنظيف السجل القديم — يُستدعى ضمن الصيانة اليومية */
export async function pruneJobRuns(app, { keepDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  const r = await app.db.run('DELETE FROM job_runs WHERE started_at < ?', cutoff);
  return { removed: r.changes };
}
