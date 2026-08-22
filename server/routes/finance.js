import express from 'express';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound, forbidden, locked, conflict } from '../lib/errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed, nextNumber } from '../lib/scope.js';
import { notifyUsers, notifyByPermission } from '../lib/notify.js';

const router = express.Router();

const DEFAULT_STEPS = [
  { name: 'اعتماد المشرف', role_key: 'supervisor', permission: 'finance.approve_supervisor' },
  { name: 'الاعتماد المالي', role_key: 'finance', permission: 'finance.approve_finance' }
];

/* ─────────────────────────── شجرة الاعتمادات (Workflow Builder) ─────────── */
router.get('/workflows', can('workflows.view', 'finance.view'), ah(async (req, res) => {
  const rows = db.prepare('SELECT * FROM workflows WHERE tenant_id=? ORDER BY doc_type, name').all(req.ctx.tenantId);
  res.json(rows.map(w => ({ ...w, steps: j(w.steps, []) })));
}));

router.post('/workflows', can('workflows.manage'), ah(async (req, res) => {
  const { name, doc_type, steps } = req.body || {};
  if (!name || !Array.isArray(steps) || !steps.length) throw badRequest('اسم المسار وخطواته إلزامية');
  const r = db.prepare('INSERT INTO workflows(tenant_id,name,doc_type,steps) VALUES(?,?,?,?)')
    .run(req.ctx.tenantId, name.trim(), doc_type || 'expense', JSON.stringify(steps));
  audit(req, { action: 'create', entity: 'workflow', entityId: r.lastInsertRowid, summary: `بناء مسار اعتماد: ${name} (${steps.length} خطوة)` });
  res.status(201).json({ id: r.lastInsertRowid });
}));

router.patch('/workflows/:id', can('workflows.manage'), ah(async (req, res) => {
  const w = findScoped(req.ctx, 'workflows', req.params.id);
  if (!w) throw notFound('المسار غير موجود');
  const p = req.body || {};
  db.prepare('UPDATE workflows SET name=?,doc_type=?,steps=?,is_active=? WHERE id=? AND tenant_id=?')
    .run(p.name ?? w.name, p.doc_type ?? w.doc_type, p.steps ? JSON.stringify(p.steps) : w.steps,
      p.is_active ?? w.is_active, w.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'workflow', entityId: w.id, summary: `تعديل مسار الاعتماد: ${w.name}`, before: j(w.steps, []), after: p.steps });
  res.json({ ok: true });
}));

router.delete('/workflows/:id', can('workflows.manage'), ah(async (req, res) => {
  const w = findScoped(req.ctx, 'workflows', req.params.id);
  if (!w) throw notFound('المسار غير موجود');
  db.prepare('UPDATE workflows SET is_active=0 WHERE id=? AND tenant_id=?').run(w.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'workflow', entityId: w.id, summary: `تعطيل مسار الاعتماد: ${w.name}` });
  res.json({ ok: true });
}));

/* ─────────────────────────── الميزانيات ─────────────────────────────────── */
router.get('/budgets', can('budgets.view', 'finance.view'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'b' });
  const rows = db.prepare(`SELECT b.*, br.name branch_name, t.name term_name,
      (b.amount - b.spent) remaining,
      CASE WHEN b.amount>0 THEN ROUND(b.spent*100.0/b.amount,1) ELSE 0 END usage_pct
    FROM budgets b LEFT JOIN branches br ON br.id=b.branch_id LEFT JOIN terms t ON t.id=b.term_id
    WHERE ${sc.where} ORDER BY b.name`).all(...sc.params);
  res.json(rows);
}));

