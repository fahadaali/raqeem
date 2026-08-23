import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, forbidden, locked, conflict } from '../errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed, nextNumber } from '../scope.js';
import { notifyUsers, notifyByPermission } from '../notify.js';

const router = new Hono();

const DEFAULT_STEPS = [
  { name: 'اعتماد المشرف', role_key: 'supervisor', permission: 'finance.approve_supervisor' },
  { name: 'الاعتماد المالي', role_key: 'finance', permission: 'finance.approve_finance' }
];

/* ─────────────── شجرة الاعتمادات (Workflow Builder) ─────────────── */
router.get('/workflows', can('workflows.view', 'finance.view'), h(async (req) =>
  (await req.app.db.all('SELECT * FROM workflows WHERE tenant_id=? ORDER BY doc_type, name', req.ctx.tenantId))
    .map(w => ({ ...w, steps: j(w.steps, []) }))));

router.post('/workflows', can('workflows.manage'), h(async (req) => {
  const { name, doc_type, steps } = req.body || {};
  if (!name || !Array.isArray(steps) || !steps.length) throw badRequest('اسم المسار وخطواته إلزامية');
  const r = await req.app.db.run('INSERT INTO workflows(tenant_id,name,doc_type,steps) VALUES(?,?,?,?)',
    req.ctx.tenantId, String(name).trim(), doc_type || 'expense', JSON.stringify(steps));
  await audit(req, { action: 'create', entity: 'workflow', entityId: r.lastId,
    summary: `بناء مسار اعتماد: ${name} (${steps.length} خطوة)` });
  return created({ id: r.lastId });
}));

router.patch('/workflows/:id', can('workflows.manage'), h(async (req) => {
  const w = await findScoped(req.app, req.ctx, 'workflows', req.params.id);
  if (!w) throw notFound('المسار غير موجود');
  const p = req.body || {};
  await req.app.db.run('UPDATE workflows SET name=?,doc_type=?,steps=?,is_active=? WHERE id=? AND tenant_id=?',
    p.name ?? w.name, p.doc_type ?? w.doc_type, p.steps ? JSON.stringify(p.steps) : w.steps,
    p.is_active ?? w.is_active, w.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'workflow', entityId: w.id,
    summary: `تعديل مسار الاعتماد: ${w.name}`, before: j(w.steps, []), after: p.steps });
  return { ok: true };
}));

router.delete('/workflows/:id', can('workflows.manage'), h(async (req) => {
  const w = await findScoped(req.app, req.ctx, 'workflows', req.params.id);
  if (!w) throw notFound('المسار غير موجود');
  await req.app.db.run('UPDATE workflows SET is_active=0 WHERE id=? AND tenant_id=?', w.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'workflow', entityId: w.id, summary: `تعطيل مسار الاعتماد: ${w.name}` });
  return { ok: true };
}));

/* ─────────────── الميزانيات ─────────────── */
router.get('/budgets', can('budgets.view', 'finance.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'b' });
  return req.app.db.all(`SELECT b.*, br.name AS branch_name, t.name AS term_name,
      (b.amount - b.spent) AS remaining,
      CASE WHEN b.amount>0 THEN ROUND(b.spent*100.0/b.amount,1) ELSE 0 END AS usage_pct
    FROM budgets b LEFT JOIN branches br ON br.id=b.branch_id LEFT JOIN terms t ON t.id=b.term_id
    WHERE ${sc.where} ORDER BY b.name`, ...sc.params);
}));

router.post('/budgets', can('budgets.manage'), h(async (req) => {
  const app = req.app;
  const { name, category, amount, branch_id, term_id } = req.body || {};
  if (!name || amount === undefined) throw badRequest('اسم الميزانية ومبلغها إلزاميان');
  const term = term_id || (await currentTerm(app, req.ctx.tenantId))?.id || null;
  const r = await app.db.run('INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount) VALUES(?,?,?,?,?,?)',
    req.ctx.tenantId, branch_id ? await assertBranch(app, req.ctx, branch_id) : null, term,
    String(name).trim(), category || 'عام', Number(amount));
  await audit(req, { action: 'create', entity: 'budget', entityId: r.lastId,
    summary: `إنشاء ميزانية: ${name} بمبلغ ${amount} ر.س` });
  return created({ id: r.lastId });
}));

