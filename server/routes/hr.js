import express from 'express';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound, forbidden, locked } from '../lib/errors.js';
import { can, has } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped, currentTerm, termIsClosed } from '../lib/scope.js';
import { haversine } from '../lib/geo.js';
import { notifyUsers, notifyByPermission } from '../lib/notify.js';
import config from '../config.js';

const router = express.Router();
const RIYADH_OFFSET_MIN = 180; // +03:00

/** التاريخ المحلي للجهة (الرياض) من طابع UTC */
function localDate(iso = new Date()) {
  const d = iso instanceof Date ? iso : new Date(iso);
  return new Date(d.getTime() + RIYADH_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
function localMinutes(iso = new Date()) {
  const d = iso instanceof Date ? iso : new Date(iso);
  const l = new Date(d.getTime() + RIYADH_OFFSET_MIN * 60000);
  return l.getUTCHours() * 60 + l.getUTCMinutes();
}
const hhmmToMin = (s) => { const [h, m] = String(s || '07:30').split(':').map(Number); return h * 60 + (m || 0); };

/* ─────────────────────────── زر التحضير الذكي (البند ٥) ─────────────────── */
router.get('/attendance/today', can('hr.attendance.self'), ah(async (req, res) => {
  const date = localDate();
  const row = db.prepare('SELECT * FROM attendance WHERE tenant_id=? AND user_id=? AND date=?')
    .get(req.ctx.tenantId, req.ctx.userId, date);
  const branchId = req.ctx.activeBranchId || req.ctx.primaryBranchId || req.ctx.branchIds[0];
  const branch = branchId ? db.prepare('SELECT id,name,lat,lng,geofence_radius,address FROM branches WHERE id=? AND tenant_id=?')
    .get(branchId, req.ctx.tenantId) : null;
  const settings = req.ctx.tenantSettings || {};
  res.json({
    date,
    record: row || null,
    next_action: !row || !row.check_in_at ? 'check_in' : (!row.check_out_at ? 'check_out' : 'done'),
    branch,
    geofence_radius: branch?.geofence_radius || config.geofenceDefault,
    workday: settings.workday || { start: '07:30', end: '13:30' },
    server_time: nowUTC()
  });
}));

router.post('/attendance/check', can('hr.attendance.self'), ah(async (req, res) => {
  const { lat, lng, accuracy, branch_id } = req.body || {};
  if (lat === undefined || lng === undefined) throw badRequest('تعذّر تحديد موقعك، فعّل خدمة الموقع وأعد المحاولة');

  const branchId = branch_id ? assertBranch(req.ctx, branch_id)
    : (req.ctx.activeBranchId || req.ctx.primaryBranchId || req.ctx.branchIds[0]);
  const branch = db.prepare('SELECT * FROM branches WHERE id=? AND tenant_id=?').get(branchId, req.ctx.tenantId);
  if (!branch) throw badRequest('لم يتم تحديد الفرع الخاص بك، راجع الموارد البشرية');
  if (branch.lat == null || branch.lng == null) throw badRequest('لم تُضبط إحداثيات الفرع بعد، راجع الإدارة');

  const distance = haversine(Number(lat), Number(lng), branch.lat, branch.lng);
  const radius = branch.geofence_radius || config.geofenceDefault;
  if (distance > radius) {
    audit(req, { action: 'reject', entity: 'attendance', summary: `محاولة تحضير مرفوضة — المسافة ${distance}م تتجاوز نطاق الفرع (${radius}م)`, branchId });
    return res.status(422).json({
      ok: false, code: 'OUT_OF_RANGE', distance, radius,
      message: `أنت خارج نطاق الفرع (${distance} متراً من ${branch.name}). النطاق المسموح ${radius} متراً.`
    });
  }

  const term = currentTerm(req.ctx.tenantId);
  if (term && termIsClosed(req.ctx.tenantId, term.id)) throw locked();
  const date = localDate();
  const existing = db.prepare('SELECT * FROM attendance WHERE tenant_id=? AND user_id=? AND date=?')
    .get(req.ctx.tenantId, req.ctx.userId, date);
  const settings = req.ctx.tenantSettings || {};
  const startMin = hhmmToMin(settings.workday?.start || '07:30');
  const graceMin = Number(settings.late_after_minutes ?? 15);

  if (!existing) {
    const late = localMinutes() > startMin + graceMin;
    const r = db.prepare(`INSERT INTO attendance(tenant_id,branch_id,term_id,user_id,date,check_in_at,in_lat,in_lng,in_distance,status)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, branch.id, term?.id || null, req.ctx.userId,
      date, nowUTC(), Number(lat), Number(lng), distance, late ? 'late' : 'present');
    audit(req, { action: 'create', entity: 'attendance', entityId: r.lastInsertRowid, branchId: branch.id,
      summary: `${req.ctx.userName} سجّل الحضور في ${branch.name} (${distance}م)` });
    return res.json({ ok: true, action: 'check_in', distance, status: late ? 'late' : 'present',
      message: late ? 'تم تسجيل حضورك — مسجّل كتأخير' : 'تم تسجيل حضورك بنجاح، وفقك الله',
      record: db.prepare('SELECT * FROM attendance WHERE id=?').get(r.lastInsertRowid) });
  }

  if (existing.check_out_at) return res.status(409).json({ ok: false, code: 'ALREADY_DONE', message: 'تم تسجيل حضورك وانصرافك لهذا اليوم مسبقاً' });

  const minutes = Math.max(0, Math.round((Date.now() - new Date(existing.check_in_at).getTime()) / 60000));
  db.prepare(`UPDATE attendance SET check_out_at=?,out_lat=?,out_lng=?,out_distance=?,minutes_worked=? WHERE id=?`)
    .run(nowUTC(), Number(lat), Number(lng), distance, minutes, existing.id);
  audit(req, { action: 'update', entity: 'attendance', entityId: existing.id, branchId: branch.id,
    summary: `${req.ctx.userName} سجّل الانصراف من ${branch.name} — ${Math.floor(minutes / 60)}س ${minutes % 60}د` });
  res.json({ ok: true, action: 'check_out', distance, minutes,
    message: `تم تسجيل انصرافك — مدة العمل ${Math.floor(minutes / 60).toLocaleString('ar-SA')} ساعة و${(minutes % 60).toLocaleString('ar-SA')} دقيقة`,
    record: db.prepare('SELECT * FROM attendance WHERE id=?').get(existing.id) });
}));

router.get('/attendance', can('hr.attendance.view', 'hr.attendance.self'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'a' });
  let sql = `SELECT a.*, u.name user_name, b.name branch_name, e.employee_no, e.job_title
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
  sql += ' ORDER BY a.date DESC, u.name LIMIT ' + Math.min(2000, Number(q.limit) || 500);
  res.json(db.prepare(sql).all(...params));
}));

router.patch('/attendance/:id', can('hr.attendance.manage'), ah(async (req, res) => {
  const a = findScoped(req.ctx, 'attendance', req.params.id, { branchCheck: true });
  if (!a) throw notFound('السجل غير موجود');
  if (termIsClosed(req.ctx.tenantId, a.term_id)) throw locked();
  const p = req.body || {};
  db.prepare('UPDATE attendance SET status=?, note=?, check_in_at=?, check_out_at=?, minutes_worked=? WHERE id=? AND tenant_id=?')
    .run(p.status ?? a.status, p.note ?? a.note, p.check_in_at ?? a.check_in_at,
      p.check_out_at ?? a.check_out_at, p.minutes_worked ?? a.minutes_worked, a.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'attendance', entityId: a.id, summary: `تعديل يدوي لسجل حضور بتاريخ ${a.date}`, before: a, after: p });
  res.json({ ok: true });
}));

/* ─────────────────────────── ملف الموظف الشامل ──────────────────────────── */
router.get('/employees', can('hr.employees.view'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'e' });
  const rows = db.prepare(`SELECT e.*, u.name, u.email, u.phone, u.status user_status, u.avatar_url,
      b.name branch_name, r.name role_name
    FROM employees e JOIN users u ON u.id=e.user_id
    LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN roles r ON r.id=u.role_id
    WHERE ${sc.where} ORDER BY e.employee_no`).all(...sc.params);
  res.json(rows);
}));