router.post('/budgets', can('budgets.manage'), ah(async (req, res) => {
  const { name, category, amount, branch_id, term_id } = req.body || {};
  if (!name || amount === undefined) throw badRequest('اسم الميزانية ومبلغها إلزاميان');
  const term = term_id || currentTerm(req.ctx.tenantId)?.id || null;
  const r = db.prepare('INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount) VALUES(?,?,?,?,?,?)')
    .run(req.ctx.tenantId, branch_id ? assertBranch(req.ctx, branch_id) : null, term, name.trim(), category || 'عام', Number(amount));
  audit(req, { action: 'create', entity: 'budget', entityId: r.lastInsertRowid, summary: `إنشاء ميزانية: ${name} بمبلغ ${amount} ر.س` });
  res.status(201).json({ id: r.lastInsertRowid });
}));

router.patch('/budgets/:id', can('budgets.manage'), ah(async (req, res) => {
  const b = findScoped(req.ctx, 'budgets', req.params.id, { branchCheck: true });
  if (!b) throw notFound('الميزانية غير موجودة');
  const p = req.body || {};
  db.prepare('UPDATE budgets SET name=?,category=?,amount=? WHERE id=? AND tenant_id=?')
    .run(p.name ?? b.name, p.category ?? b.category, p.amount ?? b.amount, b.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'budget', entityId: b.id, summary: `تعديل الميزانية: ${b.name}`, before: b, after: p });
  res.json({ ok: true });
}));

/* ─────────────────────────── الطلبات المالية — محرك الحالة ──────────────── */
function stepsOf(tenantId, workflowId) {
  if (!workflowId) return DEFAULT_STEPS;
  const w = db.prepare('SELECT steps FROM workflows WHERE id=? AND tenant_id=?').get(workflowId, tenantId);
  const s = j(w?.steps, []);
  return s.length ? s : DEFAULT_STEPS;
}

function decorate(ctx, r) {
  const steps = stepsOf(ctx.tenantId, r.workflow_id);
  const approvals = db.prepare(`SELECT a.*, u.name approver_name FROM finance_approvals a
    LEFT JOIN users u ON u.id=a.approver_id WHERE a.request_id=? ORDER BY a.step_index, a.id`).all(r.id);
  const pendingStep = steps[r.current_step] || null;
  const canAct = !!pendingStep && ['pending', 'in_review'].includes(r.status) &&
    (ctx.perms.includes(pendingStep.permission) || ctx.roleKey === 'owner');
  return {
    ...r, steps, approvals,
    current_step_name: pendingStep?.name || (r.status === 'approved' ? 'مُعتمد نهائياً' : 'منتهٍ'),
    can_approve: canAct,
    timeline: steps.map((s, i) => {
      const done = approvals.find(a => a.step_index === i && a.action === 'approve');
      const rejected = approvals.find(a => a.step_index === i && a.action === 'reject');
      return {
        index: i, name: s.name, role_key: s.role_key,
        state: rejected ? 'rejected' : done ? 'approved' : (i === r.current_step && ['pending', 'in_review'].includes(r.status) ? 'current' : 'waiting'),
        by: done?.approver_name || rejected?.approver_name || null,
        at: done?.acted_at || rejected?.acted_at || null,
        note: done?.note || rejected?.note || null
      };
    })
  };
}

