import express from 'express';
import bcrypt from 'bcryptjs';
import db, { j, nowUTC } from '../db/index.js';
import { ah, badRequest, notFound, conflict, forbidden } from '../lib/errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped } from '../lib/scope.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { buildContext } from '../middleware/auth.js';
import { notifyUsers } from '../lib/notify.js';

const router = express.Router();

/* ─────────────────────────── إعدادات الجهة (تخصيص ديناميكي) ─────────────── */
router.get('/tenant', can('settings.view'), ah(async (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.ctx.tenantId);
  res.json({ ...t, settings: j(t.settings, {}) });
}));

router.patch('/tenant', can('settings.manage'), ah(async (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.ctx.tenantId);
  const { name, name_en, logo_url, primary_color, accent_color, calendar_default, settings } = req.body || {};
  db.prepare(`UPDATE tenants SET name=?,name_en=?,logo_url=?,primary_color=?,accent_color=?,calendar_default=?,settings=? WHERE id=?`)
    .run(name?.trim() || t.name, name_en ?? t.name_en, logo_url ?? t.logo_url,
      primary_color || t.primary_color, accent_color || t.accent_color,
      ['hijri', 'gregorian'].includes(calendar_default) ? calendar_default : t.calendar_default,
      settings ? JSON.stringify({ ...j(t.settings, {}), ...settings }) : t.settings, t.id);
  audit(req, { action: 'update', entity: 'tenant', entityId: t.id, summary: 'تحديث هوية وإعدادات الجهة التعليمية', before: { name: t.name }, after: { name } });
  const out = db.prepare('SELECT * FROM tenants WHERE id=?').get(t.id);
  res.json({ ...out, settings: j(out.settings, {}) });
}));

/* ─────────────────────────── الفروع ─────────────────────────────────────── */
router.get('/branches', can('branches.view', 'dashboard.view'), ah(async (req, res) => {
  const sc = scoped(req.ctx, { alias: 'b', branchColumn: 'id' });
  const rows = db.prepare(`SELECT b.*, u.name AS manager_name,
      (SELECT COUNT(*) FROM users x WHERE x.tenant_id=b.tenant_id AND x.primary_branch_id=b.id) AS users_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.tenant_id=b.tenant_id AND t.branch_id=b.id) AS tasks_count
    FROM branches b LEFT JOIN users u ON u.id=b.manager_user_id
    WHERE ${sc.where}
    ORDER BY b.code`).all(...sc.params);
  res.json(rows);
}));

