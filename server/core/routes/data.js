import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created, accepted } from '../http.js';
import { badRequest, notFound } from '../errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, findScoped, currentTerm } from '../scope.js';
import { parseCSV, toCSV } from '../csv.js';
import { readXlsx, buildXlsx } from '../xlsx.js';
import { buildReportHTML } from '../report.js';
import { enqueue } from '../queue.js';
import { IMPORT_TYPES, validateRows } from '../jobs/importer.js';
import { runReport, REPORTS } from '../jobs/reports.js';
import { decorateRequest } from './finance.js';
import { has } from '../middleware/rbac.js';

const importsRouter = new Hono();
const reportsRouter = new Hono();
const auditRouter = new Hono();
const dashboardRouter = new Hono();
const approvalsRouter = new Hono();
const setupRouter = new Hono();

/* أسماء أنواع الإجازات — هي نفسها المعروضة في شاشة الموارد البشرية */
const LEAVE_AR = { annual: 'سنوية', sick: 'مرضية', emergency: 'اضطرارية', unpaid: 'بدون راتب' };

/* ═══════ ١٢. استيراد البيانات الأولية ═══════ */
importsRouter.get('/types', can('imports.manage'), h(async () =>
  Object.entries(IMPORT_TYPES).map(([key, v]) => ({
    key, label: v.label, description: v.description,
    columns: v.columns.map(c => ({ key: c.key, header: c.header, required: !!c.required, hint: c.hint }))
  }))));