router.get('/requests', can('finance.view', 'finance.request'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'f' });
  let sql = `SELECT f.*, u.name requester_name, b.name branch_name, w.name workflow_name,
      bd.name budget_name, t.status term_status,
      (SELECT COUNT(*) FROM invoices i WHERE i.request_id=f.id) invoices_count
    FROM finance_requests f JOIN users u ON u.id=f.requester_id
    LEFT JOIN branches b ON b.id=f.branch_id LEFT JOIN workflows w ON w.id=f.workflow_id
    LEFT JOIN budgets bd ON bd.id=f.budget_id LEFT JOIN terms t ON t.id=f.term_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'finance.view')) { sql += ' AND f.requester_id=?'; params.push(req.ctx.userId); }
  const q = req.query;
  if (q.status) { sql += ` AND f.status IN (${String(q.status).split(',').map(() => '?').join(',')})`; params.push(...String(q.status).split(',')); }
  if (q.type) { sql += ' AND f.type=?'; params.push(q.type); }
  if (q.term_id) { sql += ' AND f.term_id=?'; params.push(Number(q.term_id)); }
  if (q.branch_id) { sql += ' AND f.branch_id=?'; params.push(Number(q.branch_id)); }
  if (q.mine === '1') { sql += ' AND f.requester_id=?'; params.push(req.ctx.userId); }
  if (q.q) { sql += ' AND (f.title LIKE ? OR f.number LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }
  sql += ' ORDER BY f.created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params).map(r => decorate(req.ctx, r)));
}));

router.get('/requests/:id', can('finance.view', 'finance.request'), ah(async (req, res) => {
  const base = findScoped(req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!base) throw notFound('الطلب غير موجود');
  if (!has(req.ctx, 'finance.view') && base.requester_id !== req.ctx.userId) throw forbidden();
  const r = db.prepare(`SELECT f.*, u.name requester_name, b.name branch_name, w.name workflow_name,
      bd.name budget_name, t.status term_status
    FROM finance_requests f JOIN users u ON u.id=f.requester_id
    LEFT JOIN branches b ON b.id=f.branch_id LEFT JOIN workflows w ON w.id=f.workflow_id
    LEFT JOIN budgets bd ON bd.id=f.budget_id LEFT JOIN terms t ON t.id=f.term_id
    WHERE f.id=? AND f.tenant_id=?`).get(base.id, req.ctx.tenantId);
  const invoices = db.prepare(`SELECT i.*, f.storage_key, f.original_name, f.mime
    FROM invoices i LEFT JOIN files f ON f.id=i.file_id WHERE i.request_id=?`).all(r.id);
  res.json({ ...decorate(req.ctx, r), invoices });
}));

router.post('/requests', can('finance.request'), ah(async (req, res) => {
  const p = req.body || {};
  if (!p.title || !p.amount) throw badRequest('عنوان الطلب والمبلغ إلزاميان');
  const term = currentTerm(req.ctx.tenantId);
  if (term && termIsClosed(req.ctx.tenantId, term.id)) throw locked();
  const bid = p.branch_id ? assertBranch(req.ctx, p.branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  let workflowId = p.workflow_id || null;
  if (!workflowId) {
    const w = db.prepare(`SELECT id FROM workflows WHERE tenant_id=? AND doc_type=? AND is_active=1 ORDER BY id LIMIT 1`)
      .get(req.ctx.tenantId, p.type || 'expense');
    workflowId = w?.id || null;
  }

  const number = nextNumber(req.ctx.tenantId, 'finance_requests', 'FR');
  const r = db.prepare(`INSERT INTO finance_requests(tenant_id,branch_id,term_id,number,type,title,description,amount,requester_id,workflow_id,budget_id,current_step,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'pending')`).run(req.ctx.tenantId, bid, term?.id || null, number,
    p.type || 'expense', p.title.trim(), p.description || null, Number(p.amount), req.ctx.userId,
    workflowId, p.budget_id || null);

  const steps = stepsOf(req.ctx.tenantId, workflowId);
  audit(req, { action: 'create', entity: 'finance_request', entityId: r.lastInsertRowid, branchId: bid,
    summary: `${req.ctx.userName} رفع طلباً مالياً (${number}) بمبلغ ${Number(p.amount).toLocaleString('ar-SA')} ر.س` });
  if (steps[0]) await notifyByPermission(req.ctx.tenantId, steps[0].permission, {
    type: 'finance.pending', category: 'finance', title: 'طلب مالي بانتظار اعتمادك',
    body: `${p.title} — ${Number(p.amount).toLocaleString('ar-SA')} ر.س`,
    url: `/finance?id=${r.lastInsertRowid}`, data: { id: r.lastInsertRowid }, urgency: 'high'
  }, { branchId: bid });

  res.status(201).json({ id: r.lastInsertRowid, number });
}));

/** الانتقال بين الحالات المتعاقبة — لا يمكن تجاوز خطوة (البند ٦) */
router.post('/requests/:id/decide', can('finance.approve_supervisor', 'finance.approve_finance', 'finance.manage'), ah(async (req, res) => {
  const r = findScoped(req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!r) throw notFound('الطلب غير موجود');
  if (termIsClosed(req.ctx.tenantId, r.term_id)) throw locked();
  if (!['pending', 'in_review'].includes(r.status)) throw conflict('الطلب أُغلق مسبقاً ولا يقبل إجراءً جديداً');

  const steps = stepsOf(req.ctx.tenantId, r.workflow_id);
  const step = steps[r.current_step];
  if (!step) throw conflict('لا توجد خطوة اعتماد قائمة');
  const allowed = req.ctx.perms.includes(step.permission) || req.ctx.roleKey === 'owner';
  if (!allowed) throw forbidden(`هذه الخطوة (${step.name}) من صلاحية دور آخر — لا يمكن تجاوز الترتيب`);

  const approve = req.body?.action === 'approve';
  const note = req.body?.note || null;

  db.transaction(() => {
    db.prepare(`INSERT INTO finance_approvals(tenant_id,request_id,step_index,step_name,role_key,approver_id,action,note,acted_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, r.id, r.current_step, step.name, step.role_key,
      req.ctx.userId, approve ? 'approve' : 'reject', note, nowUTC());

    if (!approve) {
      db.prepare("UPDATE finance_requests SET status='rejected', updated_at=? WHERE id=?").run(nowUTC(), r.id);
      return;
    }
    const next = r.current_step + 1;
    const done = next >= steps.length;
    db.prepare('UPDATE finance_requests SET current_step=?, status=?, updated_at=? WHERE id=?')
      .run(next, done ? 'approved' : 'in_review', nowUTC(), r.id);
    if (done && r.budget_id) db.prepare('UPDATE budgets SET spent=spent+? WHERE id=? AND tenant_id=?').run(r.amount, r.budget_id, req.ctx.tenantId);
  })();

  const after = db.prepare('SELECT * FROM finance_requests WHERE id=?').get(r.id);
  audit(req, {
    action: approve ? 'approve' : 'reject', entity: 'finance_request', entityId: r.id, branchId: r.branch_id,
    summary: `${req.ctx.userName} (${step.name}) ${approve ? 'اعتمد' : 'رفض'} الطلب ${r.number} بمبلغ ${r.amount.toLocaleString('ar-SA')} ر.س`,
    before: { status: r.status, step: r.current_step }, after: { status: after.status, step: after.current_step }
  });

  await notifyUsers(req.ctx.tenantId, [r.requester_id], {
    type: approve ? 'finance.approved' : 'finance.rejected', category: 'finance',
    title: approve ? (after.status === 'approved' ? 'اعتُمد طلبك نهائياً' : `تم اعتماد الطلب في مرحلة ${step.name}`) : 'تم رفض طلبك المالي',
    body: `${r.title} — ${r.number}${note ? ' · ' + note : ''}`,
    url: `/finance?id=${r.id}`, data: { id: r.id }, urgency: 'high'
  });

  const nextStep = steps[after.current_step];
  if (approve && nextStep) await notifyByPermission(req.ctx.tenantId, nextStep.permission, {
    type: 'finance.pending', category: 'finance', title: 'طلب مالي بانتظار اعتمادك',
    body: `${r.title} — ${r.amount.toLocaleString('ar-SA')} ر.س`,
    url: `/finance?id=${r.id}`, data: { id: r.id }, urgency: 'high'
  }, { branchId: r.branch_id });

  res.json({ ok: true, status: after.status, current_step: after.current_step });
}));

