import { nowUTC } from '../sql.js';

/**
 * التقييم الآلي (البند ٧): يحسب نسبة «المهام المنجزة» مقارنة بـ«إجمالي المهام
 * المسندة» ويحدّث مؤشر أداء الموظف آلياً.
 * المؤشر = ٥٠٪ إنجاز + ٣٠٪ حضور + ٢٠٪ تقييم − خصم للمهام المتأخرة (بحد أقصى ١٥).
 */
const UPSERT_USER = `INSERT INTO kpis(tenant_id,branch_id,term_id,user_id,committee_id,period,
    tasks_total,tasks_done,tasks_overdue,completion_rate,attendance_rate,eval_avg,score,computed_at)
  VALUES(?,?,?,?,NULL,'term',?,?,?,?,?,?,?,?)
  ON CONFLICT(tenant_id,user_id,committee_id,term_id,period) DO UPDATE SET
    tasks_total=excluded.tasks_total, tasks_done=excluded.tasks_done, tasks_overdue=excluded.tasks_overdue,
    completion_rate=excluded.completion_rate, attendance_rate=excluded.attendance_rate,
    eval_avg=excluded.eval_avg, score=excluded.score, computed_at=excluded.computed_at,
    branch_id=excluded.branch_id`;

const UPSERT_COMMITTEE = `INSERT INTO kpis(tenant_id,branch_id,term_id,user_id,committee_id,period,
    tasks_total,tasks_done,tasks_overdue,completion_rate,attendance_rate,eval_avg,score,computed_at)
  VALUES(?,?,?,NULL,?,'term',?,?,?,?,0,0,?,?)
  ON CONFLICT(tenant_id,user_id,committee_id,term_id,period) DO UPDATE SET
    tasks_total=excluded.tasks_total, tasks_done=excluded.tasks_done, tasks_overdue=excluded.tasks_overdue,
    completion_rate=excluded.completion_rate, score=excluded.score, computed_at=excluded.computed_at`;

export async function recomputeKPIs(app, tenantId) {
  const term = await app.db.get('SELECT * FROM terms WHERE tenant_id=? AND is_current=1', tenantId);
  if (!term) return 0;

  const users = await app.db.all(
    `SELECT u.id, u.primary_branch_id FROM users u WHERE u.tenant_id=? AND u.status='active'`, tenantId);
  const stamp = nowUTC();
  const stmts = [];

  for (const u of users) {
    const t = await app.db.get(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status<>'done' AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue,
        COALESCE(SUM(weight),0) AS w, COALESCE(SUM(CASE WHEN status='done' THEN weight ELSE 0 END),0) AS wdone
      FROM tasks WHERE tenant_id=? AND term_id=? AND assignee_id=?`, tenantId, term.id, u.id);

    const a = await app.db.get(`SELECT
        SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended,
        COUNT(*) AS total FROM attendance WHERE tenant_id=? AND term_id=? AND user_id=?`, tenantId, term.id, u.id);

    const e = await app.db.get(`SELECT AVG(score*100.0/NULLIF(max_score,0)) AS avg FROM form_submissions
      WHERE tenant_id=? AND subject_user_id=? AND score IS NOT NULL`, tenantId, u.id);

    const completion = t.w ? Number((t.wdone * 100 / t.w).toFixed(1))
      : (t.total ? Number((t.done * 100 / t.total).toFixed(1)) : 0);
    const attendance = a.total ? Number((a.attended * 100 / a.total).toFixed(1)) : 0;
    const evalAvg = e.avg ? Number(e.avg.toFixed(1)) : 0;
    const penalty = Math.min(15, (t.overdue || 0) * 3);
    const score = Number(Math.max(0, completion * 0.5 + attendance * 0.3 + evalAvg * 0.2 - penalty).toFixed(1));

    stmts.push([UPSERT_USER, [tenantId, u.primary_branch_id, term.id, u.id,
      t.total || 0, t.done || 0, t.overdue || 0, completion, attendance, evalAvg, score, stamp]]);
  }

  const committees = await app.db.all('SELECT id, branch_id FROM committees WHERE tenant_id=? AND term_id=?', tenantId, term.id);
  for (const c of committees) {
    const t = await app.db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status<>'done' AND due_date<date('now') THEN 1 ELSE 0 END) AS overdue
      FROM tasks WHERE tenant_id=? AND committee_id=?`, tenantId, c.id);
    const rate = t.total ? Number((t.done * 100 / t.total).toFixed(1)) : 0;
    stmts.push([UPSERT_COMMITTEE, [tenantId, c.branch_id, term.id, c.id,
      t.total || 0, t.done || 0, t.overdue || 0, rate, rate, stamp]]);
  }

  for (let i = 0; i < stmts.length; i += 50) await app.db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

export async function recomputeAll(app) {
  const tenants = await app.db.all(`SELECT id FROM tenants WHERE status='active'`);
  let total = 0;
  for (const t of tenants) total += await recomputeKPIs(app, t.id);
  return total;
}
