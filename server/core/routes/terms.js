import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created, accepted } from '../http.js';
import { badRequest, notFound, conflict, locked } from '../errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { findScoped, currentTerm } from '../scope.js';
import { enqueue } from '../queue.js';
import { broadcast } from '../notify.js';

const router = new Hono();

router.get('/', can('terms.view', 'dashboard.view'), h(async (req) =>
  req.app.db.all(`SELECT t.*,
      (SELECT COUNT(*) FROM tasks x WHERE x.tenant_id=t.tenant_id AND x.term_id=t.id) AS tasks_count,
      (SELECT COUNT(*) FROM finance_requests f WHERE f.tenant_id=t.tenant_id AND f.term_id=t.id) AS requests_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.tenant_id=t.tenant_id AND a.term_id=t.id) AS attendance_count,
      u.name AS closed_by_name
    FROM terms t LEFT JOIN users u ON u.id=t.closed_by
    WHERE t.tenant_id=? ORDER BY t.start_date DESC`, req.ctx.tenantId)));

router.get('/current', h(async (req) => (await currentTerm(req.app, req.ctx.tenantId)) || {}));

router.post('/', can('terms.manage'), h(async (req) => {
  const app = req.app;
  const { code, name, start_date, end_date, make_current } = req.body || {};
  if (!code || !name || !start_date || !end_date) throw badRequest('الرمز والاسم وتاريخا البداية والنهاية إلزامية');
  if (await app.db.get('SELECT 1 AS x FROM terms WHERE tenant_id=? AND code=?', req.ctx.tenantId, code))
    throw conflict('يوجد فصل بنفس الرمز');
  const stmts = [];
  if (make_current) stmts.push(['UPDATE terms SET is_current=0 WHERE tenant_id=?', [req.ctx.tenantId]]);
  stmts.push([`INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current) VALUES(?,?,?,?,?,'open',?)`,
    [req.ctx.tenantId, String(code).trim(), String(name).trim(), start_date, end_date, make_current ? 1 : 0]]);
  const res = await app.db.batch(stmts);
  const id = res[res.length - 1].lastId;
  await audit(req, { action: 'create', entity: 'term', entityId: id, summary: `إنشاء فصل دراسي جديد: ${name}` });
  return created(await app.db.get('SELECT * FROM terms WHERE id=?', id));
}));

router.patch('/:id', can('terms.manage'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'terms', req.params.id);
  if (!t) throw notFound('الفصل غير موجود');
  if (t.status !== 'open') throw locked();
  const p = req.body || {};
  const stmts = [];
  if (p.is_current) stmts.push(['UPDATE terms SET is_current=0 WHERE tenant_id=?', [req.ctx.tenantId]]);
  stmts.push(['UPDATE terms SET name=?,start_date=?,end_date=?,is_current=? WHERE id=? AND tenant_id=?',
    [p.name ?? t.name, p.start_date ?? t.start_date, p.end_date ?? t.end_date,
     p.is_current !== undefined ? (p.is_current ? 1 : 0) : t.is_current, t.id, req.ctx.tenantId]]);
  await app.db.batch(stmts);
  await audit(req, { action: 'update', entity: 'term', entityId: t.id, summary: `تعديل الفصل: ${t.name}` });
  return app.db.get('SELECT * FROM terms WHERE id=?', t.id);
}));

/* ─── معاينة معالج إغلاق الفصل (Rollover Wizard) — البند ٣ ─── */
router.get('/:id/rollover/preview', can('terms.close'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'terms', req.params.id);
  if (!t) throw notFound('الفصل غير موجود');

  const staff = await app.db.all(`SELECT DISTINCT u.id, u.name, r.name AS role_name, b.name AS branch_name,
      (SELECT COUNT(*) FROM tasks x WHERE x.tenant_id=u.tenant_id AND x.term_id=? AND x.assignee_id=u.id) AS tasks
    FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN branches b ON b.id=u.primary_branch_id
    WHERE u.tenant_id=? AND u.status='active' ORDER BY r.level, u.name`, t.id, req.ctx.tenantId);

  const openTasks = await app.db.all(`SELECT t.id, t.title, t.status, t.priority, t.due_date, t.progress,
      c.name AS committee_name, u.name AS assignee_name, b.name AS branch_name
    FROM tasks t LEFT JOIN committees c ON c.id=t.committee_id
    LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN branches b ON b.id=t.branch_id
    WHERE t.tenant_id=? AND t.term_id=? AND t.status NOT IN ('done') ORDER BY t.due_date`, req.ctx.tenantId, t.id);

  const committees = await app.db.all(`SELECT c.id, c.name, c.description,
      (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id=c.id) AS members
    FROM committees c WHERE c.tenant_id=? AND c.term_id=?`, req.ctx.tenantId, t.id);

  const custody = await app.db.all(`SELECT f.id, f.number, f.title, f.amount, u.name AS requester_name
    FROM finance_requests f LEFT JOIN users u ON u.id=f.requester_id
    WHERE f.tenant_id=? AND f.term_id=? AND f.type='custody' AND f.status<>'rejected'`, req.ctx.tenantId, t.id);

  const budgets = await app.db.all('SELECT id,name,category,amount,spent FROM budgets WHERE tenant_id=? AND term_id=?',
    req.ctx.tenantId, t.id);

  return {
    term: t, staff, open_tasks: openTasks, committees, custody, budgets,
    stats: {
      staff: staff.length, open_tasks: openTasks.length, committees: committees.length,
      custody_total: custody.reduce((s, c) => s + c.amount, 0),
      budgets_remaining: budgets.reduce((s, b) => s + (b.amount - b.spent), 0)
    }
  };
}));

