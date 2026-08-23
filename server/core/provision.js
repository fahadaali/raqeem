import { nowUTC } from './sql.js';
import { hashPassword } from './crypto.js';
import { PERMISSIONS, DEFAULT_ROLES } from './permissions.js';
import { badRequest, conflict } from './errors.js';
import { startSubscription } from './billing.js';
import { termsForNewTenant } from './term-templates.js';

/**
 * تجهيز جهة تعليمية جديدة (المرحلة الثانية — التسجيل الآلي).
 * ينشئ المستأجر بأدواره وصلاحياته وفرعه الأول وفصله الجاري وحساب مديره،
 * ثم يفتح له الاشتراك. يعمل على SQLite و D1 بالشيفرة نفسها لأن كل الكتابة
 * تمرّ على الواجهة غير المتزامنة الموحّدة.
 */

const CODE_RE = /^[A-Z][A-Z0-9-]{1,11}$/;

export function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export function validateCode(raw) {
  const code = normalizeCode(raw);
  if (!CODE_RE.test(code)) {
    throw badRequest('رمز الجهة يبدأ بحرف إنجليزي ويتكوّن من ٢ إلى ١٢ حرفاً/رقماً إنجليزياً أو شرطة');
  }
  return code;
}

const RESERVED = new Set(['ADMIN', 'API', 'WWW', 'APP', 'PLATFORM', 'RQM', 'SUPPORT',
  'BILLING', 'STATUS', 'HELP', 'DOCS', 'MAIL', 'ROOT', 'SYSTEM', 'TEST']);

export async function codeAvailable(app, raw) {
  const code = normalizeCode(raw);
  if (!CODE_RE.test(code) || RESERVED.has(code)) return { code, available: false, reserved: RESERVED.has(code) };
  const taken = await app.db.get('SELECT id FROM tenants WHERE code=?', code);
  return { code, available: !taken, reserved: false };
}

export async function emailAvailable(app, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return { email: e, available: false, invalid: true };
  const taken = await app.db.get('SELECT id FROM users WHERE lower(email)=?', e);
  return { email: e, available: !taken, invalid: false };
}

/**
 * ينشئ جهة كاملة جاهزة للعمل.
 * @returns {Promise<{tenant, owner, subscription}>}
 */
