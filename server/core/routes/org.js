import { Hono } from 'hono';
import { j, nowUTC } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, conflict, forbidden } from '../errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { scoped, assertBranch, findScoped } from '../scope.js';
import { PERMISSIONS } from '../permissions.js';
import { hashPassword } from '../crypto.js';
import { notifyUsers } from '../notify.js';
import { runLogicalBackup } from '../jobs/backup.js';

const router = new Hono();

/* ─────────────── إعدادات الجهة (التخصيص الديناميكي) ─────────────── */
router.get('/tenant', can('settings.view'), h(async (req) => {
  const t = await req.app.db.get('SELECT * FROM tenants WHERE id=?', req.ctx.tenantId);
  return { ...t, settings: j(t.settings, {}) };
}));

router.patch('/tenant', can('settings.manage'), h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.ctx.tenantId);
  const { name, name_en, logo_url, primary_color, accent_color, calendar_default, settings } = req.body || {};
  await app.db.run(
    `UPDATE tenants SET name=?,name_en=?,logo_url=?,primary_color=?,accent_color=?,calendar_default=?,settings=? WHERE id=?`,
    name?.trim() || t.name, name_en ?? t.name_en, logo_url ?? t.logo_url,
    primary_color || t.primary_color, accent_color || t.accent_color,
    ['hijri', 'gregorian'].includes(calendar_default) ? calendar_default : t.calendar_default,
    settings ? JSON.stringify({ ...(j(t.settings, {}) || {}), ...settings }) : t.settings, t.id);
  await audit(req, { action: 'update', entity: 'tenant', entityId: t.id,
    summary: 'تحديث هوية وإعدادات الجهة التعليمية', before: { name: t.name }, after: { name } });
  const out = await app.db.get('SELECT * FROM tenants WHERE id=?', t.id);
  return { ...out, settings: j(out.settings, {}) };
}));

/* ─────────────── الفروع ─────────────── */
router.get('/branches', can('branches.view', 'dashboard.view'), h(async (req) => {
  const sc = scoped(req.ctx, { alias: 'b', branchColumn: 'id' });
  return req.app.db.all(`SELECT b.*, u.name AS manager_name,
      (SELECT COUNT(*) FROM users x WHERE x.tenant_id=b.tenant_id AND x.primary_branch_id=b.id) AS users_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.tenant_id=b.tenant_id AND t.branch_id=b.id) AS tasks_count
    FROM branches b LEFT JOIN users u ON u.id=b.manager_user_id
    WHERE ${sc.where} ORDER BY b.code`, ...sc.params);
}));

router.post('/branches', can('branches.manage'), h(async (req) => {
  const app = req.app;
  const { code, name, address, lat, lng, geofence_radius, phone, manager_user_id } = req.body || {};
  if (!code || !name) throw badRequest('رمز الفرع واسمه حقلان إلزاميان');
  if (await app.db.get('SELECT 1 AS x FROM branches WHERE tenant_id=? AND code=?', req.ctx.tenantId, code))
    throw conflict('يوجد فرع بنفس الرمز');
  const r = await app.db.run(
    `INSERT INTO branches(tenant_id,code,name,address,lat,lng,geofence_radius,phone,manager_user_id)
     VALUES(?,?,?,?,?,?,?,?,?)`, req.ctx.tenantId, String(code).trim(), String(name).trim(), address || null,
    lat ?? null, lng ?? null, Number(geofence_radius) || 50, phone || null, manager_user_id || null);
  await audit(req, { action: 'create', entity: 'branch', entityId: r.lastId, summary: `إنشاء فرع جديد: ${name}` });
  return created(await app.db.get('SELECT * FROM branches WHERE id=?', r.lastId));
}));