importsRouter.get('/template/:type', can('imports.manage'), h(async (req) => {
  const def = IMPORT_TYPES[req.params.type];
  if (!def) throw notFound('نوع الاستيراد غير مدعوم');
  const buf = await buildXlsx([{
    name: def.label,
    columns: def.columns.map(c => ({ key: c.key, header: c.header + (c.required ? ' *' : '') })),
    rows: def.sample || []
  }]);
  return new Response(buf, { headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('قالب-' + def.label + '.xlsx')}`
  } });
}));

async function readTabular(file) {
  const name = String(file.name || '').toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.xlsx') || String(file.type).includes('spreadsheetml')) return readXlsx(buf);
  return parseCSV(new TextDecoder().decode(buf));
}
const pickFile = (body) => {
  const f = Array.isArray(body?.file) ? body.file[0] : body?.file;
  return f && typeof f === 'object' && 'arrayBuffer' in f ? f : null;
};

importsRouter.post('/validate', can('imports.manage'), h(async (req) => {
  const type = String(req.body?.type || '');
  if (!IMPORT_TYPES[type]) throw badRequest('نوع الاستيراد غير مدعوم');
  const file = pickFile(req.body);
  if (!file) throw badRequest('يرجى إرفاق ملف Excel أو CSV');
  const rows = await readTabular(file);
  if (rows.length < 2) throw badRequest('الملف فارغ أو لا يحتوي على صفوف بيانات');
  const result = await validateRows(req.app, req.ctx, type, rows);
  return { type, file_name: file.name, ...result };
}));

importsRouter.post('/run', can('imports.manage'), h(async (req) => {
  const app = req.app;
  const type = String(req.body?.type || '');
  const def = IMPORT_TYPES[type];
  if (!def) throw badRequest('نوع الاستيراد غير مدعوم');
  const file = pickFile(req.body);
  if (!file) throw badRequest('يرجى إرفاق الملف');
  const rows = await readTabular(file);
  const check = await validateRows(app, req.ctx, type, rows);
  if (!check.valid_rows.length) throw badRequest('لا توجد صفوف صالحة للاستيراد', check.errors);

  const batch = await app.db.run(
    `INSERT INTO import_batches(tenant_id,branch_id,type,file_name,total_rows,error_rows,errors,created_by)
     VALUES(?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId, type, file.name,
    check.total, check.errors.length, JSON.stringify(check.errors.slice(0, 200)), req.ctx.userId);

  await enqueue(app, 'data.import', {
    batchId: batch.lastId, tenantId: req.ctx.tenantId, userId: req.ctx.userId,
    type, rows: check.valid_rows, branchId: req.ctx.activeBranchId || req.ctx.primaryBranchId
  }, { tenantId: req.ctx.tenantId });

  await audit(req, { action: 'create', entity: 'import_batch', entityId: batch.lastId,
    summary: `بدء استيراد ${def.label} — ${check.valid_rows.length} صف صالح من ${check.total}` });
  return accepted({ batch_id: batch.lastId, queued: check.valid_rows.length, skipped: check.errors.length });
}));

importsRouter.get('/', can('imports.manage'), h(async (req) =>
  (await req.app.db.all(`SELECT b.*, u.name AS created_by_name FROM import_batches b
    LEFT JOIN users u ON u.id=b.created_by WHERE b.tenant_id=? ORDER BY b.id DESC LIMIT 50`, req.ctx.tenantId))
    .map(r => ({ ...r, errors: j(r.errors, []) }))));

importsRouter.get('/:id', can('imports.manage'), h(async (req) => {
  const b = await findScoped(req.app, req.ctx, 'import_batches', req.params.id);
  if (!b) throw notFound('عملية الاستيراد غير موجودة');
  return { ...b, errors: j(b.errors, []) };
}));

/* ═══════ ١٣. محرك التقارير والطباعة ═══════ */
reportsRouter.get('/', can('reports.view'), h(async () =>
  Object.entries(REPORTS).map(([key, r]) => ({
    key, label: r.label, description: r.description, module: r.module, filters: r.filters, permission: r.permission
  }))));

reportsRouter.post('/:key/run', can('reports.view'), h(async (req) => {
  const def = REPORTS[req.params.key];
  if (!def) throw notFound('التقرير غير موجود');
  if (def.permission && !req.ctx.perms.includes(def.permission))
    throw badRequest('لا تملك صلاحية عرض هذا التقرير');
  const out = await runReport(req.app, req.ctx, req.params.key, req.body?.filters || {});
  return { key: req.params.key, label: def.label, ...out };
}));

reportsRouter.post('/:key/export', can('reports.export'), h(async (req) => {
  const app = req.app;
  const def = REPORTS[req.params.key];
  if (!def) throw notFound('التقرير غير موجود');
  if (def.permission && !req.ctx.perms.includes(def.permission))
    throw badRequest('لا تملك صلاحية تصدير هذا التقرير');
  const format = String(req.body?.format || 'xlsx').toLowerCase();
  const out = await runReport(app, req.ctx, req.params.key, req.body?.filters || {});
  const tenant = await app.db.get('SELECT * FROM tenants WHERE id=?', req.ctx.tenantId);
  const fileBase = `${def.label}-${new Date().toISOString().slice(0, 10)}`;

  await audit(req, { action: 'export', entity: 'report', entityId: req.params.key,
    summary: `${req.ctx.userName} صدّر تقرير "${def.label}" بصيغة ${format.toUpperCase()} (${out.rows.length} سجل)` });

  if (format === 'csv') {
    return new Response(toCSV(out.columns, out.rows), { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileBase + '.csv')}`
    } });
  }
  if (format === 'xlsx') {
    const buf = await buildXlsx([{ name: def.label.slice(0, 28), columns: out.columns, rows: out.rows }]);
    return new Response(buf, { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileBase + '.xlsx')}`
    } });
  }
  const html = buildReportHTML({
    tenant, title: def.label, subtitle: def.description,
    columns: out.columns, rows: out.rows, filters: out.applied_filters || [],
    summary: out.summary || [], calendar: req.ctx.calendarPref,
    generatedBy: req.ctx.userName, orientation: out.columns.length > 6 ? 'landscape' : 'portrait'
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}));