router.get('/employees/:userId/file', can('hr.employees.view', 'hr.attendance.self'), ah(async (req, res) => {
  const userId = Number(req.params.userId);
  if (userId !== req.ctx.userId && !has(req.ctx, 'hr.employees.view')) throw forbidden();
  const emp = db.prepare(`SELECT e.*, u.name,u.email,u.phone,u.avatar_url,u.national_id, b.name branch_name, r.name role_name
    FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN branches b ON b.id=e.branch_id
    LEFT JOIN roles r ON r.id=u.role_id WHERE e.tenant_id=? AND e.user_id=?`).get(req.ctx.tenantId, userId);
  if (!emp) throw notFound('ملف الموظف غير موجود');

  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const attendance = db.prepare(`SELECT date,status,check_in_at,check_out_at,minutes_worked
    FROM attendance WHERE tenant_id=? AND user_id=? AND date>=? ORDER BY date DESC`).all(req.ctx.tenantId, userId, from);
  const summary = attendance.reduce((s, a) => { s[a.status] = (s[a.status] || 0) + 1; s.minutes += a.minutes_worked; return s; },
    { present: 0, late: 0, absent: 0, leave: 0, minutes: 0 });
  const leaves = db.prepare('SELECT * FROM leaves WHERE tenant_id=? AND user_id=? ORDER BY start_date DESC LIMIT 30').all(req.ctx.tenantId, userId);
  const advances = db.prepare('SELECT * FROM advances WHERE tenant_id=? AND user_id=? ORDER BY date DESC LIMIT 30').all(req.ctx.tenantId, userId);
  const payroll = db.prepare(`SELECT pi.*, pr.year, pr.month, pr.status FROM payroll_items pi
    JOIN payroll_runs pr ON pr.id=pi.payroll_run_id WHERE pi.tenant_id=? AND pi.user_id=?
    ORDER BY pr.year DESC, pr.month DESC LIMIT 12`).all(req.ctx.tenantId, userId);
  const tasks = db.prepare(`SELECT COUNT(*) total, SUM(status='done') done FROM tasks WHERE tenant_id=? AND assignee_id=?`)
    .get(req.ctx.tenantId, userId);
  const evals = db.prepare(`SELECT AVG(score) avg_score, COUNT(*) c FROM form_submissions
    WHERE tenant_id=? AND subject_user_id=?`).get(req.ctx.tenantId, userId);

  res.json({ employee: emp, attendance, attendance_summary: summary, leaves, advances,
    payroll: payroll.map(p => ({ ...p, details: j(p.details, {}) })),
    tasks: { total: tasks.total || 0, done: tasks.done || 0 },
    evaluation: { avg: evals.avg_score ? Number(evals.avg_score.toFixed(1)) : null, count: evals.c } });
}));

