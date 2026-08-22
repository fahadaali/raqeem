import db, { nowUTC } from '../db/index.js';

/**
 * التقييم الآلي (البند ٧): وظائف يومية تحسب نسبة "المهام المنجزة"
 * مقارنة بـ"إجمالي المهام المسندة" وتحدّث مؤشر أداء الموظف آلياً.
 */
export function recomputeKPIs(tenantId) {
  const term = db.prepare('SELECT * FROM terms WHERE tenant_id=? AND is_current=1').get(tenantId);
  if (!term) return 0;

  const users = db.prepare(`SELECT u.id, u.primary_branch_id FROM users u WHERE u.tenant_id=? AND u.status='active'`).all(tenantId);
  const upsert = db.prepare(`INSERT INTO kpis(tenant_id,branch_id,term_id,user_id,committee_id,period,
      tasks_total,tasks_done,tasks_overdue,completion_rate,attendance_rate,eval_avg,score,computed_at)
    VALUES(?,?,?,?,NULL,'term',?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,user_id,committee_id,term_id,period) DO UPDATE SET
      tasks_total=excluded.tasks_total, tasks_done=excluded.tasks_done, tasks_overdue=excluded.tasks_overdue,
      completion_rate=excluded.completion_rate, attendance_rate=excluded.attendance_rate,
      eval_avg=excluded.eval_avg, score=excluded.score, computed_at=excluded.computed_at,
      branch_id=excluded.branch_id`);

  let n = 0;
  const run = db.transaction(() => {
    for (const u of users) {
      const t = db.prepare(`SELECT COUNT(*) total,
          SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
          SUM(CASE WHEN status<>'done' AND due_date < date('now') THEN 1 ELSE 0 END) overdue,
          COALESCE(SUM(weight),0) w, COALESCE(SUM(CASE WHEN status='done' THEN weight ELSE 0 END),0) wdone
        FROM tasks WHERE tenant_id=? AND term_id=? AND assignee_id=?`).get(tenantId, term.id, u.id);

      const a = db.prepare(`SELECT
          SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) attended,
          COUNT(*) total FROM attendance
        WHERE tenant_id=? AND term_id=? AND user_id=?`).get(tenantId, term.id, u.id);

      const e = db.prepare(`SELECT AVG(score*100.0/NULLIF(max_score,0)) avg FROM form_submissions
        WHERE tenant_id=? AND subject_user_id=? AND score IS NOT NULL`).get(tenantId, u.id);

      const completion = t.w ? Number((t.wdone * 100 / t.w).toFixed(1))
        : (t.total ? Number((t.done * 100 / t.total).toFixed(1)) : 0);
      const attendance = a.total ? Number((a.attended * 100 / a.total).toFixed(1)) : 0;
      const evalAvg = e.avg ? Number(e.avg.toFixed(1)) : 0;

      // المؤشر العام: ٥٠٪ إنجاز + ٣٠٪ حضور + ٢٠٪ تقييم، مع خصم للمهام المتأخرة
      const penalty = Math.min(15, (t.overdue || 0) * 3);
      const score = Number(Math.max(0, completion * 0.5 + attendance * 0.3 + evalAvg * 0.2 - penalty).toFixed(1));

      upsert.run(tenantId, u.primary_branch_id, term.id, u.id, t.total || 0, t.done || 0, t.overdue || 0,
        completion, attendance, evalAvg, score, nowUTC());
      n++;
    }

    // مؤشرات اللجان
    const committees = db.prepare('SELECT id, branch_id FROM committees WHERE tenant_id=? AND term_id=?').all(tenantId, term.id);
    const upsertC = db.prepare(`INSERT INTO kpis(tenant_id,branch_id,term_id,user_id,committee_id,period,
        tasks_total,tasks_done,tasks_overdue,completion_rate,attendance_rate,eval_avg,score,computed_at)
      VALUES(?,?,?,NULL,?,'term',?,?,?,?,0,0,?,?)
      ON CONFLICT(tenant_id,user_id,committee_id,term_id,period) DO UPDATE SET
        tasks_total=excluded.tasks_total, tasks_done=excluded.tasks_done, tasks_overdue=excluded.tasks_overdue,
        completion_rate=excluded.completion_rate, score=excluded.score, computed_at=excluded.computed_at`);
    for (const c of committees) {
      const t = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
          SUM(CASE WHEN status<>'done' AND due_date<date('now') THEN 1 ELSE 0 END) overdue
        FROM tasks WHERE tenant_id=? AND committee_id=?`).get(tenantId, c.id);
      const rate = t.total ? Number((t.done * 100 / t.total).toFixed(1)) : 0;
      upsertC.run(tenantId, c.branch_id, term.id, c.id, t.total || 0, t.done || 0, t.overdue || 0, rate, rate, nowUTC());
      n++;
    }
  });
  run();
  return n;
}

export function recomputeAll() {
  const tenants = db.prepare('SELECT id FROM tenants WHERE status=\'active\'').all();
  let total = 0;
  for (const t of tenants) total += recomputeKPIs(t.id);
  return total;
}