router.patch('/budgets/:id', can('budgets.manage'), h(async (req) => {
  const b = await findScoped(req.app, req.ctx, 'budgets', req.params.id, { branchCheck: true });
  if (!b) throw notFound('الميزانية غير موجودة');
  const p = req.body || {};
  await req.app.db.run('UPDATE budgets SET name=?,category=?,amount=? WHERE id=? AND tenant_id=?',
    p.name ?? b.name, p.category ?? b.category, p.amount ?? b.amount, b.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'budget', entityId: b.id, summary: `تعديل الميزانية: ${b.name}`, before: b, after: p });
  return { ok: true };
}));

/* ─────────────── الطلبات المالية — محرك الحالة ─────────────── */
async function stepsOf(app, tenantId, workflowId) {
  if (!workflowId) return DEFAULT_STEPS;
  const w = await app.db.get('SELECT steps FROM workflows WHERE id=? AND tenant_id=?', workflowId, tenantId);
  const s = j(w?.steps, []);
  return s.length ? s : DEFAULT_STEPS;
}

/**
 * يُلبس الطلبَ مسارَه وحالته و«هل يعتمده هذا المستخدم؟».
 * مُصدَّرة لأن صندوق الاعتمادات الموحّد يقرأ الحكم نفسه — فلا يتفرّع المنطق.
 */
export async function decorateRequest(app, ctx, r) {
  const steps = await stepsOf(app, ctx.tenantId, r.workflow_id);
  const approvals = await app.db.all(
    `SELECT a.*, u.name AS approver_name FROM finance_approvals a
     LEFT JOIN users u ON u.id=a.approver_id WHERE a.request_id=? ORDER BY a.step_index, a.id`, r.id);
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
        state: rejected ? 'rejected' : done ? 'approved'
          : (i === r.current_step && ['pending', 'in_review'].includes(r.status) ? 'current' : 'waiting'),
        by: done?.approver_name || rejected?.approver_name || null,
        at: done?.acted_at || rejected?.acted_at || null,
        note: done?.note || rejected?.note || null
      };
    })
  };
}

