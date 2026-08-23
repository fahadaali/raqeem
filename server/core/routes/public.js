import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, forbidden, conflict } from '../errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { hashPassword, randomToken, sha256Hex } from '../crypto.js';
import { platformSettings, yearlySavings, planLimits } from '../billing.js';
import { provisionTenant, codeAvailable, emailAvailable, normalizeCode } from '../provision.js';
import { readLanding } from '../landing.js';

/**
 * الواجهات العامة للمرحلة الثانية (لا تتطلّب تسجيل دخول):
 *   • هوية المنصة وصفحة الأسعار
 *   • التسجيل الآلي للجهات الجديدة (Onboarding)
 *   • هوية الجهة حسب النطاق (White-labeling)
 */
const router = new Hono();

/* حدّ عام خفيف لكل الواجهات العامة، وحدّ أضيق لإنشاء الجهات فعلياً */
const probeLimit = rateLimit({ windowMs: 60_000, max: 60, key: (r) => `pub:${r.ip}` });
const signupLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, key: (r) => `signup:${r.ip}` });

/**
 * التحقق من فتح التسجيل يسبق الحدّ من الطلبات عمداً:
 * صفحة تسجيل مغلقة يجب أن تقول «مغلقة» لا «تجاوزت الحد».
 */
const signupOpen = async (c, next) => {
  const app = c.get('app');
  const s = await platformSettings(app);
  if (!s.saas_enabled || !s.signup_enabled) {
    throw forbidden('التسجيل الذاتي مغلق حالياً — تواصل مع إدارة المنصة');
  }
  return next();
};

router.use('*', probeLimit);

const publicPlan = (p) => ({
  code: p.code, name: p.name, name_en: p.name_en, tagline: p.tagline, description: p.description,
  price_monthly: p.price_monthly, price_yearly: p.price_yearly, currency: p.currency,
  trial_days: p.trial_days, limits: planLimits(p), features: j(p.features, []) || [],
  perks: j(p.perks, []) || [], highlight: !!p.highlight, yearly_savings: yearlySavings(p), sort: p.sort
});

/* ─────────────── هوية المنصة ─────────────── */
router.get('/platform', h(async (req) => {
  const s = await platformSettings(req.app);
  const tenants = (await req.app.db.get(`SELECT COUNT(*) AS c FROM tenants WHERE status='active'`)).c;
  return {
    name: s.platform_name, name_en: s.platform_name_en, tagline: s.tagline,
    support_email: s.support_email, support_phone: s.support_phone,
    saas_enabled: !!s.saas_enabled,
    signup_enabled: !!(s.saas_enabled && s.signup_enabled),
    signup_needs_review: !!s.signup_needs_review,
    trial_days: s.trial_days, currency: s.currency, vat_rate: s.vat_rate,
    tenants_count: tenants,
    /*
     * أزرار «الحسابات التجريبية» في شاشة الدخول تفتح حساباً كامل الصلاحية بنقرة،
     * فلا يجوز ظهورها على نسخة منشورة. الخادم وحده يقرّر ذلك من بيئة التشغيل،
     * والافتراض المغلق: أي نسخة ليست تطويرية صريحة تُعدّ إنتاجاً.
     */
    demo_logins: req.app.cfg.env === 'development'
  };
}));

/** هوية الجهة المرتبطة بالنطاق الحالي — تقرأها شاشة الدخول (تخصيص ديناميكي) */
router.get('/brand', h(async (req) => {
  const app = req.app;
  const host = String(req.get('host') || '').toLowerCase().split(':')[0];
  const settings = await platformSettings(app);

  let tenant = host ? await app.db.get('SELECT * FROM tenants WHERE lower(custom_domain)=?', host) : null;
  if (!tenant && host) {
    const sub = normalizeCode(host.split('.')[0]);
    if (sub) tenant = await app.db.get(`SELECT * FROM tenants WHERE code=? AND status='active'`, sub);
  }
  /*
   * لا تراجعَ إلى جهةٍ بعينها البتّة.
   *
   * شاشة الدخول على نطاق المنصّة تخدم المجمّعات كلَّها، فاسمُها اسمُ المنصّة —
   * ولو لم يكن فيها إلا مجمّعٌ واحدٌ اليوم. والتخصيص طريقُه النطاق وحده: من ربط
   * نطاقه الخاص أو نطاقاً فرعياً باسم جهته وصله برنده من الاستعلام أعلاه.
   *
   * (كان هنا تراجعٌ إلى الجهة الأولى — مرّةً حين تُطفأ طبقة الـ SaaS، ثم حين
   *  تكون الجهة واحدة — وكلاهما يضع اسم مجمّعٍ على بابٍ ليس له.)
   */

  return {
    platform: { name: settings.platform_name, tagline: settings.tagline, saas_enabled: !!settings.saas_enabled },
    tenant: tenant ? {
      id: tenant.id, code: tenant.code, name: tenant.name, name_en: tenant.name_en,
      logo_url: tenant.logo_url,
      colors: { primary: tenant.primary_color, accent: tenant.accent_color }
    } : null
  };
}));