router.post('/employees', can('hr.employees.manage'), ah(async (req, res) => {
  const p = req.body || {};
  if (!p.user_id) throw badRequest('يجب اختيار المستخدم');
  const bid = p.branch_id ? assertBranch(req.ctx, p.branch_id) : req.ctx.primaryBranchId;
  const r = db.prepare(`INSERT INTO employees(tenant_id,branch_id,user_id,employee_no,job_title,department,contract_type,hire_date,contract_end,basic_salary,allowances,bank_iban)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,user_id) DO UPDATE SET job_title=excluded.job_title, department=excluded.department,
      basic_salary=excluded.basic_salary, allowances=excluded.allowances, branch_id=excluded.branch_id`).run(
    req.ctx.tenantId, bid, p.user_id, p.employee_no || null, p.job_title || null, p.department || null,
    p.contract_type || 'دوام كامل', p.hire_date || null, p.contract_end || null,
    Number(p.basic_salary) || 0, Number(p.allowances) || 0, p.bank_iban || null);
  audit(req, { action: 'create', entity: 'employee', entityId: r.lastInsertRowid, summary: `تحديث ملف موظف (${p.job_title || ''})` });
  res.status(201).json({ ok: true });
}));

router.patch('/employees/:id', can('hr.employees.manage'), ah(async (req, res) => {
  const e = findScoped(req.ctx, 'employees', req.params.id, { branchCheck: true });
  if (!e) throw notFound('ملف الموظف غير موجود');
  const p = req.body || {};
  db.prepare(`UPDATE employees SET employee_no=?,job_title=?,department=?,contract_type=?,hire_date=?,contract_end=?,basic_salary=?,allowances=?,bank_iban=?,status=?,branch_id=? WHERE id=? AND tenant_id=?`)
    .run(p.employee_no ?? e.employee_no, p.job_title ?? e.job_title, p.department ?? e.department,
      p.contract_type ?? e.contract_type, p.hire_date ?? e.hire_date, p.contract_end ?? e.contract_end,
      p.basic_salary ?? e.basic_salary, p.allowances ?? e.allowances, p.bank_iban ?? e.bank_iban,
      p.status ?? e.status, p.branch_id ? assertBranch(req.ctx, p.branch_id) : e.branch_id, e.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'employee', entityId: e.id, summary: 'تعديل ملف موظف', before: e, after: p });
  res.json({ ok: true });
}));

