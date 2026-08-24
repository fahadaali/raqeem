import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, forbidden, locked, outOfRange, alreadyDone } from '../errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed } from '../scope.js';
import { haversine } from '../geo.js';
import { notifyUsers, notifyByPermission } from '../notify.js';
import { requireFeature } from '../features.js';

const router = new Hono();
const RIYADH_OFFSET_MIN = 180; // +03:00

const localDate = (iso = new Date()) =>
  new Date((iso instanceof Date ? iso : new Date(iso)).getTime() + RIYADH_OFFSET_MIN * 60000).toISOString().slice(0, 10);
function localMinutes(iso = new Date()) {
  const l = new Date((iso instanceof Date ? iso : new Date(iso)).getTime() + RIYADH_OFFSET_MIN * 60000);
  return l.getUTCHours() * 60 + l.getUTCMinutes();
}
const hhmmToMin = (s) => { const [hh, mm] = String(s || '07:30').split(':').map(Number); return hh * 60 + (mm || 0); };

/* ─────────────── زر التحضير الذكي (البند ٥) ─────────────── */
/*
 * كل وحدة فرعية تُحرَس بميزتها لا بميزة الوحدة الأم:
 * خطة قد تمنح الحضور دون مسير الرواتب — والعكس وارد في الصفقات المخصّصة.
 */
router.use('/attendance', requireFeature('attendance'));
router.use('/attendance/*', requireFeature('attendance'));
router.use('/employees', requireFeature('attendance'));
router.use('/employees/*', requireFeature('attendance'));
router.use('/leaves', requireFeature('attendance'));
router.use('/leaves/*', requireFeature('attendance'));
router.use('/advances', requireFeature('payroll'));
router.use('/advances/*', requireFeature('payroll'));

router.get('/attendance/today', can('hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const date = localDate();
  const row = await app.db.get('SELECT * FROM attendance WHERE tenant_id=? AND user_id=? AND date=?',
    req.ctx.tenantId, req.ctx.userId, date);
  const branchId = req.ctx.activeBranchId || req.ctx.primaryBranchId || req.ctx.branchIds[0];
  const branch = branchId
    ? await app.db.get('SELECT id,name,lat,lng,geofence_radius,address FROM branches WHERE id=? AND tenant_id=?', branchId, req.ctx.tenantId)
    : null;
  const settings = req.ctx.tenantSettings || {};
  return {
    date, record: row || null,
    next_action: !row || !row.check_in_at ? 'check_in' : (!row.check_out_at ? 'check_out' : 'done'),
    branch,
    geofence_radius: branch?.geofence_radius || app.cfg.geofenceDefault,
    workday: settings.workday || { start: '07:30', end: '13:30' },
    server_time: nowUTC()
  };
}));