/* ═══════ ١٤. سجل النشاطات ═══════ */
auditRouter.get('/', can('audit.view'), h(async (req) => {
  const app = req.app;
  const q = req.query;
  let where = 'tenant_id=?';
  const params = [req.ctx.tenantId];
  if (q.user_id) { where += ' AND user_id=?'; params.push(Number(q.user_id)); }
  if (q.action) { where += ' AND action=?'; params.push(q.action); }
  if (q.entity) { where += ' AND entity=?'; params.push(q.entity); }
  if (q.from) { where += ' AND created_at>=?'; params.push(q.from); }
  if (q.to) { where += ' AND created_at<=?'; params.push(q.to + 'T23:59:59Z'); }
  if (q.q) { where += ' AND (summary LIKE ? OR user_name LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }

  const limit = Math.min(500, Number(q.limit) || 100);
  const offset = Number(q.offset) || 0;
  const total = (await app.db.get(`SELECT COUNT(*) AS c FROM audit_logs WHERE ${where}`, ...params)).c;
  const rows = await app.db.all(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset);
  return {
    total, limit, offset,
    items: rows.map(r => ({ ...r, before: j(r.before_json, null), after: j(r.after_json, null) })),
    actions: (await app.db.all('SELECT DISTINCT action FROM audit_logs WHERE tenant_id=?', req.ctx.tenantId)).map(a => a.action),
    entities: (await app.db.all('SELECT DISTINCT entity FROM audit_logs WHERE tenant_id=?', req.ctx.tenantId)).map(a => a.entity)
  };
}));

/* ═══════ لوحة التحكم المركزية المجمّعة ═══════ */
dashboardRouter.get('/', h(async (req) => {
  const app = req.app;
  const ctx = req.ctx;
  const term = ctx.activeTermId
    ? await findScoped(app, ctx, 'terms', ctx.activeTermId)
    : await currentTerm(app, ctx.tenantId);

  const sc = scoped(ctx, { alias: 't' });
  const termClause = term ? ' AND t.term_id=?' : '';
  const termParam = term ? [term.id] : [];
  const branchClause = ctx.activeBranchId ? ' AND t.branch_id=?' : '';
  const branchParam = ctx.activeBranchId ? [ctx.activeBranchId] : [];

  const tasks = await app.db.all(
    `SELECT status, COUNT(*) AS c FROM tasks t WHERE ${sc.where}${termClause}${branchClause} GROUP BY status`,
    ...sc.params, ...termParam, ...branchParam);
  const myTasks = (await app.db.get(
    `SELECT COUNT(*) AS c FROM tasks t WHERE ${sc.where} AND t.assignee_id=? AND t.status<>'done'`,
    ...sc.params, ctx.userId)).c;
  const overdue = (await app.db.get(
    `SELECT COUNT(*) AS c FROM tasks t WHERE ${sc.where} AND t.status<>'done' AND t.due_date<date('now')`, ...sc.params)).c;

  const fs = scoped(ctx, { alias: 'f' });
  const finance = await app.db.all(
    `SELECT status, COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM finance_requests f
     WHERE ${fs.where}${term ? ' AND f.term_id=?' : ''} GROUP BY status`, ...fs.params, ...termParam);

  const today = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);
  const as = scoped(ctx, { alias: 'a' });
  const attendance = await app.db.all(
    `SELECT status, COUNT(*) AS c FROM attendance a WHERE ${as.where} AND a.date=? GROUP BY status`, ...as.params, today);

  const ts = scoped(ctx, { alias: 't' });
  const tickets = await app.db.all(`SELECT status, COUNT(*) AS c FROM tickets t WHERE ${ts.where} GROUP BY status`, ...ts.params);
  const breached = (await app.db.get(
    `SELECT COUNT(*) AS c FROM tickets t WHERE ${ts.where} AND t.status IN ('open','in_progress') AND t.sla_due_at < ?`,
    ...ts.params, nowUTC())).c;

  const branches = ctx.branchIds.length ? await app.db.all(`SELECT b.id, b.name, b.code,
      (SELECT COUNT(*) FROM tasks t WHERE t.branch_id=b.id ${term ? 'AND t.term_id=' + term.id : ''}) AS tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.branch_id=b.id AND t.status='done' ${term ? 'AND t.term_id=' + term.id : ''}) AS tasks_done,
      (SELECT COUNT(*) FROM users u WHERE u.primary_branch_id=b.id AND u.status='active') AS staff,
      (SELECT COALESCE(SUM(amount),0) FROM finance_requests f WHERE f.branch_id=b.id AND f.status='approved' ${term ? 'AND f.term_id=' + term.id : ''}) AS spent
    FROM branches b WHERE b.tenant_id=? AND b.id IN (${ctx.branchIds.map(() => '?').join(',')}) AND b.is_active=1`,
    ctx.tenantId, ...ctx.branchIds) : [];

  const recent = await app.db.all(
    'SELECT id,user_name,action,entity,summary,created_at FROM audit_logs WHERE tenant_id=? ORDER BY id DESC LIMIT 8', ctx.tenantId);
  const upcoming = await app.db.all(`SELECT t.id,t.title,t.due_date,t.priority,t.status, u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE ${sc.where} AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date>=date('now')
    ORDER BY t.due_date LIMIT 6`, ...sc.params);
  const budgets = await app.db.get(
    `SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(spent),0) AS spent FROM budgets
     WHERE tenant_id=? ${term ? 'AND term_id=' + term.id : ''}`, ctx.tenantId);

  /*
   * العهد المفتوحة: مبالغ سُلِّمت ولم تُغلَق بعد.
   *
   * المال الخارج بلا إثبات إنفاق أخطر من طلبٍ ينتظر اعتماداً، ولم يكن في اللوحة
   * ما يقوله. وهنا ثلاثة: كم عهدةً مفتوحة، وكم مجموعها، وكم بيانٍ رُفع ينتظر
   * اعتماد إغلاقه.
   */
  const cs = scoped(ctx, { alias: 'f' });
  const custody = has(ctx, 'finance.view') ? await app.db.get(
    `SELECT COUNT(*) AS open, COALESCE(SUM(f.amount),0) AS total,
            COALESCE(SUM(CASE WHEN f.settle_status='submitted' THEN 1 ELSE 0 END),0) AS awaiting
     FROM finance_requests f
     WHERE ${cs.where} AND f.type='custody' AND f.status IN ('approved','paid')
       AND COALESCE(f.settle_status,'open') <> 'settled'`, ...cs.params) : null;

  return {
    term, branch_id: ctx.activeBranchId || null,
    tasks: Object.fromEntries(tasks.map(t => [t.status, t.c])),
    tasks_total: tasks.reduce((s, t) => s + t.c, 0),
    my_open_tasks: myTasks, overdue,
    finance: Object.fromEntries(finance.map(f => [f.status, { count: f.c, total: f.total }])),
    custody,
    attendance_today: Object.fromEntries(attendance.map(a => [a.status, a.c])),
    tickets: Object.fromEntries(tickets.map(t => [t.status, t.c])), tickets_sla_breached: breached,
    branches, recent_activity: recent, upcoming_tasks: upcoming, budgets
  };
}));


