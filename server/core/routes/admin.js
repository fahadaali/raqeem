import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, conflict } from '../errors.js';
import { authenticateAdmin } from '../middleware/admin-auth.js';
import { randomToken, hashPassword } from '../crypto.js';
import { signAccess, buildContext } from '../middleware/auth.js';
import {
  platformSettings, tenantUsage, tenantSubscription, planLimits, yearlySavings,
  startSubscription, issueInvoice, settleInvoice, outstandingBalance,
  STATUS_AR, INVOICE_STATUS_AR, CYCLES
} from '../billing.js';
import { provisionTenant, purgeTenant, codeAvailable } from '../provision.js';
import { periodic, JOB_KEYS } from '../jobs/index.js';
import { drain, requeueStuck } from '../queue.js';
import { metricsSeries, trialConversion, revenueForecast, snapshotMetrics } from '../jobs/metrics.js';
import { jobsHealth, jobRuns } from '../jobs/runner.js';
import { tenantsHealth, tenantHealth, RISK_AR } from '../health.js';
import { createAnnouncement, listAnnouncements, deleteAnnouncement, AUDIENCES, SEVERITY_AR, AUDIENCE_AR } from '../announce.js';
import { loginSecurityReport } from '../security.js';
import { couponsReport, normalizeCode as normalizeCouponCode, validateCoupon } from '../coupons.js';
import { issueCreditNote, creditedAmount, effectiveLimits } from '../billing.js';
import { GATEWAYS, handleWebhook } from '../payments.js';
import { FEATURES, effectiveFeatures } from '../features.js';
import { verifyChain, decodeQR } from '../zatca.js';
import { dumpSQL } from '../jobs/backup.js';
import { gzip } from '../zip.js';
import { notifyUsers } from '../notify.js';

/**
 * لوحة تحكم مالك المنصة (Super Admin — SaaS Owner).
 * كانت مؤجَّلة صراحةً إلى المرحلة الثانية في المقدمة الاستراتيجية،
 * وهي الطبقة الوحيدة في المنصة التي تتجاوز عزل الجهات — ولذلك تُسجَّل
 * كل عملية فيها في سجل منصة مقفل (Append-only) مستقل عن سجلات الجهات.
 */
import { plog } from '../plog.js';
import { readLanding, normalizeLanding, DEFAULT_LANDING } from '../landing.js';
import { expandTemplate, DEFAULT_TEMPLATES } from '../term-templates.js';

const router = new Hono();
/* الحارس يقبل رمز الادمن وحده — رمز المستأجر يُرفض قبل أي مسار */
router.use('*', authenticateAdmin());

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
    recent_tenants: recentTenants,
    /* ما يحتاج تدخّلاً الآن */
    alerts: await overviewAlerts(req.app)
  };
}));