/* ─────────────────────────── الإجازات والسلف ────────────────────────────── */
router.get('/leaves', can('hr.leaves.request', 'hr.leaves.approve'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'l' });
  let sql = `SELECT l.*, u.name user_name, a.name approver_name FROM leaves l
    JOIN users u ON u.id=l.user_id LEFT JOIN users a ON a.id=l.approved_by WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.leaves.approve')) { sql += ' AND l.user_id=?'; params.push(req.ctx.userId); }
  if (req.query.status) { sql += ' AND l.status=?'; params.push(req.query.status); }
  sql += ' ORDER BY l.created_at DESC LIMIT 300';
  res.json(db.prepare(sql).all(...params));
}));

router.post('/leaves', can('hr.leaves.request'), ah(async (req, res) => {
  const { type, start_date, end_date, reason } = req.body || {};
  if (!start_date || !end_date) throw badRequest('تاريخا بداية ونهاية الإجازة إلزاميان');
  const days = Math.max(1, Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
  const term = currentTerm(req.ctx.tenantId);
  const r = db.prepare(`INSERT INTO leaves(tenant_id,branch_id,term_id,user_id,type,start_date,end_date,days,reason)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, req.ctx.primaryBranchId, term?.id || null,
    req.ctx.userId, type || 'annual', start_date, end_date, days, reason || null);
  audit(req, { action: 'create', entity: 'leave', entityId: r.lastInsertRowid, summary: `طلب إجازة ${days} يوم من ${start_date}` });
  await notifyByPermission(req.ctx.tenantId, 'hr.leaves.approve', {
    type: 'leave.requested', category: 'hr', title: 'طلب إجازة جديد',
    body: `${req.ctx.userName} — ${days} يوم ابتداءً من ${start_date}`, url: '/hr'
  }, { branchId: req.ctx.primaryBranchId });
  res.status(201).json({ id: r.lastInsertRowid, days });
}));

router.post('/leaves/:id/decide', can('hr.leaves.approve'), ah(async (req, res) => {
  const l = findScoped(req.ctx, 'leaves', req.params.id, { branchCheck: true });
  if (!l) throw notFound('طلب الإجازة غير موجود');
  const approve = req.body?.action === 'approve';
  db.prepare('UPDATE leaves SET status=?, approved_by=? WHERE id=? AND tenant_id=?')
    .run(approve ? 'approved' : 'rejected', req.ctx.userId, l.id, req.ctx.tenantId);
  audit(req, { action: approve ? 'approve' : 'reject', entity: 'leave', entityId: l.id,
    summary: `${req.ctx.userName} ${approve ? 'اعتمد' : 'رفض'} طلب إجازة (${l.days} يوم)` });
  await notifyUsers(req.ctx.tenantId, [l.user_id], {
    type: 'leave.decided', category: 'hr', title: approve ? 'تم اعتماد إجازتك' : 'تم رفض طلب إجازتك',
    body: `من ${l.start_date} إلى ${l.end_date}`, url: '/hr'
  });
  res.json({ ok: true });
}));

router.get('/advances', can('hr.payroll.view', 'hr.attendance.self'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'a' });
  let sql = `SELECT a.*, u.name user_name FROM advances a JOIN users u ON u.id=a.user_id WHERE ${sc.where}`;
  const params = [...sc.params];
  if (!has(req.ctx, 'hr.payroll.view')) { sql += ' AND a.user_id=?'; params.push(req.ctx.userId); }
  sql += ' ORDER BY a.date DESC LIMIT 300';
  res.json(db.prepare(sql).all(...params));
}));

