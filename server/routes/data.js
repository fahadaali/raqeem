import express from 'express';
import multer from 'multer';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, findScoped, currentTerm } from '../lib/scope.js';
import { parseCSV, toCSV } from '../lib/csv.js';
import { readXlsx, buildXlsx } from '../lib/xlsx.js';
import { buildReportHTML } from '../lib/report.js';
import { enqueue } from '../lib/queue.js';
import { IMPORT_TYPES, validateRows } from '../jobs/importer.js';
import { runReport, REPORTS } from '../jobs/reports.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/* ═══════════════ ١٢. استيراد البيانات الأولية ═══════════════ */
router.get('/imports/types', can('imports.manage'), ah(async (req, res) => {
  res.json(Object.entries(IMPORT_TYPES).map(([key, v]) => ({
    key, label: v.label, description: v.description,
    columns: v.columns.map(c => ({ key: c.key, header: c.header, required: !!c.required, hint: c.hint }))
  })));
}));

/** تنزيل قالب جاهز (Excel) لكل نوع استيراد */
router.get('/imports/template/:type', can('imports.manage'), ah(async (req, res) => {
  const def = IMPORT_TYPES[req.params.type];
  if (!def) throw notFound('نوع الاستيراد غير مدعوم');
  const buf = buildXlsx([{
    name: def.label,
    columns: def.columns.map(c => ({ key: c.key, header: c.header + (c.required ? ' *' : '') })),
    rows: def.sample || []
  }]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('قالب-' + def.label + '.xlsx')}`);
  res.send(buf);
}));

function readTabular(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx') || file.mimetype.includes('spreadsheetml')) return readXlsx(file.buffer);
  return parseCSV(file.buffer.toString('utf8'));
}

/** فحص الملف وإظهار تقرير الأخطاء المرئي قبل الاعتماد */
router.post('/imports/validate', can('imports.manage'), upload.single('file'), ah(async (req, res) => {
  const def = IMPORT_TYPES[req.body?.type];
  if (!def) throw badRequest('نوع الاستيراد غير مدعوم');
  if (!req.file) throw badRequest('يرجى إرفاق ملف Excel أو CSV');
  const rows = readTabular(req.file);
  if (rows.length < 2) throw badRequest('الملف فارغ أو لا يحتوي على صفوف بيانات');
  const result = validateRows(req.ctx, req.body.type, rows);
  res.json({ type: req.body.type, file_name: req.file.originalname, ...result });
}));

/** تنفيذ الاستيراد فعلياً عبر طابور المعالجة الخلفية */
router.post('/imports/run', can('imports.manage'), upload.single('file'), ah(async (req, res) => {
  const def = IMPORT_TYPES[req.body?.type];
  if (!def) throw badRequest('نوع الاستيراد غير مدعوم');
  if (!req.file) throw badRequest('يرجى إرفاق الملف');
  const rows = readTabular(req.file);
  const check = validateRows(req.ctx, req.body.type, rows);
  if (!check.valid_rows.length) throw badRequest('لا توجد صفوف صالحة للاستيراد', check.errors);

  const batchId = db.prepare(`INSERT INTO import_batches(tenant_id,branch_id,type,file_name,total_rows,error_rows,errors,created_by)
    VALUES(?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, req.ctx.activeBranchId || req.ctx.primaryBranchId,
    req.body.type, req.file.originalname, check.total, check.errors.length,
    JSON.stringify(check.errors.slice(0, 200)), req.ctx.userId).lastInsertRowid;

  enqueue('data.import', {
    batchId, tenantId: req.ctx.tenantId, userId: req.ctx.userId,
    type: req.body.type, rows: check.valid_rows,
    branchId: req.ctx.activeBranchId || req.ctx.primaryBranchId
  }, { tenantId: req.ctx.tenantId });

  audit(req, { action: 'create', entity: 'import_batch', entityId: batchId,
    summary: `بدء استيراد ${def.label} — ${check.valid_rows.length} صف صالح من ${check.total}` });
  res.status(202).json({ batch_id: batchId, queued: check.valid_rows.length, skipped: check.errors.length });
}));

router.get('/imports', can('imports.manage'), ah(async (req, res) => {
  const rows = db.prepare(`SELECT b.*, u.name created_by_name FROM import_batches b
    LEFT JOIN users u ON u.id=b.created_by WHERE b.tenant_id=? ORDER BY b.id DESC LIMIT 50`).all(req.ctx.tenantId);
  res.json(rows.map(r => ({ ...r, errors: j(r.errors, []) })));
}));