/** ملخّص ما يستدعي انتباه المالك: مخاطر التسرّب، فرص الترقية، وظائف متعثّرة، دعم مفتوح */
async function overviewAlerts(app) {
  const [health, jobs] = await Promise.all([
    tenantsHealth(app).catch(() => null),
    jobsHealth(app).catch(() => [])
  ]);
  const support = await app.db.get(
    `SELECT COUNT(*) AS c FROM tickets WHERE vendor_escalated=1 AND vendor_status='open'`).catch(() => ({ c: 0 }));
  return {
    at_risk: health?.at_risk?.length || 0,
    critical: health?.summary?.by_risk?.critical || 0,
    average_health: health?.summary?.average_score ?? null,
    upsell_opportunities: health?.summary?.upsell_opportunities || 0,
    upsell_value: health?.summary?.upsell_value || 0,
    failing_jobs: jobs.filter(x => x.status === 'failed').map(x => x.job),
    open_support: support?.c || 0
  };
}

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

  const notes = await app.db.all(
    'SELECT * FROM tenant_notes WHERE tenant_id=? ORDER BY pinned DESC, id DESC LIMIT 20', t.id);

  /* فصول المجمّع: بها يُتحقّق أن القالب المفروض وصل فعلاً */
  const terms = await app.db.all(
    `SELECT id,code,name,start_date,end_date,status,is_current FROM terms
     WHERE tenant_id=? ORDER BY start_date`, t.id);

  return {
    tenant: {
      ...t, settings: j(t.settings, {}),
      limit_overrides: j(t.limit_overrides, {}) || {},
      feature_overrides: j(t.feature_overrides, {}) || {},
      billing_entity: j(t.billing_entity, {}) || {}
    },
    owner,
    subscription: sub && {
      ...sub, status_label: STATUS_AR[sub.status],
      limits: sub.plan ? effectiveLimits(sub.plan, t) : null,
      plan_limits: sub.plan ? planLimits(sub.plan) : null
    },
    features: sub?.plan ? FEATURES.map(f => ({
      ...f,
      enabled: effectiveFeatures(sub.plan, t).includes(f.key),
      in_plan: !(j(sub.plan.features, []) || []).length || (j(sub.plan.features, []) || []).includes(f.key)
    })) : null,
    usage,
    balance: await outstandingBalance(app, t.id),
    invoices: invoices.map(i => ({ ...i, status_label: INVOICE_STATUS_AR[i.status] })),
    last_activity: activity?.last || null,
    health: await tenantHealth(app, t.id),
    terms: terms.map(x => ({ ...x, is_current: !!x.is_current })),
    notes
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
    summary: `${req.ctx.adminName} أنشأ الجهة «${result.tenant.name}» (${result.tenant.code})`,
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
    summary: suspending ? `${req.ctx.adminName} أوقف الجهة «${t.name}» — ${b.suspend_reason || 'إيقاف إداري'}`
      : resuming ? `${req.ctx.adminName} أعاد تفعيل الجهة «${t.name}»`
      : `${req.ctx.adminName} حدّث بيانات الجهة «${t.name}»`,
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
    summary: `${req.ctx.adminName} حوّل «${t.name}» إلى خطة «${sub.plan?.name}»`,
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
    summary: `${req.ctx.adminName} دخل إدارياً إلى «${t.name}» بحساب مديرها للمساندة الفنية`,
    meta: { as_user: owner.id } });
  await app.db.run(
    `INSERT INTO audit_logs(tenant_id,user_id,user_name,role_key,action,entity,entity_id,summary,ip,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    t.id, owner.id, `${req.ctx.adminName} (مالك المنصة)`, 'platform_admin', 'login', 'tenant', String(t.id),
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
    summary: `${req.ctx.adminName} محا الجهة «${t.name}» (${t.code}) وكل بياناتها`, meta: out.counts });
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
    summary: `${req.ctx.adminName} أنشأ خطة «${b.name}»` });
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
    summary: `${req.ctx.adminName} حدّث خطة «${p.name}»`, meta: { before: p, after: b } });
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
    summary: `${req.ctx.adminName} حذف خطة «${p.name}»` });
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
    summary: `${req.ctx.adminName} أصدر الفاتورة ${inv.number} بمبلغ ${inv.total} ${inv.currency}` });
  return created(inv);
}));

router.post('/invoices/:id/mark-paid', h(async (req) => {
  const app = req.app;
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', req.params.id);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  const out = await settleInvoice(app, inv.id, { confirmedBy: req.ctx.adminId });
  await plog(req, { action: 'approve', entity: 'subscription_invoice', entityId: inv.id, tenantId: inv.tenant_id,
    summary: `${req.ctx.adminName} اعتمد سداد الفاتورة ${inv.number} (${inv.total} ${inv.currency})` });
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
    summary: `${req.ctx.adminName} ألغى الفاتورة ${inv.number}` });
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
  const inv = await settleInvoice(app, p.invoice_id, { confirmedBy: req.ctx.adminId });
  await plog(req, { action: 'approve', entity: 'subscription_payment', entityId: p.id, tenantId: p.tenant_id,
    summary: `${req.ctx.adminName} اعتمد سداداً بمبلغ ${p.amount} للفاتورة ${inv.number}` });
  return { ok: true, invoice: inv };
}));

router.post('/payments/:id/reject', h(async (req) => {
  const app = req.app;
  const p = await app.db.get('SELECT * FROM subscription_payments WHERE id=?', req.params.id);
  if (!p) throw notFound('إشعار السداد غير موجود');
  await app.db.run(
    `UPDATE subscription_payments SET status='rejected', confirmed_by=?, confirmed_at=?, note=? WHERE id=?`,
    req.ctx.adminId, nowUTC(), req.body?.reason || p.note, p.id);
  await plog(req, { action: 'reject', entity: 'subscription_payment', entityId: p.id, tenantId: p.tenant_id,
    summary: `${req.ctx.adminName} رفض إشعار سداد بمبلغ ${p.amount}` });
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
    summary: `${req.ctx.adminName} اعتمد طلب تسجيل «${s.tenant_name}» وفعّل الجهة` });
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
    summary: `${req.ctx.adminName} رفض طلب تسجيل «${s.tenant_name}»` });
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
      invoice_prefix=?, seller_address=?, zatca_enabled=?, payment_gateway=?, gateway_config=?,
      require_2fa_admins=?, health_idle_days=?, upsell_threshold=?, updated_at=? WHERE id=1`,
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
    b.invoice_prefix || cur.invoice_prefix,
    JSON.stringify(b.seller_address ?? cur.seller_address),
    bool(b.zatca_enabled, cur.zatca_enabled),
    b.payment_gateway && GATEWAYS[b.payment_gateway] ? b.payment_gateway : cur.payment_gateway,
    JSON.stringify(b.gateway_config ?? j(cur.gateway_config, {}) ?? {}),
    bool(b.require_2fa_admins, cur.require_2fa_admins),
    num(b.health_idle_days, cur.health_idle_days),
    num(b.upsell_threshold, cur.upsell_threshold),
    nowUTC());

  await plog(req, { action: 'update', entity: 'platform_settings', entityId: 1,
    summary: `${req.ctx.adminName} حدّث إعدادات المنصة`,
    meta: { saas_enabled: bool(b.saas_enabled, cur.saas_enabled), signup_enabled: bool(b.signup_enabled, cur.signup_enabled) } });
  return platformSettings(app);
}));