router.post('/branches', can('branches.manage'), ah(async (req, res) => {
  const { code, name, address, lat, lng, geofence_radius, phone, manager_user_id } = req.body || {};
  if (!code || !name) throw badRequest('رمز الفرع واسمه حقلان إلزاميان');
  const dup = db.prepare('SELECT 1 FROM branches WHERE tenant_id=? AND code=?').get(req.ctx.tenantId, code);
  if (dup) throw conflict('يوجد فرع بنفس الرمز');
  const r = db.prepare(`INSERT INTO branches(tenant_id,code,name,address,lat,lng,geofence_radius,phone,manager_user_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(req.ctx.tenantId, code.trim(), name.trim(), address || null,
    lat ?? null, lng ?? null, Number(geofence_radius) || 50, phone || null, manager_user_id || null);
  audit(req, { action: 'create', entity: 'branch', entityId: r.lastInsertRowid, summary: `إنشاء فرع جديد: ${name}` });
  res.status(201).json(db.prepare('SELECT * FROM branches WHERE id=?').get(r.lastInsertRowid));
}));

router.patch('/branches/:id', can('branches.manage'), ah(async (req, res) => {
  const b = findScoped(req.ctx, 'branches', req.params.id);
  if (!b) throw notFound('الفرع غير موجود');
  const p = req.body || {};
  db.prepare(`UPDATE branches SET name=?,address=?,lat=?,lng=?,geofence_radius=?,phone=?,manager_user_id=?,is_active=? WHERE id=? AND tenant_id=?`)
    .run(p.name ?? b.name, p.address ?? b.address, p.lat ?? b.lat, p.lng ?? b.lng,
      p.geofence_radius ?? b.geofence_radius, p.phone ?? b.phone,
      p.manager_user_id ?? b.manager_user_id, p.is_active ?? b.is_active, b.id, req.ctx.tenantId);
  audit(req, { action: 'update', entity: 'branch', entityId: b.id, summary: `تعديل بيانات الفرع: ${b.name}`, before: b, after: p });
  res.json(db.prepare('SELECT * FROM branches WHERE id=?').get(b.id));
}));

router.delete('/branches/:id', can('branches.manage'), ah(async (req, res) => {
  const b = findScoped(req.ctx, 'branches', req.params.id);
  if (!b) throw notFound('الفرع غير موجود');
  db.prepare('UPDATE branches SET is_active=0 WHERE id=? AND tenant_id=?').run(b.id, req.ctx.tenantId);
  audit(req, { action: 'delete', entity: 'branch', entityId: b.id, summary: `تعطيل الفرع: ${b.name}` });
  res.json({ ok: true });
}));

/* ─────────────────────────── الأدوار والصلاحيات (RBAC) ──────────────────── */
router.get('/permissions', can('roles.view', 'settings.view'), ah(async (req, res) => {
  const grouped = {};
  for (const p of PERMISSIONS) (grouped[p.module] ||= []).push(p);
  res.json({ list: PERMISSIONS, grouped });
}));

router.get('/roles', can('roles.view', 'users.view'), ah(async (req, res) => {
  const roles = db.prepare('SELECT * FROM roles WHERE tenant_id=? ORDER BY level, id').all(req.ctx.tenantId);
  const perms = db.prepare('SELECT role_id, permission_key FROM role_permissions WHERE tenant_id=?').all(req.ctx.tenantId);
  const counts = db.prepare('SELECT role_id, COUNT(*) c FROM users WHERE tenant_id=? GROUP BY role_id').all(req.ctx.tenantId);
  res.json(roles.map(r => ({
    ...r,
    permissions: perms.filter(p => p.role_id === r.id).map(p => p.permission_key),
    users_count: counts.find(c => c.role_id === r.id)?.c || 0
  })));
}));

router.post('/roles', can('roles.manage'), ah(async (req, res) => {
  const { key, name, description, level, permissions } = req.body || {};
  if (!key || !name) throw badRequest('مفتاح الدور واسمه إلزاميان');
  if (db.prepare('SELECT 1 FROM roles WHERE tenant_id=? AND key=?').get(req.ctx.tenantId, key)) throw conflict('الدور موجود مسبقاً');
  const r = db.prepare('INSERT INTO roles(tenant_id,key,name,description,level) VALUES(?,?,?,?,?)')
    .run(req.ctx.tenantId, key.trim(), name.trim(), description || null, Number(level) || 10);
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission_key) VALUES(?,?,?)');
  for (const p of permissions || []) ins.run(req.ctx.tenantId, r.lastInsertRowid, p);
  audit(req, { action: 'create', entity: 'role', entityId: r.lastInsertRowid, summary: `إنشاء دور جديد: ${name}` });
  res.status(201).json({ id: r.lastInsertRowid });
}));

router.put('/roles/:id/permissions', can('roles.manage'), ah(async (req, res) => {
  const role = findScoped(req.ctx, 'roles', req.params.id);
  if (!role) throw notFound('الدور غير موجود');
  if (role.key === 'owner') throw forbidden('لا يمكن تعديل صلاحيات دور مدير الجهة');
  const list = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const valid = new Set(PERMISSIONS.map(p => p.key));
  const before = db.prepare('SELECT permission_key FROM role_permissions WHERE role_id=?').all(role.id).map(r => r.permission_key);
  db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(role.id);
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission_key) VALUES(?,?,?)');
    for (const p of list) if (valid.has(p)) ins.run(req.ctx.tenantId, role.id, p);
  })();
  audit(req, { action: 'update', entity: 'role', entityId: role.id, summary: `تعديل صلاحيات الدور: ${role.name}`, before: { permissions: before }, after: { permissions: list } });
  res.json({ ok: true, permissions: list });
}));

/* ─────────────────────────── المستخدمون ─────────────────────────────────── */
router.get('/users', can('users.view'), ah(async (req, res) => {
  const { q, role_id, branch_id, status } = req.query;
  let sql = `SELECT u.id,u.name,u.email,u.phone,u.status,u.primary_branch_id,u.role_id,u.last_login_at,u.created_at,u.avatar_url,
                    r.key role_key, r.name role_name, b.name branch_name,
                    e.employee_no, e.job_title, e.department
             FROM users u JOIN roles r ON r.id=u.role_id
             LEFT JOIN branches b ON b.id=u.primary_branch_id
             LEFT JOIN employees e ON e.user_id=u.id AND e.tenant_id=u.tenant_id
             WHERE u.tenant_id=?`;
  const params = [req.ctx.tenantId];
  if (!req.ctx.allBranches) {
    const ids = req.ctx.branchIds.length ? req.ctx.branchIds : [-1];
    sql += ` AND (u.primary_branch_id IN (${ids.map(() => '?').join(',')}) OR u.primary_branch_id IS NULL)`;
    params.push(...ids);
  }
  if (q) { sql += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (role_id) { sql += ' AND u.role_id=?'; params.push(Number(role_id)); }
  if (branch_id) { sql += ' AND u.primary_branch_id=?'; params.push(Number(branch_id)); }
  if (status) { sql += ' AND u.status=?'; params.push(status); }
  sql += ' ORDER BY r.level, u.name';
  const rows = db.prepare(sql).all(...params);
  const ub = db.prepare('SELECT user_id, branch_id FROM user_branches WHERE tenant_id=?').all(req.ctx.tenantId);
  res.json(rows.map(u => ({ ...u, branch_ids: ub.filter(x => x.user_id === u.id).map(x => x.branch_id) })));
}));

router.post('/users', can('users.manage'), ah(async (req, res) => {
  const { name, email, phone, password, role_id, primary_branch_id, branch_ids, national_id } = req.body || {};
  if (!name || !email || !role_id) throw badRequest('الاسم والبريد والدور حقول إلزامية');
  if (!password || String(password).length < 8) throw badRequest('كلمة المرور يجب أن تكون ٨ أحرف فأكثر');
  if (db.prepare('SELECT 1 FROM users WHERE tenant_id=? AND lower(email)=lower(?)').get(req.ctx.tenantId, email)) throw conflict('البريد الإلكتروني مستخدم مسبقاً');
  const role = findScoped(req.ctx, 'roles', role_id);
  if (!role) throw badRequest('الدور غير صالح');
  if (role.level < req.ctx.roleLevel) throw forbidden('لا يمكنك إنشاء مستخدم بصلاحية أعلى من صلاحيتك');
  const pb = primary_branch_id ? assertBranch(req.ctx, primary_branch_id) : null;

  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO users(tenant_id,name,email,phone,national_id,password_hash,role_id,primary_branch_id,must_change_pw)
      VALUES(?,?,?,?,?,?,?,?,1)`).run(req.ctx.tenantId, name.trim(), String(email).trim().toLowerCase(),
      phone || null, national_id || null, bcrypt.hashSync(String(password), 10), role.id, pb);
    const uid = r.lastInsertRowid;
    const ins = db.prepare('INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)');
    const list = Array.isArray(branch_ids) && branch_ids.length ? branch_ids : (pb ? [pb] : []);
    for (const b of list) ins.run(req.ctx.tenantId, uid, assertBranch(req.ctx, b));
    return uid;
  })();

  audit(req, { action: 'create', entity: 'user', entityId: id, summary: `${req.ctx.userName} أنشأ حساب المستخدم (${name}) بدور ${role.name}` });
  await notifyUsers(req.ctx.tenantId, [id], {
    type: 'account.created', category: 'system', title: 'أهلاً بك في منصة نور',
    body: `تم إنشاء حسابك بدور "${role.name}". يُرجى تغيير كلمة المرور عند أول دخول.`, url: '/settings'
  });
  res.status(201).json({ id });
}));