router.patch('/branches/:id', can('branches.manage'), h(async (req) => {
  const app = req.app;
  const b = await findScoped(app, req.ctx, 'branches', req.params.id);
  if (!b) throw notFound('الفرع غير موجود');
  if (!req.ctx.allBranches && !req.ctx.branchIds.includes(b.id)) throw forbidden('ليست لديك صلاحية على هذا الفرع');
  const p = req.body || {};
  await app.db.run(
    `UPDATE branches SET name=?,address=?,lat=?,lng=?,geofence_radius=?,phone=?,manager_user_id=?,is_active=? WHERE id=? AND tenant_id=?`,
    p.name ?? b.name, p.address ?? b.address, p.lat ?? b.lat, p.lng ?? b.lng,
    p.geofence_radius ?? b.geofence_radius, p.phone ?? b.phone,
    p.manager_user_id ?? b.manager_user_id, p.is_active ?? b.is_active, b.id, req.ctx.tenantId);
  await audit(req, { action: 'update', entity: 'branch', entityId: b.id,
    summary: `تعديل بيانات الفرع: ${b.name}`, before: b, after: p });
  return app.db.get('SELECT * FROM branches WHERE id=?', b.id);
}));

router.delete('/branches/:id', can('branches.manage'), h(async (req) => {
  const b = await findScoped(req.app, req.ctx, 'branches', req.params.id);
  if (!b) throw notFound('الفرع غير موجود');
  await req.app.db.run('UPDATE branches SET is_active=0 WHERE id=? AND tenant_id=?', b.id, req.ctx.tenantId);
  await audit(req, { action: 'delete', entity: 'branch', entityId: b.id, summary: `تعطيل الفرع: ${b.name}` });
  return { ok: true };
}));

/* ─────────────── الأدوار والصلاحيات (RBAC) ─────────────── */
router.get('/permissions', can('roles.view', 'settings.view'), h(async () => {
  const grouped = {};
  for (const p of PERMISSIONS) (grouped[p.module] ||= []).push(p);
  return { list: PERMISSIONS, grouped };
}));

router.get('/roles', can('roles.view', 'users.view'), h(async (req) => {
  const app = req.app;
  const roles = await app.db.all('SELECT * FROM roles WHERE tenant_id=? ORDER BY level, id', req.ctx.tenantId);
  const perms = await app.db.all('SELECT role_id, permission_key FROM role_permissions WHERE tenant_id=?', req.ctx.tenantId);
  const counts = await app.db.all('SELECT role_id, COUNT(*) AS c FROM users WHERE tenant_id=? GROUP BY role_id', req.ctx.tenantId);
  return roles.map(r => ({
    ...r,
    permissions: perms.filter(p => p.role_id === r.id).map(p => p.permission_key),
    users_count: counts.find(c => c.role_id === r.id)?.c || 0
  }));
}));

router.post('/roles', can('roles.manage'), h(async (req) => {
  const app = req.app;
  const { key, name, description, level, permissions } = req.body || {};
  if (!key || !name) throw badRequest('مفتاح الدور واسمه إلزاميان');
  if (await app.db.get('SELECT 1 AS x FROM roles WHERE tenant_id=? AND key=?', req.ctx.tenantId, key))
    throw conflict('الدور موجود مسبقاً');
  const r = await app.db.run('INSERT INTO roles(tenant_id,key,name,description,level) VALUES(?,?,?,?,?)',
    req.ctx.tenantId, String(key).trim(), String(name).trim(), description || null, Number(level) || 10);
  const valid = new Set(PERMISSIONS.map(p => p.key));
  const list = (permissions || []).filter(p => valid.has(p));
  if (list.length) await app.db.batch(list.map(p =>
    ['INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission_key) VALUES(?,?,?)', [req.ctx.tenantId, r.lastId, p]]));
  await audit(req, { action: 'create', entity: 'role', entityId: r.lastId, summary: `إنشاء دور جديد: ${name}` });
  return created({ id: r.lastId });
}));

router.put('/roles/:id/permissions', can('roles.manage'), h(async (req) => {
  const app = req.app;
  const role = await findScoped(app, req.ctx, 'roles', req.params.id);
  if (!role) throw notFound('الدور غير موجود');
  if (role.key === 'owner') throw forbidden('لا يمكن تعديل صلاحيات دور مدير الجهة');
  const list = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const valid = new Set(PERMISSIONS.map(p => p.key));
  const before = (await app.db.all('SELECT permission_key FROM role_permissions WHERE role_id=?', role.id))
    .map(r => r.permission_key);

  await app.db.batch([
    ['DELETE FROM role_permissions WHERE role_id=?', [role.id]],
    ...list.filter(p => valid.has(p)).map(p =>
      ['INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission_key) VALUES(?,?,?)', [req.ctx.tenantId, role.id, p]])
  ]);
  await audit(req, { action: 'update', entity: 'role', entityId: role.id,
    summary: `تعديل صلاحيات الدور: ${role.name}`, before: { permissions: before }, after: { permissions: list } });
  return { ok: true, permissions: list };
}));

