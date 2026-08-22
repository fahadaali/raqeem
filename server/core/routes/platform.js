import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, conflict } from '../errors.js';
import { platformAdmin } from '../middleware/saas.js';
import { randomToken } from '../crypto.js';
import { signAccess, buildContext } from '../middleware/auth.js';
import {
  platformSettings, tenantUsage, tenantSubscription, planLimits, yearlySavings,
  startSubscription, issueInvoice, settleInvoice, outstandingBalance,
  STATUS_AR, INVOICE_STATUS_AR, CYCLES
} from '../billing.js';
import { provisionTenant, purgeTenant, codeAvailable } from '../provision.js';
import { periodic } from '../jobs/index.js';
import { drain, requeueStuck } from '../queue.js';

/**
 * لوحة تحكم مالك المنصة (Super Admin — SaaS Owner).
 * كانت مؤجَّلة صراحةً إلى المرحلة الثانية في المقدمة الاستراتيجية،
 * وهي الطبقة الوحيدة في المنصة التي تتجاوز عزل الجهات — ولذلك تُسجَّل
 * كل عملية فيها في سجل منصة مقفل (Append-only) مستقل عن سجلات الجهات.
 */
const router = new Hono();
router.use('*', platformAdmin());

/* ─────────────── سجل عمليات المنصة ─────────────── */
async function plog(req, { action, entity, entityId = null, tenantId = null, summary = '', meta = null }) {
  try {
    await req.app.db.run(
      `INSERT INTO platform_logs(actor_id,actor_name,tenant_id,action,entity,entity_id,summary,meta,ip,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      req.ctx.userId, req.ctx.userName, tenantId, action, entity,
      entityId === null ? null : String(entityId), summary,
      meta ? JSON.stringify(meta) : null, req.ip || '', nowUTC());
  } catch (e) { console.error('[platform-log]', e.message); }
}

/* ─────────────── نظرة عامة ─────────────── */
router.get('/overview', h(async (req) => {
  const db = req.app.db;
  const settings = await platformSettings(req.app);
  const one = async (sql, ...p) => (await db.get(sql, ...p))?.c ?? 0;

  const tenants = await db.all(`SELECT status, COUNT(*) AS c FROM tenants GROUP BY status`);
  const subs = await db.all(`SELECT status, COUNT(*) AS c FROM subscriptions GROUP BY status`);

  /* الإيراد الشهري المتكرر: الاشتراكات النشطة محسوبة على أساس شهري */
  const active = await db.all(
    `SELECT s.cycle, p.price_monthly, p.price_yearly FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active','trialing')`);
  const mrr = active.reduce((sum, r) =>
    sum + (r.cycle === 'yearly' ? Number(r.price_yearly || 0) / 12 : Number(r.price_monthly || 0)), 0);

  const revenue = await db.get(
    `SELECT COALESCE(SUM(total),0) AS paid FROM subscription_invoices WHERE status='paid'`);
  const due = await db.get(
    `SELECT COALESCE(SUM(total),0) AS due, COUNT(*) AS n FROM subscription_invoices WHERE status='open'`);
  const storage = await db.get('SELECT COALESCE(SUM(size),0) AS s FROM files');

  const perPlan = await db.all(
    `SELECT p.code, p.name, COUNT(s.id) AS tenants FROM plans p
     LEFT JOIN subscriptions s ON s.plan_id=p.id GROUP BY p.id ORDER BY p.sort`);

  const recentTenants = await db.all(
    `SELECT t.id,t.code,t.name,t.status,t.created_at, p.name AS plan_name, s.status AS sub_status
     FROM tenants t
     LEFT JOIN subscriptions s ON s.tenant_id=t.id
     LEFT JOIN plans p ON p.id=s.plan_id
     ORDER BY t.id DESC LIMIT 8`);

  return {
    platform: { name: settings.platform_name, saas_enabled: !!settings.saas_enabled,
      signup_enabled: !!settings.signup_enabled, currency: settings.currency },
    tenants: Object.fromEntries(tenants.map(t => [t.status, t.c])),
    tenants_total: tenants.reduce((s, t) => s + t.c, 0),
    subscriptions: Object.fromEntries(subs.map(s => [s.status, s.c])),
    users_total: await one(`SELECT COUNT(*) AS c FROM users WHERE status='active'`),
    branches_total: await one('SELECT COUNT(*) AS c FROM branches WHERE is_active=1'),
    storage_mb: Math.round((storage.s / 1048576) * 100) / 100,
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(mrr * 12 * 100) / 100,
    revenue_collected: revenue.paid,
    outstanding: { due: due.due, invoices: due.n },
    pending_signups: await one(`SELECT COUNT(*) AS c FROM signups WHERE status IN ('pending','verified')`),
    pending_payments: await one(`SELECT COUNT(*) AS c FROM subscription_payments WHERE status='pending'`),
    per_plan: perPlan,
    recent_tenants: recentTenants
  };
}));