router.post('/attendance/check', can('hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const { lat, lng, accuracy, branch_id } = req.body || {};
  if (lat === undefined || lng === undefined) throw badRequest('تعذّر تحديد موقعك، فعّل خدمة الموقع وأعد المحاولة');

  const branchId = branch_id ? await assertBranch(app, req.ctx, branch_id)
    : (req.ctx.activeBranchId || req.ctx.primaryBranchId || req.ctx.branchIds[0]);
  const branch = await app.db.get('SELECT * FROM branches WHERE id=? AND tenant_id=?', branchId, req.ctx.tenantId);
  if (!branch) throw badRequest('لم يتم تحديد الفرع الخاص بك، راجع الموارد البشرية');
  if (branch.lat == null || branch.lng == null) throw badRequest('لم تُضبط إحداثيات الفرع بعد، راجع الإدارة');

  const distance = haversine(Number(lat), Number(lng), branch.lat, branch.lng);
  const radius = branch.geofence_radius || app.cfg.geofenceDefault;
  if (distance > radius) {
    /* أرقامٌ عربية كما في بقية رسائل المنصة — والشارة فوق الخريطة بجانبها */
    const m = (n) => Number(n).toLocaleString('ar-SA');
    await audit(req, { action: 'reject', entity: 'attendance', branchId,
      summary: `محاولة تحضير مرفوضة — المسافة ${m(distance)}م تتجاوز نطاق الفرع (${m(radius)}م)` });
    throw outOfRange(
      `أنت خارج نطاق الفرع (${m(distance)} متراً من ${branch.name}). النطاق المسموح ${m(radius)} متراً.`,
      { distance, radius });
  }

  const term = await currentTerm(app, req.ctx.tenantId);
  if (term && await termIsClosed(app, req.ctx.tenantId, term.id)) throw locked();
  const date = localDate();
  const existing = await app.db.get('SELECT * FROM attendance WHERE tenant_id=? AND user_id=? AND date=?',
    req.ctx.tenantId, req.ctx.userId, date);
  const settings = req.ctx.tenantSettings || {};
  const startMin = hhmmToMin(settings.workday?.start || '07:30');
  const graceMin = Number(settings.late_after_minutes ?? 15);

  if (!existing) {
    const late = localMinutes() > startMin + graceMin;
    const r = await app.db.run(
      `INSERT INTO attendance(tenant_id,branch_id,term_id,user_id,date,check_in_at,in_lat,in_lng,in_distance,status)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      req.ctx.tenantId, branch.id, term?.id || null, req.ctx.userId, date, nowUTC(),
      Number(lat), Number(lng), distance, late ? 'late' : 'present');
    await audit(req, { action: 'create', entity: 'attendance', entityId: r.lastId, branchId: branch.id,
      summary: `${req.ctx.userName} سجّل الحضور في ${branch.name} (${distance}م)` });
    return { ok: true, action: 'check_in', distance, status: late ? 'late' : 'present',
      message: late ? 'تم تسجيل حضورك — مسجّل كتأخير' : 'تم تسجيل حضورك بنجاح، وفقك الله',
      record: await app.db.get('SELECT * FROM attendance WHERE id=?', r.lastId) };
  }

  if (existing.check_out_at) throw alreadyDone('تم تسجيل حضورك وانصرافك لهذا اليوم مسبقاً');

  const minutes = Math.max(0, Math.round((Date.now() - new Date(existing.check_in_at).getTime()) / 60000));
  await app.db.run('UPDATE attendance SET check_out_at=?,out_lat=?,out_lng=?,out_distance=?,minutes_worked=? WHERE id=?',
    nowUTC(), Number(lat), Number(lng), distance, minutes, existing.id);
  await audit(req, { action: 'update', entity: 'attendance', entityId: existing.id, branchId: branch.id,
    summary: `${req.ctx.userName} سجّل الانصراف من ${branch.name} — ${Math.floor(minutes / 60)} ساعة و${minutes % 60} دقيقة` });
  return { ok: true, action: 'check_out', distance, minutes,
    message: `تم تسجيل انصرافك — مدة العمل ${Math.floor(minutes / 60).toLocaleString('ar-SA')} ساعة و${(minutes % 60).toLocaleString('ar-SA')} دقيقة`,
    record: await app.db.get('SELECT * FROM attendance WHERE id=?', existing.id) };
}));

router.get('/attendance', can('hr.attendance.view', 'hr.attendance.self'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'a' });
  let sql = `SELECT a.*, u.name AS user_name, b.name AS branch_name, e.employee_no, e.job_title
    FROM attendance a JOIN users u ON u.id=a.user_id
    LEFT JOIN branches b ON b.id=a.branch_id
    LEFT JOIN employees e ON e.user_id=a.user_id AND e.tenant_id=a.tenant_id
    WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.attendance.view')) { sql += ' AND a.user_id=?'; params.push(req.ctx.userId); }
  const q = req.query;
  if (q.user_id) { sql += ' AND a.user_id=?'; params.push(Number(q.user_id)); }
  if (q.branch_id) { sql += ' AND a.branch_id=?'; params.push(Number(q.branch_id)); }
  if (q.from) { sql += ' AND a.date >= ?'; params.push(q.from); }
  if (q.to) { sql += ' AND a.date <= ?'; params.push(q.to); }
  if (q.status) { sql += ' AND a.status=?'; params.push(q.status); }
  sql += ' ORDER BY a.date DESC, u.name LIMIT ?';
  params.push(Math.min(2000, Number(q.limit) || 500));
  return req.app.db.all(sql, ...params);
}));

router.patch('/attendance/:id', can('hr.attendance.manage'), h(async (req) => {
  const app = req.app;
  const a = await findScoped(app, req.ctx, 'attendance', req.params.id, { branchCheck: true });
  if (!a) throw notFound('السجل غير موجود');
  if (await termIsClosed(app, req.ctx.tenantId, a.term_id)) throw locked();
  const p = req.body || {};
  await app.db.run('UPDATE attendance SET status=?, note=?, check_in_at=?, check_out_at=?, minutes_worked=? WHERE id=? AND tenant_id=?',
    p.status ?? a.status, p.note ?? a.note, p.check_in_at ?? a.check_in_at,
    p.check_out_at ?? a.check_out_at, p.minutes_worked ?? a.minutes_worked, a.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'attendance', entityId: a.id,
    summary: `تعديل يدوي لسجل حضور بتاريخ ${a.date}`, before: a, after: p });
  return { ok: true };
}));