router.patch('/requests/:id', can('finance.request', 'finance.manage'), ah(async (req, res) => {
  const r = findScoped(req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!r) throw notFound('الطلب غير موجود');
  if (termIsClosed(req.ctx.tenantId, r.term_id)) throw locked();
  if (r.requester_id !== req.ctx.userId && !has(req.ctx, 'finance.manage')) throw forbidden();
  if (r.current_step > 0) throw conflict('لا يمكن تعديل طلب بدأت دورة اعتماده');
  const p = req.body || {};
  db.prepare('UPDATE finance_requests SET title=?,description=?,amount=?,type=?,budget_id=?,updated_at=? WHERE id=? AND tenant_id=?')
    .run(p.title ?? r.title, p.description ?? r.description, p.amount ?? r.amount,
      p.type ?? r.type, p.budget_id ?? r.budget_id, nowUTC(), r.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'finance_request', entityId: r.id, summary: `تعديل الطلب ${r.number}`, before: r, after: p });
  res.json({ ok: true });
}));

/* ─────────────────────────── الفواتير ───────────────────────────────────── */
router.get('/invoices', can('invoices.view', 'finance.view'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'i' });
  let sql = `SELECT i.*, b.name branch_name, f.number request_number, f.title request_title,
      fl.storage_key, fl.original_name, fl.mime, u.name created_by_name
    FROM invoices i LEFT JOIN branches b ON b.id=i.branch_id
    LEFT JOIN finance_requests f ON f.id=i.request_id
    LEFT JOIN files fl ON fl.id=i.file_id LEFT JOIN users u ON u.id=i.created_by
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (req.query.request_id) { sql += ' AND i.request_id=?'; params.push(Number(req.query.request_id)); }
  if (req.query.from) { sql += ' AND i.date>=?'; params.push(req.query.from); }
  if (req.query.to) { sql += ' AND i.date<=?'; params.push(req.query.to); }
  sql += ' ORDER BY i.date DESC, i.id DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
}));

router.post('/invoices', can('invoices.manage'), ah(async (req, res) => {
  const p = req.body || {};
  if (!p.total) throw badRequest('إجمالي الفاتورة إلزامي');
  const term = currentTerm(req.ctx.tenantId);
  const vatRate = (req.ctx.tenantSettings?.vat_rate ?? 15) / 100;
  const total = Number(p.total);
  const amount = p.amount !== undefined ? Number(p.amount) : Number((total / (1 + vatRate)).toFixed(2));
  const vat = p.vat !== undefined ? Number(p.vat) : Number((total - amount).toFixed(2));
  const bid = p.branch_id ? assertBranch(req.ctx, p.branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  const r = db.prepare(`INSERT INTO invoices(tenant_id,branch_id,term_id,request_id,number,vendor,amount,vat,total,date,file_id,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, bid, term?.id || null, p.request_id || null,
    p.number || nextNumber(req.ctx.tenantId, 'invoices', 'INV'), p.vendor || null, amount, vat, total,
    p.date || new Date().toISOString().slice(0, 10), p.file_id || null, req.ctx.userId);
  audit(req, { action: 'create', entity: 'invoice', entityId: r.lastInsertRowid, branchId: bid,
    summary: `تسجيل فاتورة بمبلغ ${total.toLocaleString('ar-SA')} ر.س من ${p.vendor || 'مورد'}` });
  res.status(201).json({ id: r.lastInsertRowid });
}));

router.delete('/invoices/:id', can('invoices.manage'), ah(async (req, res) => {
  const i = findScoped(req.ctx, 'invoices', req.params.id, { branchCheck: true });
  if (!i) throw notFound('الفاتورة غير موجودة');
  if (termIsClosed(req.ctx.tenantId, i.term_id)) throw locked();
  db.prepare('DELETE FROM invoices WHERE id=? AND tenant_id=?').run(i.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'invoice', entityId: i.id, summary: `حذف فاتورة ${i.number}`, before: i });
  res.json({ ok: true });
}));

export default router;