router.get('/requests', can('finance.view', 'finance.request'), h(async (req) => {
  const app = req.app;
  const sc = scoped(req.ctx, { alias: 'f' });
  let sql = `SELECT f.*, u.name AS requester_name, b.name AS branch_name, w.name AS workflow_name,
      bd.name AS budget_name, t.status AS term_status,
      (SELECT COUNT(*) FROM invoices i WHERE i.request_id=f.id) AS invoices_count
    FROM finance_requests f JOIN users u ON u.id=f.requester_id
    LEFT JOIN branches b ON b.id=f.branch_id LEFT JOIN workflows w ON w.id=f.workflow_id
    LEFT JOIN budgets bd ON bd.id=f.budget_id LEFT JOIN terms t ON t.id=f.term_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'finance.view')) { sql += ' AND f.requester_id=?'; params.push(req.ctx.userId); }
  const q = req.query;
  if (q.status) { const parts = String(q.status).split(','); sql += ` AND f.status IN (${parts.map(() => '?').join(',')})`; params.push(...parts); }
  if (q.type) { sql += ' AND f.type=?'; params.push(q.type); }
  if (q.term_id) { sql += ' AND f.term_id=?'; params.push(Number(q.term_id)); }
  if (q.branch_id) { sql += ' AND f.branch_id=?'; params.push(Number(q.branch_id)); }
  if (q.mine === '1') { sql += ' AND f.requester_id=?'; params.push(req.ctx.userId); }
  if (q.q) { sql += ' AND (f.title LIKE ? OR f.number LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }
  sql += ' ORDER BY f.created_at DESC LIMIT 500';
  const rows = await app.db.all(sql, ...params);
  return Promise.all(rows.map(r => decorateRequest(app, req.ctx, r)));
}));

router.get('/requests/:id', can('finance.view', 'finance.request'), h(async (req) => {
  const app = req.app;
  const base = await findScoped(app, req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!base) throw notFound('الطلب غير موجود');
  if (!has(req.ctx, 'finance.view') && base.requester_id !== req.ctx.userId) throw forbidden();
  const r = await app.db.get(`SELECT f.*, u.name AS requester_name, b.name AS branch_name, w.name AS workflow_name,
      bd.name AS budget_name, t.status AS term_status
    FROM finance_requests f JOIN users u ON u.id=f.requester_id
    LEFT JOIN branches b ON b.id=f.branch_id LEFT JOIN workflows w ON w.id=f.workflow_id
    LEFT JOIN budgets bd ON bd.id=f.budget_id LEFT JOIN terms t ON t.id=f.term_id
    WHERE f.id=? AND f.tenant_id=?`, base.id, req.ctx.tenantId);
  const invoices = await app.db.all(`SELECT i.*, f.storage_key, f.original_name, f.mime
    FROM invoices i LEFT JOIN files f ON f.id=i.file_id WHERE i.request_id=?`, r.id);
  return { ...(await decorateRequest(app, req.ctx, r)), invoices };
}));

router.post('/requests', can('finance.request'), h(async (req) => {
  const app = req.app;
  const p = req.body || {};
  if (!p.title || !p.amount) throw badRequest('عنوان الطلب والمبلغ إلزاميان');
  const term = await currentTerm(app, req.ctx.tenantId);
  if (term && await termIsClosed(app, req.ctx.tenantId, term.id)) throw locked();
  const bid = p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  let workflowId = p.workflow_id || null;
  if (!workflowId) {
    const w = await app.db.get(
      `SELECT id FROM workflows WHERE tenant_id=? AND doc_type=? AND is_active=1 ORDER BY id LIMIT 1`,
      req.ctx.tenantId, p.type || 'expense');
    workflowId = w?.id || null;
  }

  const number = await nextNumber(app, req.ctx.tenantId, 'finance_requests', 'FR');
  const r = await app.db.run(
    `INSERT INTO finance_requests(tenant_id,branch_id,term_id,number,type,title,description,amount,requester_id,workflow_id,budget_id,current_step,status)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'pending')`,
    req.ctx.tenantId, bid, term?.id || null, number, p.type || 'expense', String(p.title).trim(),
    p.description || null, Number(p.amount), req.ctx.userId, workflowId, p.budget_id || null);

  const steps = await stepsOf(app, req.ctx.tenantId, workflowId);
  await audit(req, { action: 'create', entity: 'finance_request', entityId: r.lastId, branchId: bid,
    summary: `${req.ctx.userName} رفع طلباً مالياً (${number}) بمبلغ ${Number(p.amount).toLocaleString('ar-SA')} ر.س` });
  if (steps[0]) await notifyByPermission(app, req.ctx.tenantId, steps[0].permission, {
    type: 'finance.pending', category: 'finance', title: 'طلب مالي بانتظار اعتمادك',
    body: `${p.title} — ${Number(p.amount).toLocaleString('ar-SA')} ر.س`,
    url: `/finance?id=${r.lastId}`, data: { id: r.lastId }, urgency: 'high'
  }, { branchId: bid });

  return created({ id: r.lastId, number });
}));

/** الانتقال بين الحالات المتعاقبة — لا يمكن تجاوز خطوة (البند ٦) */
router.post('/requests/:id/decide', can('finance.approve_supervisor', 'finance.approve_finance', 'finance.manage'),
  h(async (req) => {
    const app = req.app;
    const r = await findScoped(app, req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
    if (!r) throw notFound('الطلب غير موجود');
    if (await termIsClosed(app, req.ctx.tenantId, r.term_id)) throw locked();
    if (!['pending', 'in_review'].includes(r.status)) throw conflict('الطلب أُغلق مسبقاً ولا يقبل إجراءً جديداً');

    const steps = await stepsOf(app, req.ctx.tenantId, r.workflow_id);
    const step = steps[r.current_step];
    if (!step) throw conflict('لا توجد خطوة اعتماد قائمة');
    const allowed = req.ctx.perms.includes(step.permission) || req.ctx.roleKey === 'owner';
    if (!allowed) throw forbidden(`هذه الخطوة (${step.name}) من صلاحية دور آخر — لا يمكن تجاوز الترتيب`);

    const approve = req.body?.action === 'approve';
    const note = req.body?.note || null;
    const stmts = [[
      `INSERT INTO finance_approvals(tenant_id,request_id,step_index,step_name,role_key,approver_id,action,note,acted_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [req.ctx.tenantId, r.id, r.current_step, step.name, step.role_key, req.ctx.userId,
        approve ? 'approve' : 'reject', note, nowUTC()]
    ]];

    if (!approve) {
      stmts.push([`UPDATE finance_requests SET status='rejected', updated_at=? WHERE id=?`, [nowUTC(), r.id]]);
    } else {
      const next = r.current_step + 1;
      const done = next >= steps.length;
      stmts.push(['UPDATE finance_requests SET current_step=?, status=?, updated_at=? WHERE id=?',
        [next, done ? 'approved' : 'in_review', nowUTC(), r.id]]);
      if (done && r.budget_id) stmts.push(['UPDATE budgets SET spent=spent+? WHERE id=? AND tenant_id=?',
        [r.amount, r.budget_id, req.ctx.tenantId]]);
    }
    await app.db.batch(stmts);

    const after = await app.db.get('SELECT * FROM finance_requests WHERE id=?', r.id);
    await audit(req, {
      action: approve ? 'approve' : 'reject', entity: 'finance_request', entityId: r.id, branchId: r.branch_id,
      summary: `${req.ctx.userName} (${step.name}) ${approve ? 'اعتمد' : 'رفض'} الطلب ${r.number} بمبلغ ${r.amount.toLocaleString('ar-SA')} ر.س`,
      before: { status: r.status, step: r.current_step }, after: { status: after.status, step: after.current_step }
    });

    await notifyUsers(app, req.ctx.tenantId, [r.requester_id], {
      type: approve ? 'finance.approved' : 'finance.rejected', category: 'finance',
      title: approve ? (after.status === 'approved' ? 'اعتُمد طلبك نهائياً' : `تم اعتماد الطلب في مرحلة ${step.name}`)
        : 'تم رفض طلبك المالي',
      body: `${r.title} — ${r.number}${note ? ' · ' + note : ''}`,
      url: `/finance?id=${r.id}`, data: { id: r.id }, urgency: 'high'
    });

    const nextStep = steps[after.current_step];
    if (approve && nextStep) await notifyByPermission(app, req.ctx.tenantId, nextStep.permission, {
      type: 'finance.pending', category: 'finance', title: 'طلب مالي بانتظار اعتمادك',
      body: `${r.title} — ${r.amount.toLocaleString('ar-SA')} ر.س`,
      url: `/finance?id=${r.id}`, data: { id: r.id }, urgency: 'high'
    }, { branchId: r.branch_id });

    return { ok: true, status: after.status, current_step: after.current_step };
  }));