/* ─────────────── ملفات الموظفين ─────────────── */
router.get('/employees', can('hr.employees.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'e' });
  return req.app.db.all(`SELECT e.*, u.name, u.email, u.phone, u.status AS user_status, u.avatar_url,
      b.name AS branch_name, r.name AS role_name
    FROM employees e JOIN users u ON u.id=e.user_id
    LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN roles r ON r.id=u.role_id
    WHERE ${sc.where} ORDER BY e.employee_no`, ...sc.params);
}));

router.get('/employees/:userId/file', can('hr.employees.view', 'hr.attendance.self'), h(async (req) => {
  const app = req.app;
  const userId = Number(req.params.userId);
  if (userId !== req.ctx.userId && !has(req.ctx, 'hr.employees.view')) throw forbidden();
  const emp = await app.db.get(
    `SELECT e.*, u.name,u.email,u.phone,u.avatar_url,u.national_id, b.name AS branch_name, r.name AS role_name
     FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN branches b ON b.id=e.branch_id
     LEFT JOIN roles r ON r.id=u.role_id WHERE e.tenant_id=? AND e.user_id=?`, req.ctx.tenantId, userId);
  if (!emp) throw notFound('ملف الموظف غير موجود');

  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const attendance = await app.db.all(
    `SELECT date,status,check_in_at,check_out_at,minutes_worked FROM attendance
     WHERE tenant_id=? AND user_id=? AND date>=? ORDER BY date DESC`, req.ctx.tenantId, userId, from);
  const summary = attendance.reduce((s, a) => { s[a.status] = (s[a.status] || 0) + 1; s.minutes += a.minutes_worked; return s; },
    { present: 0, late: 0, absent: 0, leave: 0, minutes: 0 });
  const leaves = await app.db.all('SELECT * FROM leaves WHERE tenant_id=? AND user_id=? ORDER BY start_date DESC LIMIT 30', req.ctx.tenantId, userId);
  const advances = await app.db.all('SELECT * FROM advances WHERE tenant_id=? AND user_id=? ORDER BY date DESC LIMIT 30', req.ctx.tenantId, userId);
  const payroll = await app.db.all(`SELECT pi.*, pr.year, pr.month, pr.status FROM payroll_items pi
    JOIN payroll_runs pr ON pr.id=pi.payroll_run_id WHERE pi.tenant_id=? AND pi.user_id=?
    ORDER BY pr.year DESC, pr.month DESC LIMIT 12`, req.ctx.tenantId, userId);
  const tasks = await app.db.get(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE tenant_id=? AND assignee_id=?`,
    req.ctx.tenantId, userId);
  const evals = await app.db.get(
    'SELECT AVG(score) AS avg_score, COUNT(*) AS c FROM form_submissions WHERE tenant_id=? AND subject_user_id=?',
    req.ctx.tenantId, userId);

  return { employee: emp, attendance, attendance_summary: summary, leaves, advances,
    payroll: payroll.map(p => ({ ...p, details: j(p.details, {}) })),
    tasks: { total: tasks.total || 0, done: tasks.done || 0 },
    evaluation: { avg: evals.avg_score ? Number(evals.avg_score.toFixed(1)) : null, count: evals.c } };
}));

router.post('/employees', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const p = req.body || {};
  if (!p.user_id) throw badRequest('يجب اختيار المستخدم');
  const bid = p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : req.ctx.primaryBranchId;
  await app.db.run(
    `INSERT INTO employees(tenant_id,branch_id,user_id,employee_no,job_title,department,contract_type,hire_date,contract_end,basic_salary,allowances,bank_iban)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,user_id) DO UPDATE SET job_title=excluded.job_title, department=excluded.department,
       basic_salary=excluded.basic_salary, allowances=excluded.allowances, branch_id=excluded.branch_id`,
    req.ctx.tenantId, bid, p.user_id, p.employee_no || null, p.job_title || null, p.department || null,
    p.contract_type || 'دوام كامل', p.hire_date || null, p.contract_end || null,
    Number(p.basic_salary) || 0, Number(p.allowances) || 0, p.bank_iban || null);
  await audit(req, { action: 'create', entity: 'employee', entityId: p.user_id, summary: `تحديث ملف موظف (${p.job_title || ''})` });
  return created({ ok: true });
}));

router.patch('/employees/:id', can('hr.employees.manage'), h(async (req) => {
  const app = req.app;
  const e = await findScoped(app, req.ctx, 'employees', req.params.id, { branchCheck: true });
  if (!e) throw notFound('ملف الموظف غير موجود');
  const p = req.body || {};
  await app.db.run(
    `UPDATE employees SET employee_no=?,job_title=?,department=?,contract_type=?,hire_date=?,contract_end=?,basic_salary=?,allowances=?,bank_iban=?,status=?,branch_id=? WHERE id=? AND tenant_id=?`,
    p.employee_no ?? e.employee_no, p.job_title ?? e.job_title, p.department ?? e.department,
    p.contract_type ?? e.contract_type, p.hire_date ?? e.hire_date, p.contract_end ?? e.contract_end,
    p.basic_salary ?? e.basic_salary, p.allowances ?? e.allowances, p.bank_iban ?? e.bank_iban,
    p.status ?? e.status, p.branch_id ? await assertBranch(app, req.ctx, p.branch_id) : e.branch_id, e.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'employee', entityId: e.id, summary: 'تعديل ملف موظف', before: e, after: p });
  return { ok: true };
}));

/* ─────────────── الإجازات والسلف ─────────────── */
router.get('/leaves', can('hr.leaves.request', 'hr.leaves.approve'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'l' });
  let sql = `SELECT l.*, u.name AS user_name, a.name AS approver_name FROM leaves l
    JOIN users u ON u.id=l.user_id LEFT JOIN users a ON a.id=l.approved_by WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.leaves.approve')) { sql += ' AND l.user_id=?'; params.push(req.ctx.userId); }
  if (req.query.status) { sql += ' AND l.status=?'; params.push(req.query.status); }
  sql += ' ORDER BY l.created_at DESC LIMIT 300';
  return req.app.db.all(sql, ...params);
}));