/* ─────────────── قوالب الفصول الدراسية ─────────────── */
/**
 * تعريف عام يُنسخ إلى كل مجمّع جديد، ويُفرَض على القائم منها عند الطلب.
 * التواريخ نسبية (شهر/يوم + مدّة) فيصلح القالب لكل سنة دون تحرير.
 */
const tplInt = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

router.get('/terms', h(async (req) => {
  const items = await req.app.db.all(
    'SELECT * FROM term_templates ORDER BY sort_order, start_month, start_day, id');
  const today = new Date().toISOString().slice(0, 10);
  return {
    items: items.map(t => ({ ...t, is_active: !!t.is_active,
      preview: expandTemplate(t, today, { prefer: 'upcoming' }) })),
    suggestions: DEFAULT_TEMPLATES,
    tenants: (await req.app.db.get(`SELECT COUNT(*) AS c FROM tenants WHERE status='active'`)).c
  };
}));

router.post('/terms', h(async (req) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const name = String(b.name || '').trim();
  if (!/^[A-Z0-9-]{1,16}$/.test(code)) throw badRequest('رمز الفصل حروف إنجليزية وأرقام وشرطات فقط');
  if (!name) throw badRequest('اسم الفصل مطلوب');
  if (await req.app.db.get('SELECT id FROM term_templates WHERE code=?', code)) {
    throw conflict('رمز القالب مستخدم');
  }
  const r = await req.app.db.run(
    `INSERT INTO term_templates(code,name,start_month,start_day,duration_days,sort_order,is_active)
     VALUES(?,?,?,?,?,?,?)`,
    code, name,
    tplInt(b.start_month, 1, 12, 1), tplInt(b.start_day, 1, 31, 1),
    tplInt(b.duration_days, 1, 366, 120), tplInt(b.sort_order, 0, 999, 0),
    b.is_active === false ? 0 : 1);
  await plog(req, { action: 'create', entity: 'term_template', entityId: r.lastId,
    summary: `${req.ctx.adminName} أضاف قالب الفصل «${name}»` });
  return created(await req.app.db.get('SELECT * FROM term_templates WHERE id=?', r.lastId));
}));

router.patch('/terms/:id', h(async (req) => {
  const cur = await req.app.db.get('SELECT * FROM term_templates WHERE id=?', req.params.id);
  if (!cur) throw notFound('القالب غير موجود');
  const b = req.body || {};
  const name = b.name === undefined ? cur.name : String(b.name).trim();
  if (!name) throw badRequest('اسم الفصل مطلوب');
  await req.app.db.run(
    `UPDATE term_templates SET name=?, start_month=?, start_day=?, duration_days=?,
      sort_order=?, is_active=? WHERE id=?`,
    name,
    tplInt(b.start_month, 1, 12, cur.start_month), tplInt(b.start_day, 1, 31, cur.start_day),
    tplInt(b.duration_days, 1, 366, cur.duration_days),
    tplInt(b.sort_order, 0, 999, cur.sort_order),
    b.is_active === undefined ? cur.is_active : (b.is_active ? 1 : 0),
    cur.id);
  await plog(req, { action: 'update', entity: 'term_template', entityId: cur.id,
    summary: `${req.ctx.adminName} حدّث قالب الفصل «${name}»` });
  return req.app.db.get('SELECT * FROM term_templates WHERE id=?', cur.id);
}));

router.delete('/terms/:id', h(async (req) => {
  const cur = await req.app.db.get('SELECT * FROM term_templates WHERE id=?', req.params.id);
  if (!cur) throw notFound('القالب غير موجود');
  await req.app.db.run('DELETE FROM term_templates WHERE id=?', cur.id);
  await plog(req, { action: 'delete', entity: 'term_template', entityId: cur.id,
    summary: `${req.ctx.adminName} حذف قالب الفصل «${cur.name}»` });
  return { ok: true };
}));

/**
 * فرض قالب على المجمّعات القائمة.
 *
 * يُنشئ الفصل حيث لا يوجد رمزه، ويتخطّى الموجود بلا مساس — والتخطّي مقصود:
 * مجمّعٌ سمّى فصله أو عدّل تواريخه لا يُداس عليه من المنصة. والنتيجة تقرير صريح
 * بمن أُضيف له ومن تُخطّي ولماذا، لا رقمٌ مجرّد.
 */