router.patch('/requests/:id', can('finance.request', 'finance.manage'), h(async (req) => {
  const app = req.app;
  const r = await findScoped(app, req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!r) throw notFound('الطلب غير موجود');
  if (await termIsClosed(app, req.ctx.tenantId, r.term_id)) throw locked();
  if (r.requester_id !== req.ctx.userId && !has(req.ctx, 'finance.manage')) throw forbidden();
  if (r.current_step > 0) throw conflict('لا يمكن تعديل طلب بدأت دورة اعتماده');
  const p = req.body || {};
  await app.db.run('UPDATE finance_requests SET title=?,description=?,amount=?,type=?,budget_id=?,updated_at=? WHERE id=? AND tenant_id=?',
    p.title ?? r.title, p.description ?? r.description, p.amount ?? r.amount,
    p.type ?? r.type, p.budget_id ?? r.budget_id, nowUTC(), r.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'finance_request', entityId: r.id, summary: `تعديل الطلب ${r.number}`, before: r, after: p });
  return { ok: true };
}));

/* ─────────────── الفواتير ─────────────── */
router.get('/invoices', can('invoices.view', 'finance.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'i' });
  let sql = `SELECT i.*, b.name AS branch_name, f.number AS request_number, f.title AS request_title,
      fl.storage_key, fl.original_name, fl.mime, u.name AS created_by_name
    FROM invoices i LEFT JOIN branches b ON b.id=i.branch_id
    LEFT JOIN finance_requests f ON f.id=i.request_id
    LEFT JOIN files fl ON fl.id=i.file_id LEFT JOIN users u ON u.id=i.created_by
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (req.query.request_id) { sql += ' AND i.request_id=?'; params.push(Number(req.query.request_id)); }
  if (req.query.from) { sql += ' AND i.date>=?'; params.push(req.query.from); }
  if (req.query.to) { sql += ' AND i.date<=?'; params.push(req.query.to); }
  sql += ' ORDER BY i.date DESC, i.id DESC LIMIT 500';
  return req.app.db.all(sql, ...params);
}));

router.post('/invoices', can('invoices.manage'), h(async (req) => {
  const app = req.app;
  const p = req.body || {};
  if (!p.total) throw badRequest('إجمالي الفاتورة إلزامي');
  const term = await currentTerm(app, req.ctx.tenantId);
  const vatRate = (req.ctx.tenantSettings?.vat_rate ?? 15) / 100;
  const total = Number(p.total);
  const amount = p.amount !== undefined ? Number(p.amount) : Number((total / (1 + vatRate)).toFixed(2));
  const vat = p.vat !== undefined ? Number(p.vat) : Number((total - amount).toFixed(2));
  const bid = p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : (req.ctx.activeBranchId || req.ctx.primaryBranchId);

  const r = await app.db.run(
    `INSERT INTO invoices(tenant_id,branch_id,term_id,request_id,number,vendor,amount,vat,total,date,file_id,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, bid, term?.id || null, p.request_id || null,
    p.number || await nextNumber(app, req.ctx.tenantId, 'invoices', 'INV'), p.vendor || null,
    amount, vat, total, p.date || new Date().toISOString().slice(0, 10), p.file_id || null, req.ctx.userId);
  await audit(req, { action: 'create', entity: 'invoice', entityId: r.lastId, branchId: bid,
    summary: `تسجيل فاتورة بمبلغ ${total.toLocaleString('ar-SA')} ر.س من ${p.vendor || 'مورد'}` });
  return created({ id: r.lastId });
}));