router.post('/leaves', can('hr.leaves.request'), h(async (req) => {
  const app = req.app;
  const { type, start_date, end_date, reason } = req.body || {};
  if (!start_date || !end_date) throw badRequest('تاريخا بداية ونهاية الإجازة إلزاميان');
  const days = Math.max(1, Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
  const term = await currentTerm(app, req.ctx.tenantId);
  const r = await app.db.run(
    `INSERT INTO leaves(tenant_id,branch_id,term_id,user_id,type,start_date,end_date,days,reason) VALUES(?,?,?,?,?,?,?,?,?)`,
    req.ctx.tenantId, req.ctx.primaryBranchId, term?.id || null, req.ctx.userId,
    type || 'annual', start_date, end_date, days, reason || null);
  await audit(req, { action: 'create', entity: 'leave', entityId: r.lastId, summary: `طلب إجازة ${days} يوم من ${start_date}` });
  await notifyByPermission(app, req.ctx.tenantId, 'hr.leaves.approve', {
    type: 'leave.requested', category: 'hr', title: 'طلب إجازة جديد',
    body: `${req.ctx.userName} — ${days} يوم ابتداءً من ${start_date}`, url: '/hr'
  }, { branchId: req.ctx.primaryBranchId });
  return created({ id: r.lastId, days });
}));

router.post('/leaves/:id/decide', can('hr.leaves.approve'), h(async (req) => {
  const app = req.app;
  const l = await findScoped(app, req.ctx, 'leaves', req.params.id, { branchCheck: true });
  if (!l) throw notFound('طلب الإجازة غير موجود');
  const approve = req.body?.action === 'approve';
  await app.db.run('UPDATE leaves SET status=?, approved_by=? WHERE id=? AND tenant_id=?',
    approve ? 'approved' : 'rejected', req.ctx.userId, l.id, req.ctx.tenantId);
  await audit(req, { action: approve ? 'approve' : 'reject', entity: 'leave', entityId: l.id,
    summary: `${req.ctx.userName} ${approve ? 'اعتمد' : 'رفض'} طلب إجازة (${l.days} يوم)` });
  await notifyUsers(app, req.ctx.tenantId, [l.user_id], {
    type: 'leave.decided', category: 'hr', title: approve ? 'تم اعتماد إجازتك' : 'تم رفض طلب إجازتك',
    body: `من ${l.start_date} إلى ${l.end_date}`, url: '/hr'
  });
  return { ok: true };
}));

router.get('/advances', can('hr.payroll.view', 'hr.attendance.self'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'a' });
  let sql = `SELECT a.*, u.name AS user_name FROM advances a JOIN users u ON u.id=a.user_id WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.payroll.view')) { sql += ' AND a.user_id=?'; params.push(req.ctx.userId); }
  sql += ' ORDER BY a.date DESC LIMIT 300';
  return req.app.db.all(sql, ...params);
}));

router.post('/advances', can('hr.payroll.manage'), h(async (req) => {
  const app = req.app;
  const { user_id, amount, reason, date, installments } = req.body || {};
  if (!user_id || !amount) throw badRequest('الموظف والمبلغ إلزاميان');
  const term = await currentTerm(app, req.ctx.tenantId);
  const r = await app.db.run(
    `INSERT INTO advances(tenant_id,branch_id,term_id,user_id,amount,remaining,installments,reason,date,status)
     VALUES(?,?,?,?,?,?,?,?,?,'approved')`,
    req.ctx.tenantId, req.ctx.primaryBranchId, term?.id || null, user_id,
    Number(amount), Number(amount), Number(installments) || 1, reason || null,
    date || new Date().toISOString().slice(0, 10));
  await audit(req, { action: 'create', entity: 'advance', entityId: r.lastId, summary: `تسجيل سلفة بمبلغ ${amount} ر.س` });
  await notifyUsers(app, req.ctx.tenantId, [user_id], {
    type: 'advance.created', category: 'hr', title: 'تم تسجيل سلفة',
    body: `بمبلغ ${Number(amount).toLocaleString('ar-SA')} ر.س وستُخصم من راتبك`, url: '/hr'
  });
  return created({ id: r.lastId });
}));

/* ─────────────── محرك احتساب الرواتب (البند ٥) ─────────────── */
router.use('/payroll', requireFeature('payroll'));
router.use('/payroll/*', requireFeature('payroll'));

router.get('/payroll', can('hr.payroll.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'p' });
  return req.app.db.all(`SELECT p.*, b.name AS branch_name, u.name AS generated_by_name,
      (SELECT COUNT(*) FROM payroll_items i WHERE i.payroll_run_id=p.id) AS items_count
    FROM payroll_runs p LEFT JOIN branches b ON b.id=p.branch_id LEFT JOIN users u ON u.id=p.generated_by
    WHERE ${sc.where} ORDER BY p.year DESC, p.month DESC`, ...sc.params);
}));

router.get('/payroll/:id', can('hr.payroll.view'), h(async (req) => {
  const app = req.app;
  const run = await findScoped(app, req.ctx, 'payroll_runs', req.params.id, { branchCheck: true });
  if (!run) throw notFound('مسير الرواتب غير موجود');
  const items = await app.db.all(`SELECT i.*, u.name AS user_name, e.employee_no, e.job_title, e.bank_iban
    FROM payroll_items i JOIN users u ON u.id=i.user_id
    LEFT JOIN employees e ON e.user_id=i.user_id AND e.tenant_id=i.tenant_id
    WHERE i.payroll_run_id=? ORDER BY u.name`, run.id);
  return { run, items: items.map(i => ({ ...i, details: j(i.details, {}) })) };
}));

router.post('/payroll/generate', can('hr.payroll.manage'), h(async (req) => {
  const app = req.app;
  const year = Number(req.body?.year) || new Date().getFullYear();
  const month = Number(req.body?.month) || (new Date().getMonth() + 1);
  const branchId = req.body?.branch_id ? await assertBranch(app, req.ctx, req.body.branch_id) : null;
  const term = await currentTerm(app, req.ctx.tenantId);
  const settings = req.ctx.tenantSettings || {};
  const workdayMinutes = 6 * 60;

  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-31`;

  let empSql = `SELECT e.*, u.name FROM employees e JOIN users u ON u.id=e.user_id WHERE e.tenant_id=? AND e.status='active'`;
  const empParams = [req.ctx.tenantId];
  if (branchId) { empSql += ' AND e.branch_id=?'; empParams.push(branchId); }
  else if (!req.ctx.allBranches && req.ctx.branchIds.length) {
    empSql += ` AND e.branch_id IN (${req.ctx.branchIds.map(() => '?').join(',')})`;
    empParams.push(...req.ctx.branchIds);
  }
  const employees = await app.db.all(empSql, ...empParams);
  if (!employees.length) throw badRequest('لا يوجد موظفون ضمن النطاق المحدد');

  const runRes = await app.db.run(
    `INSERT INTO payroll_runs(tenant_id,branch_id,term_id,year,month,status,generated_by) VALUES(?,?,?,?,?,'draft',?)`,
    req.ctx.tenantId, branchId, term?.id || null, year, month, req.ctx.userId);
  const runId = runRes.lastId;

  const INSERT_ITEM = `INSERT INTO payroll_items(tenant_id,payroll_run_id,user_id,basic,allowances,absence_deduction,late_deduction,advance_deduction,other_deduction,net,details)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`;
  const stmts = [];
  let total = 0;

  for (const e of employees) {
    const att = await app.db.all(
      `SELECT status, COUNT(*) AS c, SUM(minutes_worked) AS mins FROM attendance
       WHERE tenant_id=? AND user_id=? AND date BETWEEN ? AND ? GROUP BY status`,
      req.ctx.tenantId, e.user_id, from, to);
    const by = Object.fromEntries(att.map(a => [a.status, a.c]));
    const daily = (e.basic_salary + e.allowances) / 30;
    const absent = by.absent || 0;
    const late = by.late || 0;

    const leaveRow = await app.db.get(
      `SELECT COALESCE(SUM(days),0) AS d FROM leaves
       WHERE tenant_id=? AND user_id=? AND status='approved' AND start_date<=? AND end_date>=?`,
      req.ctx.tenantId, e.user_id, to, from);

    const absenceDeduction = Number((absent * daily * (settings.absence_deduction_per_day ?? 1)).toFixed(2));
    const lateDeduction = Number((late * (daily / workdayMinutes) * 30).toFixed(2));

    const adv = await app.db.all(
      `SELECT id, remaining, installments FROM advances WHERE tenant_id=? AND user_id=? AND status='approved' AND remaining>0`,
      req.ctx.tenantId, e.user_id);
    let advanceDeduction = 0;
    for (const a of adv) {
      const cut = Math.min(a.remaining, a.remaining / Math.max(1, a.installments));
      advanceDeduction += cut;
      stmts.push(['UPDATE advances SET remaining=remaining-? WHERE id=?', [cut, a.id]]);
    }
    advanceDeduction = Number(advanceDeduction.toFixed(2));

    const net = Number((e.basic_salary + e.allowances - absenceDeduction - lateDeduction - advanceDeduction).toFixed(2));
    total += net;
    stmts.push([INSERT_ITEM, [req.ctx.tenantId, runId, e.user_id, e.basic_salary, e.allowances,
      absenceDeduction, lateDeduction, advanceDeduction, 0, net,
      JSON.stringify({ present: by.present || 0, late, absent, leave: by.leave || 0,
        approved_leave_days: leaveRow.d, daily_rate: Number(daily.toFixed(2)) })]]);
  }
  stmts.push(['UPDATE payroll_runs SET total=? WHERE id=?', [Number(total.toFixed(2)), runId]]);
  await app.db.batch(stmts);

  await audit(req, { action: 'create', entity: 'payroll_run', entityId: runId,
    summary: `${req.ctx.userName} أنشأ مسير رواتب ${month}/${year} لعدد ${employees.length} موظف بإجمالي ${total.toFixed(2)} ر.س` });
  return created({ runId, total: Number(total.toFixed(2)), count: employees.length });
}));

router.post('/payroll/:id/approve', can('hr.payroll.manage'), h(async (req) => {
  const app = req.app;
  const run = await findScoped(app, req.ctx, 'payroll_runs', req.params.id, { branchCheck: true });
  if (!run) throw notFound('المسير غير موجود');
  const st = req.body?.status === 'paid' ? 'paid' : 'approved';
  await app.db.run('UPDATE payroll_runs SET status=? WHERE id=? AND tenant_id=?', st, run.id, req.ctx.tenantId);
  await audit(req, { action: 'approve', entity: 'payroll_run', entityId: run.id,
    summary: `اعتماد مسير رواتب ${run.month}/${run.year} بحالة ${st}` });
  if (st === 'paid') {
    const users = await app.db.all('SELECT user_id, net FROM payroll_items WHERE payroll_run_id=?', run.id);
    for (const u of users) {
      await notifyUsers(app, req.ctx.tenantId, [u.user_id], {
        type: 'payroll.paid', category: 'hr', title: 'تم صرف راتب الشهر',
        body: `صافي راتب ${run.month}/${run.year}: ${u.net.toLocaleString('ar-SA')} ر.س`, url: '/hr'
      });
    }
  }
  return { ok: true, status: st };
}));

export default router;