router.patch('/users/:id', can('users.manage'), ah(async (req, res) => {
  const u = findScoped(req.ctx, 'users', req.params.id);
  if (!u) throw notFound('المستخدم غير موجود');
  const p = req.body || {};
  if (p.role_id) {
    const role = findScoped(req.ctx, 'roles', p.role_id);
    if (!role) throw badRequest('الدور غير صالح');
    if (role.level < req.ctx.roleLevel) throw forbidden('لا يمكنك منح صلاحية أعلى من صلاحيتك');
  }
  db.prepare(`UPDATE users SET name=?,email=?,phone=?,role_id=?,primary_branch_id=?,status=?,national_id=? WHERE id=? AND tenant_id=?`)
    .run(p.name ?? u.name, (p.email ?? u.email).toLowerCase(), p.phone ?? u.phone,
      p.role_id ?? u.role_id, p.primary_branch_id !== undefined ? (p.primary_branch_id ? assertBranch(req.ctx, p.primary_branch_id) : null) : u.primary_branch_id,
      p.status ?? u.status, p.national_id ?? u.national_id, u.id, req.ctx.tenantId);
  if (Array.isArray(p.branch_ids)) {
    db.prepare('DELETE FROM user_branches WHERE tenant_id=? AND user_id=?').run(req.ctx.tenantId, u.id);
    const ins = db.prepare('INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)');
    for (const b of p.branch_ids) ins.run(req.ctx.tenantId, u.id, assertBranch(req.ctx, b));
  }
  if (p.password) {
    if (String(p.password).length < 8) throw badRequest('كلمة المرور يجب أن تكون ٨ أحرف فأكثر');
    db.prepare('UPDATE users SET password_hash=?, must_change_pw=1 WHERE id=?').run(bcrypt.hashSync(String(p.password), 10), u.id);
    db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?').run(u.id);
  }
  audit(req, { action: 'update', entity: 'user', entityId: u.id, summary: `تعديل بيانات المستخدم (${u.name})`, before: { name: u.name, role_id: u.role_id, status: u.status }, after: p });
  res.json({ ok: true });
}));

router.delete('/users/:id', can('users.manage'), ah(async (req, res) => {
  const u = findScoped(req.ctx, 'users', req.params.id);
  if (!u) throw notFound('المستخدم غير موجود');
  if (u.id === req.ctx.userId) throw badRequest('لا يمكنك إيقاف حسابك الشخصي');
  db.prepare("UPDATE users SET status='suspended' WHERE id=? AND tenant_id=?").run(u.id, req.ctx.tenantId);
  db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?').run(u.id);
  audit(req, { action: 'delete', entity: 'user', entityId: u.id, summary: `إيقاف حساب المستخدم (${u.name})` });
  res.json({ ok: true });
}));

export default router;