router.post('/advances', can('hr.payroll.manage'), ah(async (req, res) => {
  const { user_id, amount, reason, date, installments } = req.body || {};
  if (!user_id || !amount) throw badRequest('الموظف والمبلغ إلزاميان');
  const term = currentTerm(req.ctx.tenantId);
  const r = db.prepare(`INSERT INTO advances(tenant_id,branch_id,term_id,user_id,amount,remaining,installments,reason,date,status)
    VALUES(?,?,?,?,?,?,?,?,?,'approved')`).run(req.ctx.tenantId, req.ctx.primaryBranchId, term?.id || null,
    user_id, Number(amount), Number(amount), Number(installments) || 1, reason || null,
    date || new Date().toISOString().slice(0, 10));
  audit(req, { action: 'create', entity: 'advance', entityId: r.lastInsertRowid, summary: `تسجيل سلفة بمبلغ ${amount} ر.س` });
  await notifyUsers(req.ctx.tenantId, [user_id], {
    type: 'advance.created', category: 'hr', title: 'تم تسجيل سلفة',
    body: `بمبلغ ${Number(amount).toLocaleString('ar-SA')} ر.س وستُخصم من راتبك`, url: '/hr'
  });
  res.status(201).json({ id: r.lastInsertRowid });
}));

/* ─────────────────────────── محرك احتساب الرواتب (البند ٥) ──────────────── */
router.get('/payroll', can('hr.payroll.view'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'p' });
  const runs = db.prepare(`SELECT p.*, b.name branch_name, u.name generated_by_name,
      (SELECT COUNT(*) FROM payroll_items i WHERE i.payroll_run_id=p.id) items_count
    FROM payroll_runs p LEFT JOIN branches b ON b.id=p.branch_id LEFT JOIN users u ON u.id=p.generated_by
    WHERE ${sc.where} ORDER BY p.year DESC, p.month DESC`).all(...sc.params);
  res.json(runs);
}));

router.get('/payroll/:id', can('hr.payroll.view'), ah(async (req, res) => {
  const run = findScoped(req.ctx, 'payroll_runs', req.params.id, { branchCheck: true });
  if (!run) throw notFound('مسير الرواتب غير موجود');
  const items = db.prepare(`SELECT i.*, u.name user_name, e.employee_no, e.job_title, e.bank_iban
    FROM payroll_items i JOIN users u ON u.id=i.user_id
    LEFT JOIN employees e ON e.user_id=i.user_id AND e.tenant_id=i.tenant_id
    WHERE i.payroll_run_id=? ORDER BY u.name`).all(run.id);
  res.json({ run, items: items.map(i => ({ ...i, details: j(i.details, {}) })) });
}));

