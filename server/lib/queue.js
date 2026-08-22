import db, { nowUTC, j } from '../db/index.js';

/**
 * طوابير المعالجة الخلفية (البند ١٢) — تمنع تجميد الواجهة أثناء العمليات الثقيلة
 * (استيراد ملفات ضخمة، ترحيل فصل دراسي، احتساب الرواتب...).
 */
const handlers = new Map();
let timer = null;
let running = false;

export const registerJob = (type, fn) => handlers.set(type, fn);

export function enqueue(type, payload = {}, { tenantId = null, runAt = null, maxAttempts = 3 } = {}) {
  const r = db.prepare(`INSERT INTO job_queue(tenant_id,type,payload,run_at,max_attempts)
    VALUES(?,?,?,?,?)`).run(tenantId, type, JSON.stringify(payload), runAt || nowUTC(), maxAttempts);
  setTimeout(() => tick(), 10);
  return r.lastInsertRowid;
}

export async function tick() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.prepare(
        `SELECT * FROM job_queue WHERE status='queued' AND run_at <= ? ORDER BY id LIMIT 1`
      ).get(nowUTC());
      if (!job) break;

      db.prepare(`UPDATE job_queue SET status='running', started_at=?, attempts=attempts+1 WHERE id=?`)
        .run(nowUTC(), job.id);

      const fn = handlers.get(job.type);
      if (!fn) {
        db.prepare(`UPDATE job_queue SET status='failed', error=?, finished_at=? WHERE id=?`)
          .run(`لا يوجد معالج للنوع ${job.type}`, nowUTC(), job.id);
        continue;
      }
      try {
        const result = await fn(j(job.payload, {}), job);
        db.prepare(`UPDATE job_queue SET status='done', result=?, finished_at=? WHERE id=?`)
          .run(JSON.stringify(result ?? null), nowUTC(), job.id);
      } catch (e) {
        const failed = job.attempts + 1 >= job.max_attempts;
        db.prepare(`UPDATE job_queue SET status=?, error=?, finished_at=?, run_at=? WHERE id=?`)
          .run(failed ? 'failed' : 'queued', String(e.message).slice(0, 500),
            failed ? nowUTC() : null,
            failed ? job.run_at : new Date(Date.now() + 15000).toISOString(), job.id);
        console.error(`[queue] فشل تنفيذ ${job.type}#${job.id}:`, e.message);
      }
    }
  } finally { running = false; }
}

export function startWorker(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(() => { tick().catch(e => console.error('[queue]', e)); }, intervalMs);
  timer.unref?.();
  tick().catch(() => {});
}

export function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }
