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

const importsRouter = new Hono();
const reportsRouter = new Hono();
const auditRouter = new Hono();
const dashboardRouter = new Hono();

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

  return {
    term, branch_id: ctx.activeBranchId || null,
    tasks: Object.fromEntries(tasks.map(t => [t.status, t.c])),
    tasks_total: tasks.reduce((s, t) => s + t.c, 0),
    my_open_tasks: myTasks, overdue,
    finance: Object.fromEntries(finance.map(f => [f.status, { count: f.c, total: f.total }])),
    attendance_today: Object.fromEntries(attendance.map(a => [a.status, a.c])),
    tickets: Object.fromEntries(tickets.map(t => [t.status, t.c])), tickets_sla_breached: breached,
    branches, recent_activity: recent, upcoming_tasks: upcoming, budgets
  };
}));

export { importsRouter, reportsRouter, auditRouter, dashboardRouter };
