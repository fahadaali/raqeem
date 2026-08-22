import express from 'express';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound, conflict, locked } from '../lib/errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { findScoped, currentTerm } from '../lib/scope.js';
import { enqueue } from '../lib/queue.js';
import { broadcast } from '../lib/notify.js';

const router = express.Router();

router.get('/', can('terms.view', 'dashboard.view'), ah(async (req, res) => {
  const rows = db.prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM tasks x WHERE x.tenant_id=t.tenant_id AND x.term_id=t.id) tasks_count,
      (SELECT COUNT(*) FROM finance_requests f WHERE f.tenant_id=t.tenant_id AND f.term_id=t.id) requests_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.tenant_id=t.tenant_id AND a.term_id=t.id) attendance_count,
      u.name closed_by_name
    FROM terms t LEFT JOIN users u ON u.id=t.closed_by
    WHERE t.tenant_id=? ORDER BY t.start_date DESC`).all(req.ctx.tenantId);
  res.json(rows);
}));

router.get('/current', ah(async (req, res) => res.json(currentTerm(req.ctx.tenantId))));

router.post('/', can('terms.manage'), ah(async (req, res) => {
  const { code, name, start_date, end_date, make_current } = req.body || {};
  if (!code || !name || !start_date || !end_date) throw badRequest('الرمز والاسم وتاريخا البداية والنهاية إلزامية');
  if (db.prepare('SELECT 1 FROM terms WHERE tenant_id=? AND code=?').get(req.ctx.tenantId, code)) throw conflict('يوجد فصل بنفس الرمز');
  const id = db.transaction(() => {
    if (make_current) db.prepare('UPDATE terms SET is_current=0 WHERE tenant_id=?').run(req.ctx.tenantId);
    const r = db.prepare(`INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current)
      VALUES(?,?,?,?,?,'open',?)`).run(req.ctx.tenantId, code.trim(), name.trim(), start_date, end_date, make_current ? 1 : 0);
    return r.lastInsertRowid;
  })();
  audit(req, { action: 'create', entity: 'term', entityId: id, summary: `إنشاء فصل دراسي جديد: ${name}` });
  res.status(201).json(db.prepare('SELECT * FROM terms WHERE id=?').get(id));
}));

router.patch('/:id', can('terms.manage'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'terms', req.params.id);
  if (!t) throw notFound('الفصل غير موجود');
  if (t.status !== 'open') throw locked();
  const p = req.body || {};
  db.transaction(() => {
    if (p.is_current) db.prepare('UPDATE terms SET is_current=0 WHERE tenant_id=?').run(req.ctx.tenantId);
    db.prepare('UPDATE terms SET name=?,start_date=?,end_date=?,is_current=? WHERE id=? AND tenant_id=?')
      .run(p.name ?? t.name, p.start_date ?? t.start_date, p.end_date ?? t.end_date,
        p.is_current !== undefined ? (p.is_current ? 1 : 0) : t.is_current, t.id, req.ctx.tenantId);
  })();
  audit(req, { action: 'update', entity: 'term', entityId: t.id, summary: `تعديل الفصل: ${t.name}` });
  res.json(db.prepare('SELECT * FROM terms WHERE id=?').get(t.id));
}));

/* ── معاينة معالج إغلاق الفصل (Rollover Wizard) — البند ٣ ─────────────────── */
router.get('/:id/rollover/preview', can('terms.close'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'terms', req.params.id);
  if (!t) throw notFound('الفصل غير موجود');

  const staff = db.prepare(`SELECT DISTINCT u.id, u.name, r.name role_name, b.name branch_name,
      (SELECT COUNT(*) FROM tasks x WHERE x.tenant_id=u.tenant_id AND x.term_id=? AND x.assignee_id=u.id) tasks
    FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN branches b ON b.id=u.primary_branch_id
    WHERE u.tenant_id=? AND u.status='active' ORDER BY r.level, u.name`).all(t.id, req.ctx.tenantId);

  const openTasks = db.prepare(`SELECT t.id, t.title, t.status, t.priority, t.due_date, t.progress,
      c.name committee_name, u.name assignee_name, b.name branch_name
    FROM tasks t LEFT JOIN committees c ON c.id=t.committee_id
    LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN branches b ON b.id=t.branch_id
    WHERE t.tenant_id=? AND t.term_id=? AND t.status NOT IN ('done')
    ORDER BY t.due_date`).all(req.ctx.tenantId, t.id);

  const committees = db.prepare(`SELECT c.id, c.name, c.description,
      (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id=c.id) members
    FROM committees c WHERE c.tenant_id=? AND c.term_id=?`).all(req.ctx.tenantId, t.id);

  const custody = db.prepare(`SELECT f.id, f.number, f.title, f.amount, u.name requester_name
    FROM finance_requests f LEFT JOIN users u ON u.id=f.requester_id
    WHERE f.tenant_id=? AND f.term_id=? AND f.type='custody' AND f.status<>'rejected'`).all(req.ctx.tenantId, t.id);

  const budgets = db.prepare(`SELECT id,name,category,amount,spent FROM budgets WHERE tenant_id=? AND term_id=?`)
    .all(req.ctx.tenantId, t.id);

  res.json({
    term: t,
    staff, open_tasks: openTasks, committees, custody, budgets,
    stats: {
      staff: staff.length, open_tasks: openTasks.length, committees: committees.length,
      custody_total: custody.reduce((s, c) => s + c.amount, 0),
      budgets_remaining: budgets.reduce((s, b) => s + (b.amount - b.spent), 0)
    }
  });
}));

/* ── تنفيذ الإغلاق والترحيل الآلي (سكربتات خلفية) ─────────────────────────── */
router.post('/:id/rollover', can('terms.close'), ah(async (req, res) => {
  const from = findScoped(req.ctx, 'terms', req.params.id);
  if (!from) throw notFound('الفصل غير موجود');
  if (from.status !== 'open') throw locked('الفصل مغلق مسبقاً');

  const {
    new_term, staff_ids = [], task_ids = [], committee_ids = [],
    carry_custody = false, carry_budgets = false, close_source = true
  } = req.body || {};
  if (!new_term?.code || !new_term?.name || !new_term?.start_date || !new_term?.end_date)
    throw badRequest('بيانات الفصل الجديد غير مكتملة');
  if (db.prepare('SELECT 1 FROM terms WHERE tenant_id=? AND code=?').get(req.ctx.tenantId, new_term.code))
    throw conflict('يوجد فصل بنفس الرمز');

  const toId = db.transaction(() => {
    db.prepare('UPDATE terms SET is_current=0 WHERE tenant_id=?').run(req.ctx.tenantId);
    const r = db.prepare(`INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current)
      VALUES(?,?,?,?,?,'open',1)`).run(req.ctx.tenantId, new_term.code.trim(), new_term.name.trim(),
      new_term.start_date, new_term.end_date);
    return r.lastInsertRowid;
  })();

  const options = { staff_ids, task_ids, committee_ids, carry_custody, carry_budgets, close_source };
  const rollId = db.prepare(`INSERT INTO term_rollovers(tenant_id,from_term_id,to_term_id,options,created_by)
    VALUES(?,?,?,?,?)`).run(req.ctx.tenantId, from.id, toId, JSON.stringify(options), req.ctx.userId).lastInsertRowid;

  enqueue('term.rollover', { rolloverId: rollId, tenantId: req.ctx.tenantId, userId: req.ctx.userId },
    { tenantId: req.ctx.tenantId });

  audit(req, {
    action: 'update', entity: 'term', entityId: from.id,
    summary: `${req.ctx.userName} بدأ إغلاق الفصل (${from.name}) وترحيله إلى (${new_term.name})`,
    after: options
  });

  res.status(202).json({
    ok: true, rollover_id: rollId, new_term_id: toId,
    message: 'جارٍ تنفيذ الترحيل في الخلفية، ستصلك إشعارات عند الاكتمال.'
  });
}));

router.get('/rollovers/:id', can('terms.close'), ah(async (req, res) => {
  const r = findScoped(req.ctx, 'term_rollovers', req.params.id);
  if (!r) throw notFound('عملية الترحيل غير موجودة');
  res.json({ ...r, options: j(r.options, {}), summary: j(r.summary, {}) });
}));

/* ── إعادة فتح فصل (لمدير الجهة فقط عبر صلاحية terms.manage) ─────────────── */
router.post('/:id/reopen', can('terms.manage'), ah(async (req, res) => {
  const t = findScoped(req.ctx, 'terms', req.params.id);
  if (!t) throw notFound('الفصل غير موجود');
  db.prepare("UPDATE terms SET status='open', closed_at=NULL, closed_by=NULL WHERE id=? AND tenant_id=?").run(t.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'term', entityId: t.id, summary: `إعادة فتح الفصل المؤرشف: ${t.name}` });
  await broadcast(req.ctx.tenantId, {
    type: 'term.reopened', category: 'system', title: 'إعادة فتح فصل دراسي',
    body: `تمت إعادة فتح الفصل "${t.name}" للتعديل.`, url: '/terms'
  });
  res.json({ ok: true });
}));

export default router;