/* ═══════ صندوق الاعتمادات الموحّد ═══════
 *
 * ما ينتظر قرار المستخدم كان موزّعاً على شاشتين: الطلبات المالية في تبويب
 * داخل «النظام المالي»، والإجازات في تبويب داخل «الموارد البشرية». فمن يعتمد
 * الاثنين يفتح شاشتين ليعرف هل ينتظره شيء — والذي لا يُرى لا يُعتمد.
 *
 * هذا المسار يقرأ المصدرين بالحكم نفسه الذي تقرأ به شاشتاهما — `decorateRequest`
 * للمالية وصلاحية `hr.leaves.approve` للإجازات — فلا يتفرّع منطق الاعتماد ولا
 * يظهر هنا ما لا يملك المستخدم اعتماده هناك.
 */
approvalsRouter.get('/', h(async (req) => {
  const app = req.app;
  const ctx = req.ctx;
  const items = [];

  /* ── الطلبات المالية المعلّقة التي يقف المستخدم على خطوتها ── */
  if (has(ctx, 'finance.view') || has(ctx, 'finance.request')) {
    const fs = scoped(ctx, { alias: 'f' });
    const rows = await app.db.all(
      `SELECT f.*, u.name AS requester_name, b.name AS branch_name
       FROM finance_requests f JOIN users u ON u.id=f.requester_id
       LEFT JOIN branches b ON b.id=f.branch_id
       WHERE ${fs.where} AND f.status IN ('pending','in_review')
       ORDER BY f.created_at LIMIT 200`, ...fs.params);
    for (const r of rows) {
      const d = await decorateRequest(app, ctx, r);
      if (!d.can_approve) continue;
      items.push({
        kind: 'finance', id: d.id, ref: d.number, title: d.title,
        requester: d.requester_name, branch: d.branch_name,
        amount: d.amount, step: d.current_step_name,
        created_at: d.created_at, url: `/finance?id=${d.id}`
      });
    }
  }

  /* ── الإجازات المعلّقة لمن يملك اعتمادها ── */
  if (has(ctx, 'hr.leaves.approve')) {
    const ls = scoped(ctx, { alias: 'l' });
    const rows = await app.db.all(
      `SELECT l.*, u.name AS user_name FROM leaves l JOIN users u ON u.id=l.user_id
       WHERE ${ls.where} AND l.status='pending' ORDER BY l.created_at LIMIT 200`, ...ls.params);
    for (const l of rows) {
      /* التواريخ تخرج خاماً: الواجهة تعرضها بتقويم المستخدم — هجرياً أو ميلادياً */
      items.push({
        kind: 'leave', id: l.id, ref: null,
        title: `إجازة ${LEAVE_AR[l.type] || l.type}`,
        start_date: l.start_date, end_date: l.end_date, days: l.days,
        requester: l.user_name, branch: null, amount: null,
        step: 'اعتماد الموارد البشرية',
        created_at: l.created_at, url: '/hr'
      });
    }
  }

  /* الأقدم أولاً: ما طال انتظاره أحقُّ بالنظر */
  items.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

  return {
    items,
    counts: {
      total: items.length,
      finance: items.filter(i => i.kind === 'finance').length,
      leave: items.filter(i => i.kind === 'leave').length
    }
  };
}));