/* ─────────────── الجهات ─────────────── */
router.get('/tenants', h(async (req) => {
  const db = req.app.db;
  const q = req.query;
  let where = '1=1';
  const params = [];
  if (q.status) { where += ' AND t.status=?'; params.push(q.status); }
  if (q.q) { where += ' AND (t.name LIKE ? OR t.code LIKE ? OR t.owner_email LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }

  const rows = await db.all(
    `SELECT t.*, p.code AS plan_code, p.name AS plan_name,
            s.status AS sub_status, s.cycle, s.current_period_end, s.trial_ends_at,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.status='active') AS users,
            (SELECT COUNT(*) FROM branches b WHERE b.tenant_id=t.id AND b.is_active=1) AS branches,
            (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.tenant_id=t.id) AS storage_bytes,
            (SELECT COALESCE(SUM(i.total),0) FROM subscription_invoices i WHERE i.tenant_id=t.id AND i.status='open') AS due
     FROM tenants t
     LEFT JOIN subscriptions s ON s.tenant_id=t.id
     LEFT JOIN plans p ON p.id=s.plan_id
     WHERE ${where} ORDER BY t.id DESC LIMIT 200`, ...params);

  return {
    items: rows.map(r => ({
      ...r,
      settings: undefined,
      storage_mb: Math.round((r.storage_bytes / 1048576) * 100) / 100,
      sub_status_label: STATUS_AR[r.sub_status] || null
    }))
  };
}));

router.get('/tenants/:id', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');
  const sub = await tenantSubscription(app, t.id);
  const usage = await tenantUsage(app, t.id);
  const invoices = await app.db.all(
    'SELECT * FROM subscription_invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 24', t.id);
  const owner = await app.db.get(
    `SELECT u.id,u.name,u.email,u.last_login_at FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.tenant_id=? AND r.key='owner' ORDER BY u.id LIMIT 1`, t.id);
  const activity = await app.db.get(
    'SELECT MAX(created_at) AS last FROM audit_logs WHERE tenant_id=?', t.id);

  return {
    tenant: { ...t, settings: j(t.settings, {}) },
    owner,
    subscription: sub && { ...sub, status_label: STATUS_AR[sub.status], limits: sub.plan ? planLimits(sub.plan) : null },
    usage,
    balance: await outstandingBalance(app, t.id),
    invoices: invoices.map(i => ({ ...i, status_label: INVOICE_STATUS_AR[i.status] })),
    last_activity: activity?.last || null
  };
}));

/** إنشاء جهة يدوياً من لوحة المالك */
router.post('/tenants', h(async (req) => {
  const b = req.body || {};
  const check = await codeAvailable(req.app, b.code);
  if (!check.available) throw conflict(check.reserved ? 'الرمز محجوز' : 'رمز الجهة مستخدم مسبقاً');

  const password = String(b.password || '').length >= 8 ? String(b.password) : randomToken(9) + 'aA1';
  const result = await provisionTenant(req.app, {
    code: b.code, name: b.name, nameEn: b.name_en || null,
    adminName: b.admin_name, email: b.email, password, phone: b.phone || null,
    planCode: b.plan_code || null, cycle: CYCLES.includes(b.cycle) ? b.cycle : 'monthly',
    trialDays: b.trial_days !== undefined ? Number(b.trial_days) : null,
    primaryColor: b.primary_color || '#0F5132', accentColor: b.accent_color || '#C9A227'
  });

  await plog(req, { action: 'create', entity: 'tenant', entityId: result.tenant.id, tenantId: result.tenant.id,
    summary: `${req.ctx.userName} أنشأ الجهة «${result.tenant.name}» (${result.tenant.code})`,
    meta: { plan: b.plan_code || null } });

  return created({
    tenant: result.tenant, owner: result.owner,
    subscription: result.subscription,
    /* تُعرض مرة واحدة فقط */
    temporary_password: b.password ? undefined : password
  });
}));