/* ─────────────── المستخدمون ─────────────── */
router.get('/users', can('users.view'), h(async (req) => {
  const app = req.app;
  const { q, role_id, branch_id, status } = req.query;
  let sql = `SELECT u.id,u.name,u.email,u.phone,u.status,u.primary_branch_id,u.role_id,u.last_login_at,u.created_at,u.avatar_url,
                    r.key AS role_key, r.name AS role_name, b.name AS branch_name,
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

  const rows = await app.db.all(sql, ...params);
  const ub = await app.db.all('SELECT user_id, branch_id FROM user_branches WHERE tenant_id=?', req.ctx.tenantId);
  return rows.map(u => ({ ...u, branch_ids: ub.filter(x => x.user_id === u.id).map(x => x.branch_id) }));
}));

router.post('/users', can('users.manage'), h(async (req) => {
  const app = req.app;
  const { name, email, phone, password, role_id, primary_branch_id, branch_ids, national_id } = req.body || {};
  if (!name || !email || !role_id) throw badRequest('الاسم والبريد والدور حقول إلزامية');
  if (!password || String(password).length < 8) throw badRequest('كلمة المرور يجب أن تكون ٨ أحرف فأكثر');
  if (await app.db.get('SELECT 1 AS x FROM users WHERE tenant_id=? AND lower(email)=lower(?)', req.ctx.tenantId, email))
    throw conflict('البريد الإلكتروني مستخدم مسبقاً');
  const role = await findScoped(app, req.ctx, 'roles', role_id);
  if (!role) throw badRequest('الدور غير صالح');
  if (role.level < req.ctx.roleLevel) throw forbidden('لا يمكنك إنشاء مستخدم بصلاحية أعلى من صلاحيتك');
  const pb = primary_branch_id ? await assertBranch(app, req.ctx, primary_branch_id) : null;

  const list = Array.isArray(branch_ids) && branch_ids.length ? branch_ids : (pb ? [pb] : []);
  const allowedBranches = [];
  for (const b of list) allowedBranches.push(await assertBranch(app, req.ctx, b));

  const r = await app.db.run(
    `INSERT INTO users(tenant_id,name,email,phone,national_id,password_hash,role_id,primary_branch_id,must_change_pw)
     VALUES(?,?,?,?,?,?,?,?,1)`,
    req.ctx.tenantId, String(name).trim(), String(email).trim().toLowerCase(), phone || null,
    national_id || null, await hashPassword(String(password)), role.id, pb);
  const uid = r.lastId;
  if (allowedBranches.length) await app.db.batch(allowedBranches.map(b =>
    ['INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)', [req.ctx.tenantId, uid, b]]));

  await audit(req, { action: 'create', entity: 'user', entityId: uid,
    summary: `${req.ctx.userName} أنشأ حساب المستخدم (${name}) بدور ${role.name}` });
  await notifyUsers(app, req.ctx.tenantId, [uid], {
    type: 'account.created', category: 'system', title: 'أهلاً بك في منصة نور',
    body: `تم إنشاء حسابك بدور "${role.name}". يُرجى تغيير كلمة المرور عند أول دخول.`, url: '/settings'
  });
  return created({ id: uid });
}));

router.patch('/users/:id', can('users.manage'), h(async (req) => {
  const app = req.app;
  const u = await findScoped(app, req.ctx, 'users', req.params.id);
  if (!u) throw notFound('المستخدم غير موجود');
  const p = req.body || {};
  if (p.role_id) {
    const role = await findScoped(app, req.ctx, 'roles', p.role_id);
    if (!role) throw badRequest('الدور غير صالح');
    if (role.level < req.ctx.roleLevel) throw forbidden('لا يمكنك منح صلاحية أعلى من صلاحيتك');
  }
  const pb = p.primary_branch_id !== undefined
    ? (p.primary_branch_id ? await assertBranch(app, req.ctx, p.primary_branch_id) : null)
    : u.primary_branch_id;

  await app.db.run(
    `UPDATE users SET name=?,email=?,phone=?,role_id=?,primary_branch_id=?,status=?,national_id=? WHERE id=? AND tenant_id=?`,
    p.name ?? u.name, String(p.email ?? u.email).toLowerCase(), p.phone ?? u.phone,
    p.role_id ?? u.role_id, pb, p.status ?? u.status, p.national_id ?? u.national_id, u.id, req.ctx.tenantId);

  if (Array.isArray(p.branch_ids)) {
    const branches = [];
    for (const b of p.branch_ids) branches.push(await assertBranch(app, req.ctx, b));
    await app.db.batch([
      ['DELETE FROM user_branches WHERE tenant_id=? AND user_id=?', [req.ctx.tenantId, u.id]],
      ...branches.map(b => ['INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)', [req.ctx.tenantId, u.id, b]])
    ]);
  }
  if (p.password) {
    if (String(p.password).length < 8) throw badRequest('كلمة المرور يجب أن تكون ٨ أحرف فأكثر');
    await app.db.batch([
      ['UPDATE users SET password_hash=?, must_change_pw=1 WHERE id=?', [await hashPassword(String(p.password)), u.id]],
      ['UPDATE refresh_tokens SET revoked=1 WHERE user_id=?', [u.id]]
    ]);
  }
  await audit(req, { action: 'update', entity: 'user', entityId: u.id,
    summary: `تعديل بيانات المستخدم (${u.name})`,
    before: { name: u.name, role_id: u.role_id, status: u.status }, after: p });
  return { ok: true };
}));

router.delete('/users/:id', can('users.manage'), h(async (req) => {
  const app = req.app;
  const u = await findScoped(app, req.ctx, 'users', req.params.id);
  if (!u) throw notFound('المستخدم غير موجود');
  if (u.id === req.ctx.userId) throw badRequest('لا يمكنك إيقاف حسابك الشخصي');
  await app.db.batch([
    [`UPDATE users SET status='suspended' WHERE id=? AND tenant_id=?`, [u.id, req.ctx.tenantId]],
    ['UPDATE refresh_tokens SET revoked=1 WHERE user_id=?', [u.id]]
  ]);
  await audit(req, { action: 'delete', entity: 'user', entityId: u.id, summary: `إيقاف حساب المستخدم (${u.name})` });
  return { ok: true };
}));

/* ─────────────── النسخ الاحتياطي (البند ١٠) ─────────────── */
router.get('/backups', can('settings.manage'), h(async (req) => {
  const st = req.app.storage;
  if (!st?.list) return { driver: st?.driver || 'غير مربوط', automatic: false, items: [] };
  const prefix = `tenants/${req.ctx.tenantId}/backups/`;
  const stamp = (name) => {
    const m = name.match(/^noor-(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})\.sql\.gz$/);
    return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
  };
  const keys = (await st.list(prefix)).sort().reverse();
  return {
    driver: st.driver,
    automatic: req.app.cfg.backup.enabled,
    keep: req.app.cfg.backup.keep,
    items: keys.map(k => { const name = k.slice(prefix.length); return { key: k, name, created_at: stamp(name) }; })
  };
}));

router.post('/backups', can('settings.manage'), h(async (req) => {
  const out = await runLogicalBackup(req.app, { tenantId: req.ctx.tenantId });
  if (out.skipped) throw badRequest(out.skipped);
  await audit(req, { action: 'export', entity: 'backup', entityId: out.key,
    summary: `${req.ctx.userName} أنشأ نسخة احتياطية يدوية (${out.rows} سجل من ${out.tables} جدول)` });
  return created(out);
}));

router.get('/backups/:name/download', can('settings.manage'), h(async (req) => {
  const name = String(req.params.name);
  if (!/^noor-[\d-]+\.sql\.gz$/.test(name)) throw badRequest('اسم ملف غير صالح');
  const key = `tenants/${req.ctx.tenantId}/backups/${name}`;
  const data = await req.app.storage.get(key);
  if (!data) throw notFound('النسخة غير موجودة');
  await audit(req, { action: 'export', entity: 'backup', entityId: key,
    summary: `${req.ctx.userName} نزّل النسخة الاحتياطية ${name}` });
  return new Response(data, { headers: {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${name}"`
  } });
}));

export default router;