/* ═══════ تجهيز الجهة الجديدة ═══════
 *
 * الجهة تُنشأ فتفتح على لوحةٍ كلُّها أصفار: لا تدلّ على خطوةٍ تُبتدأ، ولا تطمئن
 * أنّ شيئاً يعمل. هذه الخطوات الخمس تحلّ محلّها حتى يمتلئ المجمّع ببياناته.
 *
 * والإنجاز لا يُخزَّن: يُحتسب من البيانات نفسها في كل قراءة. فمن أضاف فرعاً من
 * شاشة الفروع يجد الخطوة منجزةً هنا دون أن يعلّمها — ولا تتناقض حالتان لشيء واحد.
 */
const SETUP_STEPS = [
  { key: 'branches',  title: 'أضف فروعك وحدّد نطاقها',
    why: 'بإحداثيات الفرع يقبل التحضير الذكي حضور المعلم.', cta: 'إضافة فرع', url: '/org' },
  { key: 'team',      title: 'ادعُ فريقك وأسند الأدوار',
    why: 'كل دور يرى ما يخصّه فقط — المعلم غير المحاسب.', cta: 'دعوة أعضاء', url: '/org' },
  { key: 'term',      title: 'افتح الفصل الدراسي',
    why: 'المهام والحضور والتقارير كلها معلّقة بفصل مفتوح.', cta: 'فتح فصل', url: '/terms' },
  { key: 'committee', title: 'أنشئ لجانك ووزّع مهامها',
    why: 'اللجان تجعل المتابعة على مجموعات لا على أفراد.', cta: 'إنشاء لجنة', url: '/committees' },
  { key: 'workflow',  title: 'اضبط مسار الاعتماد المالي',
    why: 'يحدّد من يعتمد وبأي ترتيب قبل صرف أول ريال.', cta: 'ضبط المسار', url: '/finance' }
];

setupRouter.get('/', can('settings.manage'), h(async (req) => {
  const app = req.app;
  const t = req.ctx.tenantId;
  const one = async (sql, ...p) => (await app.db.get(sql, ...p)).c;

  const counts = {
    branches:  await one('SELECT COUNT(*) AS c FROM branches WHERE tenant_id=? AND is_active=1', t),
    team:      await one("SELECT COUNT(*) AS c FROM users WHERE tenant_id=? AND status='active'", t),
    term:      await one("SELECT COUNT(*) AS c FROM terms WHERE tenant_id=? AND status='open'", t),
    committee: await one('SELECT COUNT(*) AS c FROM committees WHERE tenant_id=?', t),
    workflow:  await one('SELECT COUNT(*) AS c FROM workflows WHERE tenant_id=?', t)
  };
  /* الفريق يُعدّ منجزاً بمنسوبٍ غير المدير نفسه */
  const done = {
    branches: counts.branches >= 1, team: counts.team > 1, term: counts.term >= 1,
    committee: counts.committee >= 1, workflow: counts.workflow >= 1
  };

  const tenant = await app.db.get('SELECT setup_dismissed_at FROM tenants WHERE id=?', t);
  const steps = SETUP_STEPS.map(s => ({ ...s, done: !!done[s.key] }));
  const remaining = steps.filter(s => !s.done).length;

  return {
    steps, remaining, counts,
    complete: remaining === 0,
    dismissed: !!tenant?.setup_dismissed_at,
    /* تظهر البطاقة ما دامت ناقصةً ولم تُخفَ يدوياً */
    show: remaining > 0 && !tenant?.setup_dismissed_at
  };
}));

setupRouter.post('/dismiss', can('settings.manage'), h(async (req) => {
  await req.app.db.run('UPDATE tenants SET setup_dismissed_at=? WHERE id=?', nowUTC(), req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'tenant', entityId: req.ctx.tenantId,
    summary: `${req.ctx.userName} أخفى بطاقة تجهيز الجهة` });
  return { ok: true };
}));

export { importsRouter, reportsRouter, auditRouter, dashboardRouter, approvalsRouter, setupRouter };