export async function provisionTenant(app, {
  code, name, nameEn = null, adminName, email, password, passwordHash = null, phone = null,
  planCode = null, cycle = 'monthly', trialDays = null, subscriptionStatus = null,
  primaryColor = '#2F8A6F', accentColor = '#E8A25C', branchName = null, timezone = 'Asia/Riyadh'
} = {}) {
  const db = app.db;
  const tenantCode = validateCode(code);
  const mail = String(email || '').trim().toLowerCase();

  const check = await emailAvailable(app, mail);
  if (check.invalid) throw badRequest('البريد الإلكتروني غير صالح');
  if (!check.available) throw conflict('البريد الإلكتروني مستخدم في المنصة مسبقاً');
  if (await db.get('SELECT id FROM tenants WHERE code=?', tenantCode)) throw conflict('رمز الجهة مستخدم مسبقاً');
  if (!String(name || '').trim()) throw badRequest('اسم الجهة التعليمية إلزامي');
  if (!String(adminName || '').trim()) throw badRequest('اسم مدير الجهة إلزامي');
  if (!passwordHash && String(password || '').length < 8) throw badRequest('كلمة المرور يجب ألا تقل عن ٨ خانات');

  /* ── كتالوج الصلاحيات عام على مستوى المنصة ── */
  await db.batch(PERMISSIONS.map(p => [
    `INSERT INTO permissions(key,module,name) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET module=excluded.module, name=excluded.name`, [p.key, p.module, p.name]]));

  /* ── المستأجر ── */
  const t = await db.run(
    `INSERT INTO tenants(code,name,name_en,primary_color,accent_color,timezone,locale,
       calendar_default,plan,status,owner_email,settings)
     VALUES(?,?,?,?,?,?,'ar','hijri',?, 'active', ?, ?)`,
    tenantCode, String(name).trim(), nameEn, primaryColor, accentColor, timezone,
    planCode || 'trial', mail,
    JSON.stringify({
      workday: { start: '07:30', end: '13:30', days: [0, 1, 2, 3, 4] },
      late_after_minutes: 15, absence_deduction_per_day: 1, ticket_sla_hours: 24, vat_rate: 15
    }));
  const T = t.lastId;

  /* ── الأدوار وصلاحياتها ── */
  const roleIds = {};
  for (const r of DEFAULT_ROLES) {
    const res = await db.run(
      `INSERT INTO roles(tenant_id,key,name,description,level,is_system) VALUES(?,?,?,?,?,?)`,
      T, r.key, r.name, r.description, r.level, r.is_system);
    roleIds[r.key] = res.lastId;
    await db.batch(r.permissions.map(p =>
      ['INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission_key) VALUES(?,?,?)', [T, res.lastId, p]]));
  }

  /* ── الفرع الأول ── */
  const branch = await db.run(
    `INSERT INTO branches(tenant_id,code,name,address,geofence_radius,is_active)
     VALUES(?,?,?,?,?,1)`,
    T, 'B01', branchName || `${String(name).trim()} — الفرع الرئيسي`, null, 50);

  /* ── الفصول الدراسية من قوالب المنصة ── */
  for (const t of await termsForNewTenant(app)) {
    await db.run(
      `INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current)
       VALUES(?,?,?,?,?, 'open', ?)`,
      T, t.code, t.name, t.start_date, t.end_date, t.is_current ? 1 : 0);
  }

  /* ── حساب مدير الجهة ── */
  const hash = passwordHash || await hashPassword(String(password));
  const owner = await db.run(
    `INSERT INTO users(tenant_id,name,email,phone,password_hash,role_id,primary_branch_id,status,calendar_pref)
     VALUES(?,?,?,?,?,?,?,'active','hijri')`,
    T, String(adminName).trim(), mail, phone, hash, roleIds.owner, branch.lastId);
  await db.run('INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)',
    T, owner.lastId, branch.lastId);

  /* ── الاشتراك ── */
  let subscription = null;
  if (planCode) {
    subscription = await startSubscription(app, T, { planCode, cycle, trialDays, status: subscriptionStatus });
  }

  await db.run(
    `INSERT INTO platform_logs(actor_id,actor_name,tenant_id,action,entity,entity_id,summary,meta,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    null, 'النظام', T, 'create', 'tenant', String(T),
    `تجهيز جهة جديدة «${String(name).trim()}» برمز ${tenantCode}`,
    JSON.stringify({ plan: planCode, cycle }), nowUTC());

  return {
    tenant: await db.get('SELECT * FROM tenants WHERE id=?', T),
    owner: await db.get('SELECT id,name,email FROM users WHERE id=?', owner.lastId),
    branchId: branch.lastId,
    subscription
  };
}

/**
 * حذف جهة كاملة ببياناتها وملفاتها — عملية لا رجعة فيها.
 * تعتمد على ON DELETE CASCADE في المخطط، وتنظّف مجلد التخزين المعزول.
 */
export async function purgeTenant(app, tenantId) {
  const tenant = await app.db.get('SELECT * FROM tenants WHERE id=?', tenantId);
  if (!tenant) throw badRequest('الجهة غير موجودة');
  if (Number(tenantId) === 1) throw badRequest('لا يمكن حذف الجهة رقم ١ (جهة التشغيل الأساسية)');

  const counts = {
    users: (await app.db.get('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?', tenantId)).c,
    branches: (await app.db.get('SELECT COUNT(*) AS c FROM branches WHERE tenant_id=?', tenantId)).c,
    audit_logs: (await app.db.get('SELECT COUNT(*) AS c FROM audit_logs WHERE tenant_id=?', tenantId)).c,
    files: (await app.db.get('SELECT COUNT(*) AS c FROM files WHERE tenant_id=?', tenantId)).c
  };

  /* أثر المحو يُسجَّل قبل تنفيذه في سجل المنصة غير القابل للتعديل */
  await app.db.run(
    `INSERT INTO platform_logs(actor_id,actor_name,tenant_id,action,entity,entity_id,summary,meta,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    null, 'النظام', tenantId, 'delete', 'tenant', String(tenantId),
    `محو كامل لبيانات الجهة «${tenant.name}» (${tenant.code})`,
    JSON.stringify(counts), nowUTC());

  await app.storage?.purgeTenant?.(tenantId);

  /* مُشغّل سجل التدقيق يسمح بالحذف تِبعاً لمحو الجهة فقط — لا حاجة لتعطيله */
  await app.db.run('DELETE FROM tenants WHERE id=?', tenantId);
  return { tenant, counts };
}