router.post('/terms/:id/apply', h(async (req) => {
  const app = req.app;
  const tpl = await app.db.get('SELECT * FROM term_templates WHERE id=?', req.params.id);
  if (!tpl) throw notFound('القالب غير موجود');

  const ids = Array.isArray(req.body?.tenant_ids) ? req.body.tenant_ids.map(Number).filter(Boolean) : null;
  const tenants = ids?.length
    ? await app.db.all(`SELECT id,name,code FROM tenants WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : await app.db.all(`SELECT id,name,code FROM tenants WHERE status='active' ORDER BY id`);

  const today = new Date().toISOString().slice(0, 10);
  const t = expandTemplate(tpl, today, { prefer: 'upcoming' });
  const added = [], skipped = [];

  for (const tn of tenants) {
    const exists = await app.db.get('SELECT id,status FROM terms WHERE tenant_id=? AND code=?', tn.id, tpl.code);
    if (exists) {
      skipped.push({ tenant_id: tn.id, name: tn.name,
        reason: exists.status === 'open' ? 'الفصل موجود' : `الفصل موجود وحالته ${exists.status}` });
      continue;
    }
    try {
      /* الفصل المفروض لا يُنصَّب جارياً: نصب فصلٍ جارٍ قرارُ المجمّع لا المنصة */
      await app.db.run(
        `INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current)
         VALUES(?,?,?,?,?, 'open', 0)`,
        tn.id, t.code, t.name, t.start_date, t.end_date);
      added.push({ tenant_id: tn.id, name: tn.name });
    } catch (e) {
      skipped.push({ tenant_id: tn.id, name: tn.name, reason: e.message.slice(0, 120) });
    }
  }

  await plog(req, { action: 'apply', entity: 'term_template', entityId: tpl.id,
    summary: `${req.ctx.adminName} فرض قالب «${tpl.name}» على ${added.length} مجمّعاً`,
    meta: { added: added.length, skipped: skipped.length, start: t.start_date, end: t.end_date } });

  return { template: { code: tpl.code, name: tpl.name },
    dates: { start_date: t.start_date, end_date: t.end_date },
    considered: tenants.length, added, skipped };
}));

/* ─────────────── الشاشة الرئيسية العامة ─────────────── */
/**
 * تحرير ما يراه الزائر على `/`. الكتلة تُطهَّر قبل الحفظ لا بعد القراءة فحسب،
 * فما يُخزَّن هو نفسه ما يُعرَض — ولا يبقى في القاعدة محتوى لم يمرّ على المطهِّر.
 */
router.get('/landing', h(async (req) => ({
  landing: await readLanding(req.app),
  defaults: DEFAULT_LANDING
})));

router.put('/landing', h(async (req) => {
  const app = req.app;
  const landing = normalizeLanding(req.body?.landing ?? req.body);
  await app.db.run('UPDATE platform_settings SET landing=?, updated_at=? WHERE id=1',
    JSON.stringify(landing), nowUTC());
  await plog(req, { action: 'update', entity: 'landing', entityId: 1,
    summary: `${req.ctx.adminName} ${landing.enabled ? 'حدّث ونشر' : 'حدّث'} الشاشة الرئيسية`,
    meta: { enabled: landing.enabled, features: landing.features.length,
      sections: landing.sections.length } });
  return { landing };
}));

/* ─────────────── مدراء المنصة ─────────────── */
/*
 * حسابات الادمن في جدولها المستقل: تُنشأ هنا بكلمة مرورها، ولا تُشتقّ من
 * مستخدم في مجمّع — فلا يملك أحدٌ صلاحية منصة بحكم عضويته في جهة.
 */
router.get('/admins', h(async (req) => req.app.db.all(
  `SELECT id,name,email,status,totp_enabled,last_login_at,created_at
   FROM platform_admins ORDER BY id`)));

router.post('/admins', h(async (req) => {
  const app = req.app;
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!name) throw badRequest('اسم الحساب إلزامي');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw badRequest('البريد الإلكتروني غير صالح');
  if (password.length < 8) throw badRequest('كلمة المرور لا تقل عن ٨ خانات');
  if (await app.db.get('SELECT id FROM platform_admins WHERE lower(email)=?', email)) {
    throw conflict('يوجد حساب ادمن بهذا البريد');
  }

  const r = await app.db.run(
    `INSERT INTO platform_admins(name,email,password_hash,status,created_by)
     VALUES(?,?,?,'active',?)`,
    name, email, await hashPassword(password), req.ctx.adminId);
  await plog(req, { action: 'create', entity: 'platform_admin', entityId: r.lastId,
    summary: `${req.ctx.adminName} أنشأ حساب ادمن «${name}»` });
  return created({ id: r.lastId, name, email, status: 'active' });
}));

router.patch('/admins/:id', h(async (req) => {
  const app = req.app;
  const a = await app.db.get('SELECT * FROM platform_admins WHERE id=?', req.params.id);
  if (!a) throw notFound('الحساب غير موجود');
  const b = req.body || {};

  /* إيقاف آخر حساب نشط يقفل اللوحة على الجميع */
  if (b.status === 'suspended') {
    if (a.id === req.ctx.adminId) throw badRequest('لا يمكنك إيقاف حسابك بنفسك');
    const live = await app.db.get(
      `SELECT COUNT(*) AS c FROM platform_admins WHERE status='active' AND id<>?`, a.id);
    if (live.c < 1) throw badRequest('يجب بقاء حساب ادمن نشط واحد على الأقل');
  }

  await app.db.run('UPDATE platform_admins SET name=?, status=? WHERE id=?',
    b.name?.trim() || a.name,
    ['active', 'suspended'].includes(b.status) ? b.status : a.status, a.id);

  /* إيقاف الحساب يُنهي جلساته القائمة فوراً لا عند انتهاء صلاحيتها */
  if (b.status === 'suspended') {
    await app.db.run('UPDATE admin_sessions SET revoked=1 WHERE admin_id=?', a.id);
  }
  if (b.password) {
    if (String(b.password).length < 8) throw badRequest('كلمة المرور لا تقل عن ٨ خانات');
    await app.db.run('UPDATE platform_admins SET password_hash=? WHERE id=?',
      await hashPassword(String(b.password)), a.id);
    await app.db.run('UPDATE admin_sessions SET revoked=1 WHERE admin_id=?', a.id);
  }

  await plog(req, { action: 'update', entity: 'platform_admin', entityId: a.id,
    summary: `${req.ctx.adminName} حدّث حساب الادمن «${a.name}»` });
  return app.db.get('SELECT id,name,email,status,totp_enabled,last_login_at FROM platform_admins WHERE id=?', a.id);
}));

router.delete('/admins/:id', h(async (req) => {
  const app = req.app;
  const id = Number(req.params.id);
  if (id === req.ctx.adminId) throw badRequest('لا يمكنك حذف حسابك بنفسك');
  const count = await app.db.get('SELECT COUNT(*) AS c FROM platform_admins');
  if (count.c <= 1) throw badRequest('يجب بقاء حساب ادمن واحد على الأقل');
  const a = await app.db.get('SELECT * FROM platform_admins WHERE id=?', id);
  if (!a) throw notFound('الحساب غير موجود');
  await app.db.run('DELETE FROM platform_admins WHERE id=?', id);
  await plog(req, { action: 'delete', entity: 'platform_admin', entityId: id,
    summary: `${req.ctx.adminName} حذف حساب الادمن «${a.name}»` });
  return { ok: true };
}));

/* ─────────────── تشغيل وظائف الصيانة عند الطلب ─────────────── */
const JOB_LABELS = {
  subscriptions: 'دورة الاشتراكات والفوترة',
  sla: 'تصعيد تذاكر مستوى الخدمة',
  kpi: 'إعادة احتساب مؤشرات الأداء',
  deadlines: 'تذكير المهام المستحقة',
  backup: 'النسخ الاحتياطي اليومي',
  metrics: 'لقطة مؤشرات المنصة والصيانة'
};

const JOBS = {
  ...Object.fromEntries(JOB_KEYS.map(k => [k, {
    label: JOB_LABELS[k] || k,
    run: (app, opts) => periodic[k](app, opts)
  }])),
  queue: {
    label: 'تصريف طابور المعالجة',
    run: async (app) => ({ drained: await drain(app, { max: 50 }), requeued: await requeueStuck(app) })
  }
};

router.get('/jobs', h(async () =>
  Object.entries(JOBS).map(([key, j]) => ({ key, label: j.label }))));

/** تشغيل وظيفة دورية فوراً بدل انتظار مؤقّتها — للصيانة والتشخيص */
router.post('/jobs/:name/run', h(async (req) => {
  const job = JOBS[req.params.name];
  if (!job) throw notFound('وظيفة غير معروفة');
  const started = Date.now();
  const result = await job.run(req.app, {
    trigger: 'manual', actorId: req.ctx.adminId, actorName: req.ctx.adminName });
  await plog(req, { action: 'update', entity: 'job', entityId: req.params.name,
    summary: `${req.ctx.adminName} شغّل «${job.label}» يدوياً`, meta: result });
  return { job: req.params.name, label: job.label, ms: Date.now() - started, result };
}));


/* ═══════════════ المستوى ١: النمو وسجل التشغيل ═══════════════ */

/** سلسلة المؤشرات الزمنية مع دلتا الفترة ونسبة التسرّب */
router.get('/metrics', h(async (req) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
  const [series, conversion, forecast] = await Promise.all([
    metricsSeries(req.app, { days }),
    trialConversion(req.app, { days: Math.max(30, days) }),
    revenueForecast(req.app)
  ]);
  return { ...series, trial_conversion: conversion, forecast };
}));

/** التقاط لقطة الآن بدل انتظار المؤقّت اليومي */
router.post('/metrics/snapshot', h(async (req) => {
  const m = await snapshotMetrics(req.app);
  await plog(req, { action: 'create', entity: 'metrics', entityId: m.date,
    summary: `${req.ctx.adminName} التقط لقطة مؤشرات ليوم ${m.date}` });
  return created(m);
}));

/** صحة الوظائف الدورية: آخر تشغيل لكل وظيفة وإخفاقات اليوم */
router.get('/jobs/health', h(async (req) => {
  const health = await jobsHealth(req.app);
  const known = new Set(health.map(h2 => h2.job));
  const never = JOB_KEYS.filter(k => !known.has(k)).map(job => ({ job, status: 'never', failures_24h: 0 }));
  return {
    jobs: [...health, ...never],
    failing: health.filter(h2 => h2.status === 'failed').length,
    stale: health.filter(h2 => h2.started_at && Date.now() - new Date(h2.started_at) > 48 * 3600_000).length
  };
}));

router.get('/jobs/runs', h(async (req) => jobRuns(req.app, {
  job: req.query.job || null, status: req.query.status || null,
  limit: Number(req.query.limit) || 100
})));

/* ═══════════════ المستوى ٢: صحة الجهات والبث والدعم ═══════════════ */

router.get('/health', h(async (req) => tenantsHealth(req.app)));

router.get('/health/risk-labels', h(async () => RISK_AR));

/* الإعلانات والبث */
router.get('/announcements', h(async (req) => ({
  items: await listAnnouncements(req.app),
  audiences: AUDIENCES.map(a => ({ key: a, label: AUDIENCE_AR[a] })),
  severities: Object.entries(SEVERITY_AR).map(([key, label]) => ({ key, label }))
})));

router.post('/announcements', h(async (req) => {
  const b = req.body || {};
  const out = await createAnnouncement(req.app, {
    title: b.title, body: b.body, url: b.url, severity: b.severity || 'info',
    audience: b.audience || 'all', audienceValue: b.audience_value || null,
    banner: !!b.banner, push: b.push !== false,
    startsAt: b.starts_at || null, endsAt: b.ends_at || null,
    send: b.send !== false,
    createdBy: req.ctx.adminId, createdByName: req.ctx.adminName
  });
  await plog(req, { action: 'create', entity: 'announcement', entityId: out.id,
    summary: `${req.ctx.adminName} بثّ إعلان «${out.title}» إلى ${out.tenants} جهة (${out.recipients} مستخدم)`,
    meta: { audience: out.audience, severity: out.severity } });
  return created(out);
}));

router.delete('/announcements/:id', h(async (req) => {
  const a = await req.app.db.get('SELECT * FROM announcements WHERE id=?', req.params.id);
  if (!a) throw notFound('الإعلان غير موجود');
  await deleteAnnouncement(req.app, a.id);
  await plog(req, { action: 'delete', entity: 'announcement', entityId: a.id,
    summary: `${req.ctx.adminName} حذف الإعلان «${a.title}»` });
  return { ok: true };
}));

/* صندوق الدعم الموحّد: التذاكر المُصعَّدة من الجهات إلى مزوّد المنصة */
router.get('/support', h(async (req) => {
  const status = req.query.status || null;
  const rows = await req.app.db.all(
    `SELECT k.id, k.number, k.subject, k.body, k.category, k.priority, k.status,
            k.vendor_status, k.vendor_reply, k.vendor_escalated_at, k.vendor_replied_at, k.created_at,
            t.id AS tenant_id, t.name AS tenant_name, t.code AS tenant_code,
            u.name AS requester_name, u.email AS requester_email,
            p.name AS plan_name
     FROM tickets k
     JOIN tenants t ON t.id = k.tenant_id
     LEFT JOIN users u ON u.id = k.requester_id
     LEFT JOIN subscriptions s ON s.tenant_id = t.id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE k.vendor_escalated = 1 ${status ? 'AND k.vendor_status = ?' : ''}
     ORDER BY (k.vendor_status='open') DESC, k.vendor_escalated_at DESC LIMIT 200`,
    ...(status ? [status] : []));
  const open = rows.filter(r => r.vendor_status === 'open').length;
  return { items: rows, open, total: rows.length };
}));

router.post('/support/:id/reply', h(async (req) => {
  const app = req.app;
  const k = await app.db.get('SELECT * FROM tickets WHERE id=? AND vendor_escalated=1', req.params.id);
  if (!k) throw notFound('التذكرة غير مُصعَّدة إلى المنصة');
  const body = String(req.body?.reply || '').trim();
  if (!body) throw badRequest('نص الرد إلزامي');
  const close = req.body?.close !== false;

  await app.db.run(
    `UPDATE tickets SET vendor_reply=?, vendor_replied_at=?, vendor_status=? WHERE id=?`,
    body, nowUTC(), close ? 'closed' : 'answered', k.id);

  /* الرد يُحفظ على التذكرة نفسها فيظهر لصاحبها في شاشة الدعم داخل جهته */
  await notifyUsers(app, k.tenant_id, [k.requester_id], {
    type: 'ticket.vendor_reply', category: 'tickets',
    title: `ردّ دعم المنصة على التذكرة ${k.number || k.id}`,
    body: body.slice(0, 140), url: `/tickets?id=${k.id}`, urgency: 'high',
    data: { id: k.id, ticket_number: k.number }
  }).catch(() => {});

  await plog(req, { action: 'update', entity: 'ticket', entityId: k.id, tenantId: k.tenant_id,
    summary: `${req.ctx.adminName} ردّ على تذكرة مُصعَّدة (${k.subject})` });
  return { ok: true, closed: close };
}));

/* ملاحظات الجهة ومتابعتها التجارية */
router.get('/tenants/:id/notes', h(async (req) => req.app.db.all(
  'SELECT * FROM tenant_notes WHERE tenant_id=? ORDER BY pinned DESC, id DESC LIMIT 100', req.params.id)));

router.post('/tenants/:id/notes', h(async (req) => {
  const body = String(req.body?.body || '').trim();
  if (!body) throw badRequest('نص الملاحظة إلزامي');
  const r = await req.app.db.run(
    'INSERT INTO tenant_notes(tenant_id,author_id,author_name,body,pinned) VALUES(?,?,?,?,?)',
    req.params.id, req.ctx.adminId, req.ctx.adminName, body, req.body?.pinned ? 1 : 0);
  return created(await req.app.db.get('SELECT * FROM tenant_notes WHERE id=?', r.lastId));
}));

router.delete('/tenants/:id/notes/:noteId', h(async (req) => {
  await req.app.db.run('DELETE FROM tenant_notes WHERE id=? AND tenant_id=?', req.params.noteId, req.params.id);
  return { ok: true };
}));

router.put('/tenants/:id/crm', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');
  const b = req.body || {};
  const STAGES = ['lead', 'onboarding', 'active', 'at_risk', 'churned'];
  /* مرحلة مجهولة تُرفض بدل أن تُتجاهَل صامتةً فيظن المستخدم أنها حُفظت */
  if (b.crm_stage != null && b.crm_stage !== '' && !STAGES.includes(b.crm_stage)) {
    throw badRequest(`مرحلة غير معروفة — المراحل المتاحة: ${STAGES.join('، ')}`);
  }
  await app.db.run(
    'UPDATE tenants SET contact_name=?, contact_phone=?, crm_stage=?, crm_source=? WHERE id=?',
    b.contact_name ?? t.contact_name, b.contact_phone ?? t.contact_phone,
    b.crm_stage === '' ? null : (b.crm_stage ?? t.crm_stage),
    b.crm_source ?? t.crm_source, t.id);
  await plog(req, { action: 'update', entity: 'tenant', entityId: t.id, tenantId: t.id,
    summary: `${req.ctx.adminName} حدّث بيانات متابعة «${t.name}»` });
  return app.db.get('SELECT * FROM tenants WHERE id=?', t.id);
}));

/* ═══════════════ المستوى ٣: الأمن والامتثال ═══════════════ */

router.get('/security', h(async (req) => loginSecurityReport(req.app, {
  hours: Math.min(720, Number(req.query.hours) || 24),
  limit: Number(req.query.limit) || 100
})));

/** سلامة سلسلة تجزئة الفواتير الإلكترونية */
router.get('/einvoice/chain', h(async (req) => verifyChain(req.app)));

router.get('/einvoice/:id', h(async (req) => {
  const inv = await req.app.db.get('SELECT * FROM subscription_invoices WHERE id=?', req.params.id);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  if (!inv.zatca_qr) throw badRequest('لم تُختم هذه الفاتورة إلكترونياً');
  return {
    number: inv.number, uuid: inv.zatca_uuid, qr: inv.zatca_qr,
    fields: decodeQR(inv.zatca_qr),
    hash: inv.zatca_hash, previous_hash: inv.zatca_prev_hash, xml_key: inv.zatca_xml_key
  };
}));

/** تصدير كامل لبيانات جهة — حق نقل البيانات في نظام حماية البيانات الشخصية */
router.get('/tenants/:id/export', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');

  const { sql, tables, rows } = await dumpSQL(app, { tenantId: t.id });
  const body = await gzip(new TextEncoder().encode(sql));
  await plog(req, { action: 'export', entity: 'tenant', entityId: t.id, tenantId: t.id,
    summary: `${req.ctx.adminName} صدّر بيانات «${t.name}» كاملةً (${rows} سجل من ${tables} جدول)`,
    meta: { tables, rows } });

  return new Response(body, { headers: {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${t.code}-export-${new Date().toISOString().slice(0, 10)}.sql.gz"`
  } });
}));