router.delete('/invoices/:id', can('invoices.manage'), h(async (req) => {
  const app = req.app;
  const i = await findScoped(app, req.ctx, 'invoices', req.params.id, { branchCheck: true });
  if (!i) throw notFound('الفاتورة غير موجودة');
  if (await termIsClosed(app, req.ctx.tenantId, i.term_id)) throw locked();
  await app.db.run('DELETE FROM invoices WHERE id=? AND tenant_id=?', i.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'invoice', entityId: i.id, summary: `حذف فاتورة ${i.number}`, before: i });
  return { ok: true };
}));

/* ═══════════ إغلاق العهد المالية ═══════════
 *
 * العهدة مبلغٌ يُسلَّم ليُنفَق، وإغلاقُها إثباتُ ما أُنفِق منه. فلا تُغلَق بضغطة
 * زر: تُرفَع فواتيرها سطراً سطراً (رقمٌ وتاجرٌ وبيانٌ ومبلغ) بمرفقاتها، فيبين
 * المغطّى والمتبقّي — والفرقُ عجزٌ لا يُبتلَع بل يُعرَض ويُعتمَد بصلاحيةٍ له.
 */

const SETTLE_STATES = new Set(['open', 'submitted', 'settled']);

/** حساب العهدة من فواتيرها — المصدر الوحيد، فلا يُخزَّن مجموعٌ يخالف سطوره */
async function settlementOf(app, ctx, r) {
  const lines = await app.db.all(
    `SELECT i.*, f.original_name, f.mime FROM invoices i
     LEFT JOIN files f ON f.id = i.file_id
     WHERE i.request_id=? AND i.tenant_id=? ORDER BY i.id`, r.id, ctx.tenantId);
  const covered = lines.reduce((a, x) => a + Number(x.total || x.amount || 0), 0);
  const amount = Number(r.amount || 0);
  /* التقريب على منزلتين: جمعُ العشريات يخلّف كسوراً لا تعني شيئاً في المال */
  const round = (n) => Math.round(n * 100) / 100;
  const deficit = round(Math.max(0, amount - covered));
  const surplus = round(Math.max(0, covered - amount));
  return {
    lines: lines.map(x => ({
      id: x.id, number: x.number, vendor: x.vendor, description: x.description,
      amount: x.amount, vat: x.vat, total: x.total, date: x.date,
      file: x.file_id ? { id: x.file_id, name: x.original_name, mime: x.mime, url: `/api/files/${x.file_id}` } : null
    })),
    amount, covered: round(covered), deficit, surplus,
    status: r.settle_status || 'open',
    settled_at: r.settled_at, settled_by: r.settled_by, note: r.settle_note,
    /* من يملك اعتماد العجز يرى الزرّ مفتوحاً ولو بقي عجز */
    can_settle: has(ctx, 'finance.manage') || has(ctx, 'finance.approve_finance'),
    can_settle_deficit: has(ctx, 'finance.settle_deficit') || has(ctx, 'finance.manage')
  };
}