/* ─── تنفيذ الإغلاق والترحيل الآلي ─── */
router.post('/:id/rollover', can('terms.close'), h(async (req) => {
  const app = req.app;
  const from = await findScoped(app, req.ctx, 'terms', req.params.id);
  if (!from) throw notFound('الفصل غير موجود');
  if (from.status !== 'open') throw locked('الفصل مغلق مسبقاً');

  const { new_term, staff_ids = [], task_ids = [], committee_ids = [],
    carry_custody = false, carry_budgets = false, close_source = true } = req.body || {};
  if (!new_term?.code || !new_term?.name || !new_term?.start_date || !new_term?.end_date)
    throw badRequest('بيانات الفصل الجديد غير مكتملة');
  if (await app.db.get('SELECT 1 AS x FROM terms WHERE tenant_id=? AND code=?', req.ctx.tenantId, new_term.code))
    throw conflict('يوجد فصل بنفس الرمز');

  const res = await app.db.batch([
    ['UPDATE terms SET is_current=0 WHERE tenant_id=?', [req.ctx.tenantId]],
    [`INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current) VALUES(?,?,?,?,?,'open',1)`,
      [req.ctx.tenantId, String(new_term.code).trim(), String(new_term.name).trim(), new_term.start_date, new_term.end_date]]
  ]);
  const toId = res[1].lastId;

  const options = { staff_ids, task_ids, committee_ids, carry_custody, carry_budgets, close_source };
  const roll = await app.db.run(
    `INSERT INTO term_rollovers(tenant_id,from_term_id,to_term_id,options,created_by) VALUES(?,?,?,?,?)`,
    req.ctx.tenantId, from.id, toId, JSON.stringify(options), req.ctx.userId);

  await enqueue(app, 'term.rollover',
    { rolloverId: roll.lastId, tenantId: req.ctx.tenantId, userId: req.ctx.userId },
    { tenantId: req.ctx.tenantId });

  await audit(req, { action: 'update', entity: 'term', entityId: from.id,
    summary: `${req.ctx.userName} بدأ إغلاق الفصل (${from.name}) وترحيله إلى (${new_term.name})`, after: options });

  return accepted({ ok: true, rollover_id: roll.lastId, new_term_id: toId,
    message: 'جارٍ تنفيذ الترحيل في الخلفية، ستصلك إشعارات عند الاكتمال.' });
}));

router.get('/rollovers/:id', can('terms.close'), h(async (req) => {
  const r = await findScoped(req.app, req.ctx, 'term_rollovers', req.params.id);
  if (!r) throw notFound('عملية الترحيل غير موجودة');
  return { ...r, options: j(r.options, {}), summary: j(r.summary, {}) };
}));

router.post('/:id/reopen', can('terms.manage'), h(async (req) => {
  const app = req.app;
  const t = await findScoped(app, req.ctx, 'terms', req.params.id);
  if (!t) throw notFound('الفصل غير موجود');
  await app.db.run(`UPDATE terms SET status='open', closed_at=NULL, closed_by=NULL WHERE id=? AND tenant_id=?`,
    t.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'term', entityId: t.id, summary: `إعادة فتح الفصل المؤرشف: ${t.name}` });
  await broadcast(app, req.ctx.tenantId, {
    type: 'term.reopened', category: 'system', title: 'إعادة فتح فصل دراسي',
    body: `تمت إعادة فتح الفصل "${t.name}" للتعديل.`, url: '/terms'
  });
  return { ok: true };
}));

export default router;