router.get('/imports/:id', can('imports.manage'), ah(async (req, res) => {
  const b = findScoped(req.ctx, 'import_batches', req.params.id);
  if (!b) throw notFound('عملية الاستيراد غير موجودة');
  res.json({ ...b, errors: j(b.errors, []) });
}));

/* ═══════════════ ١٣. محرك التقارير والطباعة ═══════════════ */
router.get('/reports', can('reports.view'), ah(async (req, res) => {
  res.json(Object.entries(REPORTS).map(([key, r]) => ({
    key, label: r.label, description: r.description, module: r.module,
    filters: r.filters, permission: r.permission
  })));
}));

router.post('/reports/:key/run', can('reports.view'), ah(async (req, res) => {
  const def = REPORTS[req.params.key];
  if (!def) throw notFound('التقرير غير موجود');
  if (def.permission && !req.ctx.perms.includes(def.permission))
    throw badRequest('لا تملك صلاحية عرض هذا التقرير');
  const out = runReport(req.ctx, req.params.key, req.body?.filters || {});
  res.json({ key: req.params.key, label: def.label, ...out });
}));

/** التصدير الرسمي: PDF (عبر الطباعة) / Excel / CSV — البند ١٣ */
router.post('/reports/:key/export', can('reports.export'), ah(async (req, res) => {
  const def = REPORTS[req.params.key];
  if (!def) throw notFound('التقرير غير موجود');
  const format = (req.body?.format || 'xlsx').toLowerCase();
  const filters = req.body?.filters || {};
  const out = runReport(req.ctx, req.params.key, filters);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.ctx.tenantId);
  const fileBase = `${def.label}-${new Date().toISOString().slice(0, 10)}`;

  audit(req, { action: 'export', entity: 'report', entityId: req.params.key,
    summary: `${req.ctx.userName} صدّر تقرير "${def.label}" بصيغة ${format.toUpperCase()} (${out.rows.length} سجل)` });

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileBase + '.csv')}`);
    return res.send(toCSV(out.columns, out.rows));
  }
  if (format === 'xlsx') {
    const buf = buildXlsx([{ name: def.label.slice(0, 28), columns: out.columns, rows: out.rows }]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileBase + '.xlsx')}`);
    return res.send(buf);
  }
  // pdf / print → مستند رسمي مُروّس بشعار الجهة، يُحفظ PDF من المتصفح
  const html = buildReportHTML({
    tenant, title: def.label, subtitle: def.description,
    columns: out.columns, rows: out.rows, filters: out.applied_filters || [],
    summary: out.summary || [], calendar: req.ctx.calendarPref,
    generatedBy: req.ctx.userName, orientation: out.columns.length > 6 ? 'landscape' : 'portrait'
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

/* ═══════════════ ١٤. سجل النشاطات (Audit Log) ═══════════════ */
router.get('/audit', can('audit.view'), ah(async (req, res) => {
  const q = req.query;
  let sql = 'SELECT * FROM audit_logs WHERE tenant_id=?';
  const params = [req.ctx.tenantId];
  if (q.user_id) { sql += ' AND user_id=?'; params.push(Number(q.user_id)); }
  if (q.action) { sql += ' AND action=?'; params.push(q.action); }
  if (q.entity) { sql += ' AND entity=?'; params.push(q.entity); }
  if (q.from) { sql += ' AND created_at>=?'; params.push(q.from); }
  if (q.to) { sql += ' AND created_at<=?'; params.push(q.to + 'T23:59:59Z'); }
  if (q.q) { sql += ' AND (summary LIKE ? OR user_name LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`); }
  const limit = Math.min(500, Number(q.limit) || 100);
  const offset = Number(q.offset) || 0;
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) c')).get(...params).c;
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const rows = db.prepare(sql).all(...params, limit, offset);
  res.json({
    total, limit, offset,
    items: rows.map(r => ({ ...r, before: j(r.before_json, null), after: j(r.after_json, null) })),
    actions: db.prepare('SELECT DISTINCT action FROM audit_logs WHERE tenant_id=?').all(req.ctx.tenantId).map(a => a.action),
    entities: db.prepare('SELECT DISTINCT entity FROM audit_logs WHERE tenant_id=?').all(req.ctx.tenantId).map(a => a.entity)
  });
}));

/* ═══════════════ لوحة التحكم المركزية المجمّعة ═══════════════ */
router.get('/dashboard', ah(async (req, res) => {
  const ctx = req.ctx;
  const term = ctx.activeTermId ? findScoped(ctx, 'terms', ctx.activeTermId) : currentTerm(ctx.tenantId);
  const branchFilter = ctx.activeBranchId ? ' AND branch_id=' + ctx.activeBranchId : '';
  const sc = scoped(ctx, { alias: 't' });
  const termClause = term ? ' AND t.term_id=' + term.id : '';

  const tasks = db.prepare(`SELECT status, COUNT(*) c FROM tasks t WHERE ${sc.where}${termClause}
    ${ctx.activeBranchId ? 'AND t.branch_id=' + ctx.activeBranchId : ''} GROUP BY status`).all(...sc.params);
  const myTasks = db.prepare(`SELECT COUNT(*) c FROM tasks t WHERE ${sc.where} AND t.assignee_id=? AND t.status<>'done'`)
    .get(...sc.params, ctx.userId).c;
  const overdue = db.prepare(`SELECT COUNT(*) c FROM tasks t WHERE ${sc.where} AND t.status<>'done' AND t.due_date<date('now')`)
    .get(...sc.params).c;

  const fs = scoped(ctx, { alias: 'f' });
  const finance = db.prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(amount),0) total FROM finance_requests f
    WHERE ${fs.where} ${term ? 'AND f.term_id=' + term.id : ''} GROUP BY status`).all(...fs.params);

  const today = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);
  const as = scoped(ctx, { alias: 'a' });
  const attendance = db.prepare(`SELECT status, COUNT(*) c FROM attendance a WHERE ${as.where} AND a.date=? GROUP BY status`)
    .all(...as.params, today);

  const ts = scoped(ctx, { alias: 't' });
  const tickets = db.prepare(`SELECT status, COUNT(*) c FROM tickets t WHERE ${ts.where} GROUP BY status`).all(...ts.params);
  const breached = db.prepare(`SELECT COUNT(*) c FROM tickets t WHERE ${ts.where} AND t.status IN ('open','in_progress') AND t.sla_due_at < ?`)
    .get(...ts.params, nowUTC()).c;

  const branches = ctx.branchIds.length ? db.prepare(`SELECT b.id, b.name, b.code,
      (SELECT COUNT(*) FROM tasks t WHERE t.branch_id=b.id ${term ? 'AND t.term_id=' + term.id : ''}) tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.branch_id=b.id AND t.status='done' ${term ? 'AND t.term_id=' + term.id : ''}) tasks_done,
      (SELECT COUNT(*) FROM users u WHERE u.primary_branch_id=b.id AND u.status='active') staff,
      (SELECT COALESCE(SUM(amount),0) FROM finance_requests f WHERE f.branch_id=b.id AND f.status='approved' ${term ? 'AND f.term_id=' + term.id : ''}) spent
    FROM branches b WHERE b.tenant_id=? AND b.id IN (${ctx.branchIds.map(() => '?').join(',')}) AND b.is_active=1`)
    .all(ctx.tenantId, ...ctx.branchIds) : [];

  const recent = db.prepare(`SELECT id,user_name,action,entity,summary,created_at FROM audit_logs
    WHERE tenant_id=? ORDER BY id DESC LIMIT 8`).all(ctx.tenantId);

  const upcoming = db.prepare(`SELECT t.id,t.title,t.due_date,t.priority,t.status, u.name assignee_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE ${sc.where} AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date>=date('now')
    ORDER BY t.due_date LIMIT 6`).all(...sc.params);

  const budgets = db.prepare(`SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(spent),0) spent
    FROM budgets WHERE tenant_id=? ${term ? 'AND term_id=' + term.id : ''}`).get(ctx.tenantId);

  res.json({
    term, branch_id: ctx.activeBranchId || null,
    tasks: Object.fromEntries(tasks.map(t => [t.status, t.c])),
    tasks_total: tasks.reduce((s, t) => s + t.c, 0),
    my_open_tasks: myTasks, overdue,
    finance: Object.fromEntries(finance.map(f => [f.status, { count: f.c, total: f.total }])),
    attendance_today: Object.fromEntries(attendance.map(a => [a.status, a.c])),
    tickets: Object.fromEntries(tickets.map(t => [t.status, t.c])), tickets_sla_breached: breached,
    branches, recent_activity: recent, upcoming_tasks: upcoming, budgets
  });
}));

export default router;