/** تعديل حالة الجهة أو هويتها أو نطاقها */
router.patch('/tenants/:id', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');
  const b = req.body || {};

  const next = {
    name: b.name?.trim() || t.name,
    name_en: b.name_en ?? t.name_en,
    logo_url: b.logo_url ?? t.logo_url,
    primary_color: b.primary_color || t.primary_color,
    accent_color: b.accent_color || t.accent_color,
    custom_domain: b.custom_domain === undefined ? t.custom_domain
      : (String(b.custom_domain || '').trim().toLowerCase() || null),
    status: ['active', 'suspended'].includes(b.status) ? b.status : t.status
  };

  if (next.custom_domain && next.custom_domain !== t.custom_domain) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(next.custom_domain)) throw badRequest('صيغة النطاق غير صحيحة');
    const taken = await app.db.get('SELECT id FROM tenants WHERE lower(custom_domain)=? AND id<>?',
      next.custom_domain, t.id);
    if (taken) throw conflict('النطاق مرتبط بجهة أخرى');
  }
  if (Number(req.params.id) === 1 && next.status === 'suspended') {
    throw badRequest('لا يمكن إيقاف الجهة رقم ١ (جهة التشغيل الأساسية)');
  }

  const suspending = next.status === 'suspended' && t.status !== 'suspended';
  const resuming = next.status === 'active' && t.status === 'suspended';

  await app.db.run(
    `UPDATE tenants SET name=?, name_en=?, logo_url=?, primary_color=?, accent_color=?,
      custom_domain=?, status=?, suspended_at=?, suspend_reason=? WHERE id=?`,
    next.name, next.name_en, next.logo_url, next.primary_color, next.accent_color,
    next.custom_domain, next.status,
    suspending ? nowUTC() : (resuming ? null : t.suspended_at),
    suspending ? (b.suspend_reason || 'إيقاف إداري') : (resuming ? null : t.suspend_reason),
    t.id);

  await plog(req, {
    action: suspending ? 'suspend' : (resuming ? 'resume' : 'update'),
    entity: 'tenant', entityId: t.id, tenantId: t.id,
    summary: suspending ? `${req.ctx.userName} أوقف الجهة «${t.name}» — ${b.suspend_reason || 'إيقاف إداري'}`
      : resuming ? `${req.ctx.userName} أعاد تفعيل الجهة «${t.name}»`
      : `${req.ctx.userName} حدّث بيانات الجهة «${t.name}»`,
    meta: { before: { status: t.status, custom_domain: t.custom_domain }, after: next }
  });

  return app.db.get('SELECT * FROM tenants WHERE id=?', t.id);
}));

/** تغيير خطة جهة من لوحة المالك (بلا فوترة فورية) */
router.post('/tenants/:id/plan', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');

  const planCode = String(req.body?.plan_code || '');
  const cycle = CYCLES.includes(req.body?.cycle) ? req.body.cycle : 'monthly';
  const status = ['trialing', 'active'].includes(req.body?.status) ? req.body.status : null;

  const before = await tenantSubscription(app, t.id);
  const sub = await startSubscription(app, t.id, {
    planCode, cycle, status,
    trialDays: req.body?.trial_days !== undefined ? Number(req.body.trial_days) : null
  });
  await app.db.run('UPDATE tenants SET plan=? WHERE id=?', planCode, t.id);

  await plog(req, { action: 'update', entity: 'subscription', entityId: sub.id, tenantId: t.id,
    summary: `${req.ctx.userName} حوّل «${t.name}» إلى خطة «${sub.plan?.name}»`,
    meta: { before: before && { plan: before.plan?.code, status: before.status }, after: { plan: planCode, cycle, status: sub.status } } });
  return sub;
}));