router.post('/payroll/generate', can('hr.payroll.manage'), ah(async (req, res) => {
  const year = Number(req.body?.year) || new Date().getFullYear();
  const month = Number(req.body?.month) || (new Date().getMonth() + 1);
  const branchId = req.body?.branch_id ? assertBranch(req.ctx, req.body.branch_id) : null;
  const term = currentTerm(req.ctx.tenantId);
  const settings = req.ctx.tenantSettings || {};
  const workdayMinutes = 6 * 60;

  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-31`;

  let empSql = 'SELECT e.*, u.name FROM employees e JOIN users u ON u.id=e.user_id WHERE e.tenant_id=? AND e.status=\'active\'';
  const empParams = [req.ctx.tenantId];
  if (branchId) { empSql += ' AND e.branch_id=?'; empParams.push(branchId); }
  else if (!req.ctx.allBranches && req.ctx.branchIds.length) {
    empSql += ` AND e.branch_id IN (${req.ctx.branchIds.map(() => '?').join(',')})`;
    empParams.push(...req.ctx.branchIds);
  }
  const employees = db.prepare(empSql).all(...empParams);
  if (!employees.length) throw badRequest('لا يوجد موظفون ضمن النطاق المحدد');

  const result = db.transaction(() => {
    const runId = db.prepare(`INSERT INTO payroll_runs(tenant_id,branch_id,term_id,year,month,status,generated_by)
      VALUES(?,?,?,?,?,'draft',?)`).run(req.ctx.tenantId, branchId, term?.id || null, year, month, req.ctx.userId).lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO payroll_items(tenant_id,payroll_run_id,user_id,basic,allowances,absence_deduction,late_deduction,advance_deduction,other_deduction,net,details)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    let total = 0;

    for (const e of employees) {
      const att = db.prepare(`SELECT status, COUNT(*) c, SUM(minutes_worked) mins FROM attendance
        WHERE tenant_id=? AND user_id=? AND date BETWEEN ? AND ? GROUP BY status`)
        .all(req.ctx.tenantId, e.user_id, from, to);
      const by = Object.fromEntries(att.map(a => [a.status, a.c]));
      const daily = (e.basic_salary + e.allowances) / 30;
      const absent = by.absent || 0;
      const late = by.late || 0;

      const approvedLeaveDays = db.prepare(`SELECT COALESCE(SUM(days),0) d FROM leaves
        WHERE tenant_id=? AND user_id=? AND status='approved' AND start_date<=? AND end_date>=?`)
        .get(req.ctx.tenantId, e.user_id, to, from).d;

      const absenceDeduction = Number((absent * daily * (settings.absence_deduction_per_day ?? 1)).toFixed(2));
      const lateDeduction = Number((late * (daily / workdayMinutes) * 30).toFixed(2)); // ٣٠ دقيقة تأخير معيارية

      const adv = db.prepare(`SELECT id, remaining, installments FROM advances
        WHERE tenant_id=? AND user_id=? AND status='approved' AND remaining>0`).all(req.ctx.tenantId, e.user_id);
      let advanceDeduction = 0;
      for (const a of adv) {
        const cut = Math.min(a.remaining, a.remaining / Math.max(1, a.installments));
        advanceDeduction += cut;
        db.prepare('UPDATE advances SET remaining=remaining-? WHERE id=?').run(cut, a.id);
      }
      advanceDeduction = Number(advanceDeduction.toFixed(2));

      const net = Number((e.basic_salary + e.allowances - absenceDeduction - lateDeduction - advanceDeduction).toFixed(2));
      total += net;
      insItem.run(req.ctx.tenantId, runId, e.user_id, e.basic_salary, e.allowances,
        absenceDeduction, lateDeduction, advanceDeduction, 0, net,
        JSON.stringify({ present: by.present || 0, late, absent, leave: by.leave || 0, approved_leave_days: approvedLeaveDays, daily_rate: Number(daily.toFixed(2)) }));
    }
    db.prepare('UPDATE payroll_runs SET total=? WHERE id=?').run(Number(total.toFixed(2)), runId);
    return { runId, total: Number(total.toFixed(2)), count: employees.length };
  })();

  audit(req, { action: 'create', entity: 'payroll_run', entityId: result.runId,
    summary: `${req.ctx.userName} أنشأ مسير رواتب ${month}/${year} لعدد ${result.count} موظف بإجمالي ${result.total} ر.س` });
  res.status(201).json(result);
}));

router.post('/payroll/:id/approve', can('hr.payroll.manage'), ah(async (req, res) => {
  const run = findScoped(req.ctx, 'payroll_runs', req.params.id, { branchCheck: true });
  if (!run) throw notFound('المسير غير موجود');
  const status = req.body?.status === 'paid' ? 'paid' : 'approved';
  db.prepare('UPDATE payroll_runs SET status=? WHERE id=? AND tenant_id=?').run(status, run.id, req.ctx.tenantId);
  audit(req, { action: 'approve', entity: 'payroll_run', entityId: run.id, summary: `اعتماد مسير رواتب ${run.month}/${run.year} بحالة ${status}` });
  if (status === 'paid') {
    const users = db.prepare('SELECT user_id, net FROM payroll_items WHERE payroll_run_id=?').all(run.id);
    for (const u of users) {
      await notifyUsers(req.ctx.tenantId, [u.user_id], {
        type: 'payroll.paid', category: 'hr', title: 'تم صرف راتب الشهر',
        body: `صافي راتب ${run.month}/${run.year}: ${u.net.toLocaleString('ar-SA')} ر.س`, url: '/hr'
      });
    }
  }
  res.json({ ok: true, status });
}));

export default router;