/* ─────────────── الشاشة الرئيسية العامة ─────────────── */
/**
 * محتوى الصفحة التعريفية للزائر. مفتوح بلا مصادقة عمداً — هذه هي الصفحة التي
 * يراها من لا حساب له. وحين تكون مطفأة يعود `/` إلى شاشة الدخول كما كان.
 */
router.get('/landing', h(async (req) => {
  const landing = await readLanding(req.app);
  const s = await platformSettings(req.app);
  return {
    ...landing,
    platform: {
      name: s.platform_name, name_en: s.platform_name_en, tagline: s.tagline,
      support_email: s.support_email, support_phone: s.support_phone,
      saas_enabled: !!s.saas_enabled,
      signup_enabled: !!(s.saas_enabled && s.signup_enabled)
    }
  };
}));

/* ─────────────── خطط الأسعار ─────────────── */
router.get('/plans', h(async (req) => {
  const s = await platformSettings(req.app);
  const rows = await req.app.db.all(
    'SELECT * FROM plans WHERE is_active=1 AND is_public=1 ORDER BY sort, price_monthly');
  return {
    currency: s.currency, vat_rate: s.vat_rate, trial_days: s.trial_days,
    plans: rows.map(publicPlan)
  };
}));

/* ─────────────── التسجيل الآلي ─────────────── */
router.get('/signup/availability', h(async (req) => {
  const out = {};
  if (req.query.code !== undefined) out.code = await codeAvailable(req.app, req.query.code);
  if (req.query.email !== undefined) out.email = await emailAvailable(req.app, req.query.email);
  if (!Object.keys(out).length) throw badRequest('حدّد code أو email للتحقق');
  return out;
}));

router.post('/signup', signupOpen, signupLimit, h(async (req) => {
  const app = req.app;
  const settings = await platformSettings(app);

  const b = req.body || {};
  const planCode = String(b.plan_code || settings.default_plan_code);
  const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';

  const plan = await app.db.get('SELECT * FROM plans WHERE code=? AND is_active=1 AND is_public=1', planCode);
  if (!plan) throw badRequest('الخطة المطلوبة غير متاحة للتسجيل');

  const codeCheck = await codeAvailable(app, b.code);
  if (!codeCheck.available) {
    throw conflict(codeCheck.reserved ? 'هذا الرمز محجوز للمنصة، اختر رمزاً آخر' : 'رمز الجهة مستخدم مسبقاً');
  }
  const mailCheck = await emailAvailable(app, b.email);
  if (mailCheck.invalid) throw badRequest('البريد الإلكتروني غير صالح');
  if (!mailCheck.available) throw conflict('البريد الإلكتروني مسجّل مسبقاً في المنصة');
  if (String(b.password || '').length < 8) throw badRequest('كلمة المرور يجب ألا تقل عن ٨ خانات');
  if (!String(b.tenant_name || '').trim()) throw badRequest('اسم الجهة التعليمية إلزامي');
  if (!String(b.admin_name || '').trim()) throw badRequest('اسم مدير الجهة إلزامي');

  const passwordHash = await hashPassword(String(b.password));
  const token = randomToken(24);

  const rec = await app.db.run(
    `INSERT INTO signups(code,tenant_name,admin_name,email,phone,plan_code,cycle,status,
       verify_hash,password_hash,ip,user_agent)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    codeCheck.code, String(b.tenant_name).trim(), String(b.admin_name).trim(), mailCheck.email,
    b.phone || null, planCode, cycle,
    settings.signup_needs_review ? 'pending' : 'verified',
    await sha256Hex(token), passwordHash, req.ip || '', (req.get('user-agent') || '').slice(0, 250));

  /* مراجعة يدوية: ينتظر الطلب اعتماد مالك المنصة */
  if (settings.signup_needs_review) {
    return created({
      status: 'pending_review',
      request_id: rec.lastId,
      message: 'استلمنا طلبك — سيصلك تأكيد التفعيل بعد مراجعة إدارة المنصة'
    });
  }

  /* تفعيل فوري بفترة تجريبية */
  const result = await provisionTenant(app, {
    code: codeCheck.code,
    name: String(b.tenant_name).trim(),
    adminName: String(b.admin_name).trim(),
    email: mailCheck.email,
    passwordHash,
    phone: b.phone || null,
    planCode, cycle
  });

  await app.db.run(
    `UPDATE signups SET status='provisioned', tenant_id=?, verified_at=?, provisioned_at=? WHERE id=?`,
    result.tenant.id, nowUTC(), nowUTC(), rec.lastId);

  return created({
    status: 'active',
    tenant: { id: result.tenant.id, code: result.tenant.code, name: result.tenant.name },
    login: { email: mailCheck.email },
    subscription: result.subscription && {
      plan: result.subscription.plan?.code,
      status: result.subscription.status,
      trial_ends_at: result.subscription.trial_ends_at
    },
    message: 'تم إنشاء جهتك بنجاح — يمكنك تسجيل الدخول الآن'
  });
}));

export default router;