/** دخول إداري إلى جهة للمساندة — موثّق في سجلّي المنصة والجهة */
router.post('/tenants/:id/impersonate', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');

  const owner = await app.db.get(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.tenant_id=? AND r.key='owner' AND u.status='active' ORDER BY u.id LIMIT 1`, t.id);
  if (!owner) throw badRequest('لا يوجد حساب مدير نشط في هذه الجهة');

  const ctx = await buildContext(app, owner.id);
  if (!ctx) throw badRequest('تعذّر بناء جلسة الجهة');
  const accessToken = await signAccess(app, ctx);

  await plog(req, { action: 'impersonate', entity: 'tenant', entityId: t.id, tenantId: t.id,
    summary: `${req.ctx.userName} دخل إدارياً إلى «${t.name}» بحساب مديرها للمساندة الفنية`,
    meta: { as_user: owner.id } });
  await app.db.run(
    `INSERT INTO audit_logs(tenant_id,user_id,user_name,role_key,action,entity,entity_id,summary,ip,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    t.id, owner.id, `${req.ctx.userName} (مالك المنصة)`, 'platform_admin', 'login', 'tenant', String(t.id),
    `دخول إداري من مالك المنصة للمساندة الفنية`, req.ip || '', nowUTC());

  return { accessToken, tenant: { id: t.id, code: t.code, name: t.name }, impersonated: true };
}));

/** محو جهة بالكامل — لا رجعة فيه */
router.delete('/tenants/:id', h(async (req) => {
  const confirm = String(req.query.confirm || req.body?.confirm || '');
  const t = await req.app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');
  if (confirm !== t.code) throw badRequest(`لتأكيد المحو أرسل confirm=${t.code}`);

  const out = await purgeTenant(req.app, t.id);
  await plog(req, { action: 'delete', entity: 'tenant', entityId: t.id, tenantId: t.id,
    summary: `${req.ctx.userName} محا الجهة «${t.name}» (${t.code}) وكل بياناتها`, meta: out.counts });
  return { ok: true, purged: out.counts };
}));

/* ─────────────── الخطط ─────────────── */
const PLAN_FIELDS = ['code', 'name', 'name_en', 'tagline', 'description', 'price_monthly', 'price_yearly',
  'currency', 'trial_days', 'max_branches', 'max_users', 'max_storage_mb', 'is_public', 'is_active',
  'highlight', 'sort'];

router.get('/plans', h(async (req) => {
  const rows = await req.app.db.all('SELECT * FROM plans ORDER BY sort, price_monthly');
  const counts = await req.app.db.all(
    'SELECT plan_id, COUNT(*) AS c FROM subscriptions GROUP BY plan_id');
  const map = Object.fromEntries(counts.map(c => [c.plan_id, c.c]));
  return rows.map(p => ({
    ...p, features: j(p.features, []) || [], perks: j(p.perks, []) || [],
    yearly_savings: yearlySavings(p), subscribers: map[p.id] || 0
  }));
}));