/* ═══════════════ المستوى ٤: الكوبونات والدائن والبوابة والتجاوزات ═══════════════ */

router.get('/coupons', h(async (req) => couponsReport(req.app)));

router.post('/coupons', h(async (req) => {
  const b = req.body || {};
  const code = normalizeCouponCode(b.code);
  if (!code) throw badRequest('رمز الكوبون إلزامي (إنجليزي وأرقام)');
  if (!String(b.name || '').trim()) throw badRequest('اسم الكوبون إلزامي');
  if (!['percent', 'fixed'].includes(b.type)) throw badRequest('نوع الخصم غير مدعوم');
  const value = Number(b.value || 0);
  if (!(value > 0)) throw badRequest('قيمة الخصم يجب أن تكون أكبر من صفر');
  if (b.type === 'percent' && value > 100) throw badRequest('نسبة الخصم لا تتجاوز ١٠٠٪');
  if (await req.app.db.get('SELECT id FROM coupons WHERE code=?', code)) throw conflict('رمز الكوبون مستخدم مسبقاً');

  const r = await req.app.db.run(
    `INSERT INTO coupons(code,name,type,value,currency,duration,duration_months,applies_to,
       max_redemptions,valid_from,valid_until,is_active,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, String(b.name).trim(), b.type, value, b.currency || 'SAR',
    ['once', 'forever', 'months'].includes(b.duration) ? b.duration : 'once',
    b.duration_months ? Number(b.duration_months) : null,
    JSON.stringify(Array.isArray(b.applies_to) ? b.applies_to : []),
    b.max_redemptions ? Number(b.max_redemptions) : null,
    b.valid_from || null, b.valid_until || null,
    b.is_active === false ? 0 : 1, req.ctx.adminId);

  await plog(req, { action: 'create', entity: 'coupon', entityId: r.lastId,
    summary: `${req.ctx.adminName} أنشأ كوبون «${code}» بخصم ${value}${b.type === 'percent' ? '٪' : ''}` });
  return created(await req.app.db.get('SELECT * FROM coupons WHERE id=?', r.lastId));
}));

router.patch('/coupons/:id', h(async (req) => {
  const app = req.app;
  const c = await app.db.get('SELECT * FROM coupons WHERE id=?', req.params.id);
  if (!c) throw notFound('الكوبون غير موجود');
  const b = req.body || {};
  await app.db.run(
    `UPDATE coupons SET name=?, value=?, max_redemptions=?, valid_until=?, is_active=?, applies_to=? WHERE id=?`,
    b.name?.trim() || c.name,
    b.value !== undefined ? Number(b.value) : c.value,
    b.max_redemptions !== undefined ? (b.max_redemptions === null || b.max_redemptions === '' ? null : Number(b.max_redemptions)) : c.max_redemptions,
    b.valid_until !== undefined ? (b.valid_until || null) : c.valid_until,
    b.is_active === undefined ? c.is_active : (b.is_active ? 1 : 0),
    Array.isArray(b.applies_to) ? JSON.stringify(b.applies_to) : c.applies_to,
    c.id);
  await plog(req, { action: 'update', entity: 'coupon', entityId: c.id,
    summary: `${req.ctx.adminName} حدّث كوبون «${c.code}»` });
  return app.db.get('SELECT * FROM coupons WHERE id=?', c.id);
}));

router.delete('/coupons/:id', h(async (req) => {
  const app = req.app;
  const c = await app.db.get('SELECT * FROM coupons WHERE id=?', req.params.id);
  if (!c) throw notFound('الكوبون غير موجود');
  if (c.redemptions > 0) throw conflict(`الكوبون مُستخدَم ${c.redemptions} مرة — عطّله بدل حذفه`);
  await app.db.run('DELETE FROM coupons WHERE id=?', c.id);
  await plog(req, { action: 'delete', entity: 'coupon', entityId: c.id,
    summary: `${req.ctx.adminName} حذف كوبون «${c.code}»` });
  return { ok: true };
}));

/** إشعار دائن على فاتورة صادرة */
router.post('/invoices/:id/credit-note', h(async (req) => {
  const app = req.app;
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', req.params.id);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  const note = await issueCreditNote(app, inv.id, {
    amount: req.body?.amount !== undefined ? Number(req.body.amount) : null,
    reason: req.body?.reason || '', createdBy: req.ctx.adminId
  });
  await plog(req, { action: 'create', entity: 'credit_note', entityId: note.id, tenantId: inv.tenant_id,
    summary: `${req.ctx.adminName} أصدر إشعاراً دائناً ${note.number} بمبلغ ${note.total} على الفاتورة ${inv.number}` });
  return created(note);
}));

/** حدود ومزايا خاصة بجهة (صفقات مخصّصة) */
router.put('/tenants/:id/overrides', h(async (req) => {
  const app = req.app;
  const t = await app.db.get('SELECT * FROM tenants WHERE id=?', req.params.id);
  if (!t) throw notFound('الجهة غير موجودة');

  const limits = {};
  for (const key of ['branches', 'users', 'storage_mb']) {
    if (!(key in (req.body?.limits || {}))) continue;
    const v = req.body.limits[key];
    if (v === null || v === '' || v === 'unlimited') limits[key] = null;
    else if (Number.isFinite(Number(v)) && Number(v) >= 0) limits[key] = Number(v);
  }
  const known = new Set(FEATURES.map(f => f.key));
  const features = {};
  for (const [k, v] of Object.entries(req.body?.features || {})) {
    if (known.has(k)) features[k] = !!v;
  }

  await app.db.run('UPDATE tenants SET limit_overrides=?, feature_overrides=? WHERE id=?',
    JSON.stringify(limits), JSON.stringify(features), t.id);
  await plog(req, { action: 'update', entity: 'tenant', entityId: t.id, tenantId: t.id,
    summary: `${req.ctx.adminName} ضبط حدوداً ومزايا خاصة لـ«${t.name}»`,
    meta: { limits, features } });

  const sub = await tenantSubscription(app, t.id);
  const fresh = await app.db.get('SELECT * FROM tenants WHERE id=?', t.id);
  return {
    limits: sub?.plan ? effectiveLimits(sub.plan, fresh) : null,
    features: sub?.plan ? effectiveFeatures(sub.plan, fresh) : null,
    overrides: { limits, features }
  };
}));

/** كتالوج المزايا لبناء واجهة التجاوزات */
router.get('/features', h(async () => FEATURES));

/** بوابات الدفع المتاحة */
router.get('/gateways', h(async (req) => {
  const s = await platformSettings(req.app);
  return {
    current: s.payment_gateway,
    configured: !!(j(s.gateway_config, {})?.secret_key),
    options: Object.values(GATEWAYS)
  };
}));

/** إشعار البوابة — مسار مفتوح تُناديه البوابة نفسها */
export async function paymentWebhook(app, body) {
  const ref = body?.data?.id || body?.id || body?.charge?.id;
  const status = body?.data?.status || body?.status;
  if (!ref) return { matched: false };
  return handleWebhook(app, { gatewayRef: ref, status: status === 'paid' || status === 'CAPTURED' ? 'paid' : status });
}

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