/** العهدة وحالتها */
router.get('/requests/:id/settlement', can('finance.view', 'finance.request'), h(async (req) => {
  const r = await findScoped(req.app, req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!r) throw notFound('الطلب غير موجود');
  return settlementOf(req.app, req.ctx, r);
}));

/**
 * رفع بيان الإغلاق.
 *
 * الأسطر تُستبدل كاملةً لا تُضاف: البيان وحدةٌ واحدة يُراجعها المعتمِد، وإضافةٌ
 * فوق إضافةٍ تُخلّف سطوراً منسيّة من محاولةٍ سابقة.
 */
router.post('/requests/:id/settlement', can('finance.request', 'finance.view', 'finance.manage'), h(async (req) => {
  const app = req.app;
  const r = await findScoped(app, req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
  if (!r) throw notFound('الطلب غير موجود');
  if (r.type !== 'custody') throw badRequest('الإغلاق للعهد وحدها');
  if (r.settle_status === 'settled') throw conflict('العهدة مغلقة ومعتمدة — لا تُعدَّل');
  if (await termIsClosed(app, req.ctx.tenantId, r.term_id)) throw locked('الفصل مغلق');

  const rows = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!rows.length) throw badRequest('أضف سطر فاتورةٍ واحداً على الأقل');
  if (rows.length > 200) throw badRequest('عدد الفواتير أكبر من المسموح');

  const clean = rows.map((x, i) => {
    const amount = Number(x?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest(`المبلغ في السطر ${i + 1} غير صحيح`);
    if (!String(x?.number || '').trim()) throw badRequest(`رقم الفاتورة في السطر ${i + 1} إلزامي`);
    if (!String(x?.vendor || '').trim()) throw badRequest(`اسم التاجر في السطر ${i + 1} إلزامي`);
    const vat = Number(x?.vat) || 0;
    return {
      number: String(x.number).trim().slice(0, 60),
      vendor: String(x.vendor).trim().slice(0, 120),
      description: String(x?.description || '').trim().slice(0, 400),
      amount, vat, total: Math.round((amount + vat) * 100) / 100,
      date: String(x?.date || '').slice(0, 10) || null,
      file_id: Number(x?.file_id) || null
    };
  });

  /* المرفق يجب أن يكون ملفَّ هذه الجهة — لا رقمٌ يُكتَب بالهواء */
  for (const c of clean) {
    if (!c.file_id) continue;
    const f = await app.db.get('SELECT id FROM files WHERE id=? AND tenant_id=?', c.file_id, req.ctx.tenantId);
    if (!f) throw badRequest('مرفقٌ غير موجود أو لا يخصّ جهتك');
  }

  await app.db.run('DELETE FROM invoices WHERE request_id=? AND tenant_id=?', r.id, req.ctx.tenantId);
  for (const c of clean) {
    await app.db.run(
      `INSERT INTO invoices(tenant_id,branch_id,term_id,request_id,number,vendor,description,
         amount,vat,total,date,file_id,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'recorded')`,
      req.ctx.tenantId, r.branch_id, r.term_id, r.id, c.number, c.vendor, c.description,
      c.amount, c.vat, c.total, c.date, c.file_id);
  }
  const covered = clean.reduce((a, c) => a + c.total, 0);
  await app.db.run(
    `UPDATE finance_requests SET settle_status='submitted', settled_amount=?, settle_note=?, updated_at=?
     WHERE id=? AND tenant_id=?`,
    Math.round(covered * 100) / 100, String(req.body?.note || '').slice(0, 600) || null,
    nowUTC(), r.id, req.ctx.tenantId);

  await audit(req, { action: 'update', entity: 'finance_request', entityId: r.id,
    summary: `${req.ctx.userName} رفع بيان إغلاق العهدة ${r.number || r.id}`,
    meta: { lines: clean.length, covered } });
  await notifyByPermission(app, req.ctx.tenantId, 'finance.manage', {
    type: 'finance.settlement', category: 'finance',
    title: 'بيان إغلاق عهدة بانتظار الاعتماد',
    body: `${r.title} — غُطّي ${Math.round(covered * 100) / 100} من ${r.amount}`,
    url: `/finance?id=${r.id}` }).catch(() => {});

  const fresh = await app.db.get('SELECT * FROM finance_requests WHERE id=?', r.id);
  return settlementOf(app, req.ctx, fresh);
}));

/**
 * اعتماد الإغلاق.
 *
 * ويجوز مع بقاء عجزٍ لمن يملك `finance.settle_deficit` — والعجز يُثبَت في السجل
 * بمقداره، فلا يُغلَق بابٌ على نقصٍ لا يعرفه أحد.
 */
router.post('/requests/:id/settlement/approve',
  can('finance.approve_finance', 'finance.manage'), h(async (req) => {
    const app = req.app;
    const r = await findScoped(app, req.ctx, 'finance_requests', req.params.id, { branchCheck: true });
    if (!r) throw notFound('الطلب غير موجود');
    if (r.type !== 'custody') throw badRequest('الإغلاق للعهد وحدها');
    if (r.settle_status === 'settled') throw conflict('العهدة مغلقة مسبقاً');
    if (r.settle_status !== 'submitted') throw badRequest('لم يُرفع بيان الإغلاق بعد');

    const st = await settlementOf(app, req.ctx, r);
    if (st.deficit > 0 && !(has(req.ctx, 'finance.settle_deficit') || has(req.ctx, 'finance.manage'))) {
      throw forbidden(`العهدة عليها عجز ${st.deficit} — اعتمادها بعجزٍ يحتاج صلاحية «اعتماد إغلاق عهدة بعجز»`);
    }
    await app.db.run(
      `UPDATE finance_requests SET settle_status='settled', settled_by=?, settled_at=?, updated_at=?
       WHERE id=? AND tenant_id=?`,
      req.ctx.userId, nowUTC(), nowUTC(), r.id, req.ctx.tenantId);

    await audit(req, { action: 'approve', entity: 'finance_request', entityId: r.id,
      summary: st.deficit > 0
        ? `${req.ctx.userName} اعتمد إغلاق العهدة ${r.number || r.id} بعجز ${st.deficit}`
        : `${req.ctx.userName} اعتمد إغلاق العهدة ${r.number || r.id} مغطّاةً بالكامل`,
      meta: { covered: st.covered, deficit: st.deficit, surplus: st.surplus } });
    await notifyUsers(app, req.ctx.tenantId, [r.requester_id], {
      type: 'finance.settled', category: 'finance', title: 'اعتُمد إغلاق عهدتك',
      body: st.deficit > 0 ? `بعجز ${st.deficit} ر.س` : 'مغطّاةٌ بالكامل',
      url: `/finance?id=${r.id}` }).catch(() => {});

    const fresh = await app.db.get('SELECT * FROM finance_requests WHERE id=?', r.id);
    return settlementOf(app, req.ctx, fresh);
  }));

export default router;