router.post('/plans', h(async (req) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!code) throw badRequest('رمز الخطة إلزامي (حروف إنجليزية صغيرة)');
  if (!String(b.name || '').trim()) throw badRequest('اسم الخطة إلزامي');
  if (await req.app.db.get('SELECT id FROM plans WHERE code=?', code)) throw conflict('رمز الخطة مستخدم مسبقاً');

  const r = await req.app.db.run(
    `INSERT INTO plans(code,name,name_en,tagline,description,price_monthly,price_yearly,currency,
      trial_days,max_branches,max_users,max_storage_mb,features,perks,is_public,is_active,highlight,sort)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, String(b.name).trim(), b.name_en || null, b.tagline || null, b.description || null,
    Number(b.price_monthly || 0), Number(b.price_yearly || 0), b.currency || 'SAR',
    Number(b.trial_days ?? 14),
    b.max_branches === null || b.max_branches === undefined || b.max_branches === '' ? null : Number(b.max_branches),
    b.max_users === null || b.max_users === undefined || b.max_users === '' ? null : Number(b.max_users),
    b.max_storage_mb === null || b.max_storage_mb === undefined || b.max_storage_mb === '' ? null : Number(b.max_storage_mb),
    JSON.stringify(Array.isArray(b.features) ? b.features : []),
    JSON.stringify(Array.isArray(b.perks) ? b.perks : []),
    b.is_public === false ? 0 : 1, b.is_active === false ? 0 : 1, b.highlight ? 1 : 0, Number(b.sort || 0));

  await plog(req, { action: 'create', entity: 'plan', entityId: r.lastId,
    summary: `${req.ctx.userName} أنشأ خطة «${b.name}»` });
  return created(await req.app.db.get('SELECT * FROM plans WHERE id=?', r.lastId));
}));

router.patch('/plans/:id', h(async (req) => {
  const app = req.app;
  const p = await app.db.get('SELECT * FROM plans WHERE id=?', req.params.id);
  if (!p) throw notFound('الخطة غير موجودة');
  const b = req.body || {};

  const sets = [], vals = [];
  for (const f of PLAN_FIELDS) {
    if (f === 'code' || b[f] === undefined) continue;
    sets.push(`${f}=?`);
    if (['max_branches', 'max_users', 'max_storage_mb'].includes(f)) {
      vals.push(b[f] === null || b[f] === '' ? null : Number(b[f]));
    } else if (['is_public', 'is_active', 'highlight'].includes(f)) {
      vals.push(b[f] ? 1 : 0);
    } else if (['price_monthly', 'price_yearly', 'trial_days', 'sort'].includes(f)) {
      vals.push(Number(b[f]));
    } else vals.push(b[f]);
  }
  if (Array.isArray(b.features)) { sets.push('features=?'); vals.push(JSON.stringify(b.features)); }
  if (Array.isArray(b.perks)) { sets.push('perks=?'); vals.push(JSON.stringify(b.perks)); }
  if (!sets.length) throw badRequest('لا يوجد ما يُحدَّث');

  await app.db.run(`UPDATE plans SET ${sets.join(', ')} WHERE id=?`, ...vals, p.id);
  await plog(req, { action: 'update', entity: 'plan', entityId: p.id,
    summary: `${req.ctx.userName} حدّث خطة «${p.name}»`, meta: { before: p, after: b } });
  return app.db.get('SELECT * FROM plans WHERE id=?', p.id);
}));

router.delete('/plans/:id', h(async (req) => {
  const app = req.app;
  const p = await app.db.get('SELECT * FROM plans WHERE id=?', req.params.id);
  if (!p) throw notFound('الخطة غير موجودة');
  const used = await app.db.get('SELECT COUNT(*) AS c FROM subscriptions WHERE plan_id=?', p.id);
  if (used.c) throw conflict(`الخطة مرتبطة بـ ${used.c} جهة — عطّلها بدل حذفها`);
  await app.db.run('DELETE FROM plans WHERE id=?', p.id);
  await plog(req, { action: 'delete', entity: 'plan', entityId: p.id,
    summary: `${req.ctx.userName} حذف خطة «${p.name}»` });
  return { ok: true };
}));

/* ─────────────── الاشتراكات والفواتير ─────────────── */
router.get('/subscriptions', h(async (req) => {
  const rows = await req.app.db.all(
    `SELECT s.*, t.name AS tenant_name, t.code AS tenant_code, p.name AS plan_name, p.code AS plan_code,
            p.price_monthly, p.price_yearly
     FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id JOIN plans p ON p.id=s.plan_id
     ORDER BY s.current_period_end LIMIT 200`);
  return rows.map(r => ({
    ...r, status_label: STATUS_AR[r.status] || r.status,
    price: r.cycle === 'yearly' ? r.price_yearly : r.price_monthly
  }));
}));

router.get('/invoices', h(async (req) => {
  const q = req.query;
  let where = '1=1';
  const params = [];
  if (q.status) { where += ' AND i.status=?'; params.push(q.status); }
  if (q.tenant_id) { where += ' AND i.tenant_id=?'; params.push(Number(q.tenant_id)); }

  const rows = await req.app.db.all(
    `SELECT i.*, t.name AS tenant_name, t.code AS tenant_code,
      (SELECT COUNT(*) FROM subscription_payments p WHERE p.invoice_id=i.id AND p.status='pending') AS pending_payments
     FROM subscription_invoices i JOIN tenants t ON t.id=i.tenant_id
     WHERE ${where} ORDER BY i.id DESC LIMIT 200`, ...params);
  const totals = await req.app.db.get(
    `SELECT COALESCE(SUM(CASE WHEN status='paid' THEN total END),0) AS paid,
            COALESCE(SUM(CASE WHEN status='open' THEN total END),0) AS due
     FROM subscription_invoices`);
  return { items: rows.map(r => ({ ...r, status_label: INVOICE_STATUS_AR[r.status] })), totals };
}));

/** إصدار فاتورة يدوية لجهة */
router.post('/invoices', h(async (req) => {
  const app = req.app;
  const tenantId = Number(req.body?.tenant_id);
  const sub = await tenantSubscription(app, tenantId);
  if (!sub) throw badRequest('الجهة بلا اشتراك — عيّن لها خطة أولاً');
  const inv = await issueInvoice(app, tenantId, sub, { note: req.body?.note || 'فاتورة يدوية' });
  await plog(req, { action: 'create', entity: 'subscription_invoice', entityId: inv.id, tenantId,
    summary: `${req.ctx.userName} أصدر الفاتورة ${inv.number} بمبلغ ${inv.total} ${inv.currency}` });
  return created(inv);
}));

router.post('/invoices/:id/mark-paid', h(async (req) => {
  const app = req.app;
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', req.params.id);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  const out = await settleInvoice(app, inv.id, { confirmedBy: req.ctx.userId });
  await plog(req, { action: 'approve', entity: 'subscription_invoice', entityId: inv.id, tenantId: inv.tenant_id,
    summary: `${req.ctx.userName} اعتمد سداد الفاتورة ${inv.number} (${inv.total} ${inv.currency})` });
  return out;
}));

router.post('/invoices/:id/void', h(async (req) => {
  const app = req.app;
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', req.params.id);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  if (inv.status === 'paid') throw badRequest('لا يمكن إلغاء فاتورة مسددة');
  await app.db.run(`UPDATE subscription_invoices SET status='void', void_reason=? WHERE id=?`,
    req.body?.reason || 'إلغاء إداري', inv.id);
  await plog(req, { action: 'reject', entity: 'subscription_invoice', entityId: inv.id, tenantId: inv.tenant_id,
    summary: `${req.ctx.userName} ألغى الفاتورة ${inv.number}` });
  return app.db.get('SELECT * FROM subscription_invoices WHERE id=?', inv.id);
}));

router.get('/payments', h(async (req) => {
  const rows = await req.app.db.all(
    `SELECT p.*, i.number AS invoice_number, i.total AS invoice_total, t.name AS tenant_name,
            u.name AS declared_by_name
     FROM subscription_payments p
     JOIN subscription_invoices i ON i.id=p.invoice_id
     JOIN tenants t ON t.id=p.tenant_id
     LEFT JOIN users u ON u.id=p.declared_by
     ${req.query.status ? 'WHERE p.status=?' : ''}
     ORDER BY p.id DESC LIMIT 200`, ...(req.query.status ? [req.query.status] : []));
  return rows;
}));

router.post('/payments/:id/confirm', h(async (req) => {
  const app = req.app;
  const p = await app.db.get('SELECT * FROM subscription_payments WHERE id=?', req.params.id);
  if (!p) throw notFound('إشعار السداد غير موجود');
  if (p.status !== 'pending') throw badRequest('تمت معالجة هذا الإشعار مسبقاً');
  const inv = await settleInvoice(app, p.invoice_id, { confirmedBy: req.ctx.userId });
  await plog(req, { action: 'approve', entity: 'subscription_payment', entityId: p.id, tenantId: p.tenant_id,
    summary: `${req.ctx.userName} اعتمد سداداً بمبلغ ${p.amount} للفاتورة ${inv.number}` });
  return { ok: true, invoice: inv };
}));

router.post('/payments/:id/reject', h(async (req) => {
  const app = req.app;
  const p = await app.db.get('SELECT * FROM subscription_payments WHERE id=?', req.params.id);
  if (!p) throw notFound('إشعار السداد غير موجود');
  await app.db.run(
    `UPDATE subscription_payments SET status='rejected', confirmed_by=?, confirmed_at=?, note=? WHERE id=?`,
    req.ctx.userId, nowUTC(), req.body?.reason || p.note, p.id);
  await plog(req, { action: 'reject', entity: 'subscription_payment', entityId: p.id, tenantId: p.tenant_id,
    summary: `${req.ctx.userName} رفض إشعار سداد بمبلغ ${p.amount}` });
  return { ok: true };
}));

/* ─────────────── طلبات التسجيل ─────────────── */
router.get('/signups', h(async (req) => {
  const rows = await req.app.db.all(
    `SELECT id,code,tenant_name,admin_name,email,phone,plan_code,cycle,status,tenant_id,
            reject_reason,ip,created_at,provisioned_at
     FROM signups ${req.query.status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 200`,
    ...(req.query.status ? [req.query.status] : []));
  return rows;
}));

router.post('/signups/:id/approve', h(async (req) => {
  const app = req.app;
  const s = await app.db.get('SELECT * FROM signups WHERE id=?', req.params.id);
  if (!s) throw notFound('الطلب غير موجود');
  if (s.status === 'provisioned') throw badRequest('الطلب مفعّل مسبقاً');
  if (s.status === 'rejected') throw badRequest('الطلب مرفوض');

  const result = await provisionTenant(app, {
    code: s.code, name: s.tenant_name, adminName: s.admin_name, email: s.email,
    passwordHash: s.password_hash, phone: s.phone,
    planCode: req.body?.plan_code || s.plan_code, cycle: s.cycle
  });
  await app.db.run(`UPDATE signups SET status='provisioned', tenant_id=?, verified_at=COALESCE(verified_at,?), provisioned_at=? WHERE id=?`,
    result.tenant.id, nowUTC(), nowUTC(), s.id);

  await plog(req, { action: 'approve', entity: 'signup', entityId: s.id, tenantId: result.tenant.id,
    summary: `${req.ctx.userName} اعتمد طلب تسجيل «${s.tenant_name}» وفعّل الجهة` });
  return created({ tenant: result.tenant, owner: result.owner, subscription: result.subscription });
}));

router.post('/signups/:id/reject', h(async (req) => {
  const app = req.app;
  const s = await app.db.get('SELECT * FROM signups WHERE id=?', req.params.id);
  if (!s) throw notFound('الطلب غير موجود');
  if (s.status === 'provisioned') throw badRequest('الطلب مفعّل ولا يمكن رفضه');
  await app.db.run(`UPDATE signups SET status='rejected', reject_reason=? WHERE id=?`,
    req.body?.reason || 'لم يستوفِ الشروط', s.id);
  await plog(req, { action: 'reject', entity: 'signup', entityId: s.id,
    summary: `${req.ctx.userName} رفض طلب تسجيل «${s.tenant_name}»` });
  return { ok: true };
}));

/* ─────────────── إعدادات المنصة ─────────────── */
router.get('/settings', h(async (req) => platformSettings(req.app)));

router.put('/settings', h(async (req) => {
  const app = req.app;
  const cur = await platformSettings(app);
  const b = req.body || {};
  const bool = (v, d) => (v === undefined ? d : (v ? 1 : 0));
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

  await app.db.run(
    `UPDATE platform_settings SET platform_name=?, platform_name_en=?, tagline=?, support_email=?,
      support_phone=?, saas_enabled=?, signup_enabled=?, signup_needs_review=?, default_plan_code=?,
      trial_days=?, grace_days=?, vat_rate=?, currency=?, vat_number=?, cr_number=?, bank_details=?,
      invoice_prefix=?, updated_at=? WHERE id=1`,
    b.platform_name?.trim() || cur.platform_name,
    b.platform_name_en ?? cur.platform_name_en,
    b.tagline ?? cur.tagline,
    b.support_email ?? cur.support_email,
    b.support_phone ?? cur.support_phone,
    bool(b.saas_enabled, cur.saas_enabled),
    bool(b.signup_enabled, cur.signup_enabled),
    bool(b.signup_needs_review, cur.signup_needs_review),
    b.default_plan_code || cur.default_plan_code,
    num(b.trial_days, cur.trial_days), num(b.grace_days, cur.grace_days),
    num(b.vat_rate, cur.vat_rate), b.currency || cur.currency,
    b.vat_number ?? cur.vat_number, b.cr_number ?? cur.cr_number,
    JSON.stringify(b.bank_details ?? cur.bank_details),
    b.invoice_prefix || cur.invoice_prefix, nowUTC());

  await plog(req, { action: 'update', entity: 'platform_settings', entityId: 1,
    summary: `${req.ctx.userName} حدّث إعدادات المنصة`,
    meta: { saas_enabled: bool(b.saas_enabled, cur.saas_enabled), signup_enabled: bool(b.signup_enabled, cur.signup_enabled) } });
  return platformSettings(app);
}));

/* ─────────────── مدراء المنصة ─────────────── */
router.get('/admins', h(async (req) => req.app.db.all(
  `SELECT u.id,u.name,u.email,u.last_login_at,t.name AS tenant_name
   FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.is_platform_admin=1 ORDER BY u.id`)));

router.post('/admins', h(async (req) => {
  const app = req.app;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = await app.db.get('SELECT * FROM users WHERE lower(email)=?', email);
  if (!u) throw notFound('لا يوجد مستخدم بهذا البريد');
  await app.db.run('UPDATE users SET is_platform_admin=1 WHERE id=?', u.id);
  await plog(req, { action: 'update', entity: 'platform_admin', entityId: u.id, tenantId: u.tenant_id,
    summary: `${req.ctx.userName} منح «${u.name}» صلاحية مالك المنصة` });
  return { ok: true, user: { id: u.id, name: u.name, email: u.email } };
}));

router.delete('/admins/:id', h(async (req) => {
  const app = req.app;
  const id = Number(req.params.id);
  if (id === req.ctx.userId) throw badRequest('لا يمكنك إزالة صلاحيتك بنفسك');
  const count = await app.db.get('SELECT COUNT(*) AS c FROM users WHERE is_platform_admin=1');
  if (count.c <= 1) throw badRequest('يجب بقاء مالك واحد للمنصة على الأقل');
  const u = await app.db.get('SELECT * FROM users WHERE id=?', id);
  if (!u) throw notFound('المستخدم غير موجود');
  await app.db.run('UPDATE users SET is_platform_admin=0 WHERE id=?', id);
  await plog(req, { action: 'update', entity: 'platform_admin', entityId: id, tenantId: u.tenant_id,
    summary: `${req.ctx.userName} سحب صلاحية مالك المنصة من «${u.name}»` });
  return { ok: true };
}));

/* ─────────────── تشغيل وظائف الصيانة عند الطلب ─────────────── */
const JOBS = {
  subscriptions: { label: 'دورة الاشتراكات والفوترة', run: (app) => periodic.subscriptions(app) },
  sla: { label: 'تصعيد تذاكر مستوى الخدمة', run: (app) => periodic.sla(app) },
  kpi: { label: 'إعادة احتساب مؤشرات الأداء', run: (app) => periodic.kpi(app) },
  deadlines: { label: 'تذكير المهام المستحقة', run: (app) => periodic.deadlines(app) },
  backup: { label: 'النسخ الاحتياطي اليومي', run: (app) => periodic.backup(app) },
  queue: { label: 'تصريف طابور المعالجة', run: async (app) => ({ drained: await drain(app, { max: 50 }), requeued: await requeueStuck(app) }) }
};

router.get('/jobs', h(async () =>
  Object.entries(JOBS).map(([key, j]) => ({ key, label: j.label }))));

/** تشغيل وظيفة دورية فوراً بدل انتظار مؤقّتها — للصيانة والتشخيص */
router.post('/jobs/:name/run', h(async (req) => {
  const job = JOBS[req.params.name];
  if (!job) throw notFound('وظيفة غير معروفة');
  const started = Date.now();
  const result = await job.run(req.app);
  await plog(req, { action: 'update', entity: 'job', entityId: req.params.name,
    summary: `${req.ctx.userName} شغّل «${job.label}» يدوياً`, meta: result });
  return { job: req.params.name, label: job.label, ms: Date.now() - started, result };
}));

/* ─────────────── سجل المنصة ─────────────── */
router.get('/logs', h(async (req) => {
  const q = req.query;
  let where = '1=1';
  const params = [];
  if (q.tenant_id) { where += ' AND tenant_id=?'; params.push(Number(q.tenant_id)); }
  if (q.action) { where += ' AND action=?'; params.push(q.action); }
  if (q.q) { where += ' AND summary LIKE ?'; params.push(`%${q.q}%`); }

  const limit = Math.min(500, Number(q.limit) || 100);
  const total = (await req.app.db.get(`SELECT COUNT(*) AS c FROM platform_logs WHERE ${where}`, ...params)).c;
  const rows = await req.app.db.all(
    `SELECT * FROM platform_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params, limit, Number(q.offset) || 0);
  return { total, items: rows.map(r => ({ ...r, meta: j(r.meta, null) })) };
}));

export default router;
