import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created, status } from '../http.js';
import { badRequest, unauthorized, notFound, tooMany } from '../errors.js';
import { authenticate, buildContext, signAccess, issueRefresh, consumeRefresh, revokeRefresh,
  hashPassword, verifyPassword, needsRehash } from '../middleware/auth.js';
import { rateLimit, recordFailure, clearFailures, failureCount } from '../middleware/rateLimit.js';
import { audit } from '../middleware/audit.js';
import { currentTerm } from '../scope.js';
import { pushEnabled, publicKey } from '../push.js';
import { platformSettings, tenantSubscription, subscriptionWritable, subscriptionBlockReason, STATUS_AR } from '../billing.js';
import { recordLoginAttempt, assertSecondFactor, needsTotpSetup, generateTotpSecret, totpUri,
  verifyTotp, generateBackupCodes, hashBackupCodes } from '../security.js';
import { activeBanners } from '../announce.js';
import { adminLogin } from './admin-auth.js';

const router = new Hono();
const LOCK_WINDOW = 15 * 60_000;

/** ملخّص الجلسة الذي تعتمد عليه الواجهة المرنة (البند ١) */
export async function sessionPayload(app, ctx) {
  const settings = await platformSettings(app);
  const sub = await tenantSubscription(app, ctx.tenantId);
  const branches = ctx.branchIds.length
    ? await app.db.all(`SELECT id,code,name,address,lat,lng,geofence_radius FROM branches
        WHERE tenant_id=? AND id IN (${ctx.branchIds.map(() => '?').join(',')}) AND is_active=1 ORDER BY code`,
      ctx.tenantId, ...ctx.branchIds)
    : [];
  const terms = await app.db.all(
    'SELECT id,code,name,start_date,end_date,status,is_current FROM terms WHERE tenant_id=? ORDER BY start_date DESC',
    ctx.tenantId);
  return {
    user: {
      id: ctx.userId, name: ctx.userName, email: ctx.email,
      role: { id: ctx.roleId, key: ctx.roleKey, name: ctx.roleName, level: ctx.roleLevel },
      primary_branch_id: ctx.primaryBranchId,
      calendar_pref: ctx.calendarPref,
      theme_pref: ctx.user.theme_pref,
      notify_prefs: ctx.notifyPrefs,
      avatar_url: ctx.user.avatar_url
    },
    tenant: {
      id: ctx.tenantId, name: ctx.tenantName, code: ctx.tenantCode,
      logo_url: ctx.tenantLogo, colors: ctx.tenantColors,
      calendar_default: ctx.user.calendar_default, settings: ctx.tenantSettings
    },
    permissions: ctx.perms,
    branches,
    all_branches: ctx.allBranches,
    terms,
    current_term: await currentTerm(app, ctx.tenantId),
    push: { enabled: pushEnabled(app.cfg), publicKey: publicKey(app.cfg) },
    /* المرحلة الثانية: هوية المنصة وحالة اشتراك الجهة */
    platform: {
      name: settings.platform_name,
      saas_enabled: !!settings.saas_enabled,
      is_platform_admin: !!ctx.isPlatformAdmin,
      totp_enabled: !!ctx.user.totp_enabled,
      totp_required: needsTotpSetup(ctx.user, settings)
    },
    /* إعلانات المنصة النشطة التي تخصّ هذه الجهة */
    banners: await activeBanners(app, {
      tenantId: ctx.tenantId, planCode: ctx.planCode, subStatus: sub?.status || null
    }).catch(() => []),
    /* مزايا الخطة النافذة — تقرأها الواجهة لإخفاء ما ليس مشمولاً */
    features: ctx.features,
    subscription: sub ? {
      plan: sub.plan?.code, plan_name: sub.plan?.name,
      status: sub.status, status_label: STATUS_AR[sub.status] || sub.status,
      trial_ends_at: sub.trial_ends_at,
      current_period_end: sub.current_period_end,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      writable: subscriptionWritable(sub),
      block_reason: subscriptionBlockReason(sub)
    } : null
  };
}

const userLockKey = (email) => `pw:${String(email).trim().toLowerCase()}`;

/**
 * التحقّق من حساب منسوبٍ في مجمّع وإصدار جلسته.
 * الرمز الصادر يحمل `tid` بلا `adm`، فلا يفتح إلا مسارات المجمّعات.
 * @returns {{ found: boolean, valid: boolean, result?: object }} على نسق `adminLogin`
 */
async function userLogin(app, req, { email, password, totp }) {
  const account = userLockKey(email);
  if (failureCount(account, LOCK_WINDOW) >= app.cfg.rateLimit.loginAccountMax) {
    throw tooMany('تم إيقاف المحاولات مؤقتاً بعد عدة محاولات فاشلة — أعد المحاولة بعد ١٥ دقيقة أو راجع الإدارة');
  }

  const attempt = (success, reason, u = null) => recordLoginAttempt(app, {
    email, tenantId: u?.tenant_id ?? null, userId: u?.id ?? null,
    success, reason, ip: req.ip, userAgent: req.get('user-agent') || ''
  });

  const user = await app.db.get('SELECT * FROM users WHERE lower(email)=lower(?)', String(email).trim());
  const valid = user && await verifyPassword(String(password), user.password_hash);
  if (!valid) {
    recordFailure(account, LOCK_WINDOW);
    await attempt(false, user ? 'كلمة مرور خاطئة' : 'حساب غير موجود', user);
    return { found: !!user, valid: false };
  }
  if (user.status !== 'active') {
    await attempt(false, 'الحساب موقوف', user);
    throw unauthorized('الحساب موقوف، يرجى مراجعة الإدارة');
  }
  clearFailures(account);

  /* التحقّق بخطوتين — إلزامي لمالكي المنصة عند تفعيله في الإعدادات */
  if (user.totp_enabled) {
    const token = String(totp || '').trim();
    if (!token) {
      await attempt(false, 'بانتظار رمز التحقّق بخطوتين', user);
      return { found: true, valid: true,
        result: status(401, { error: { code: 'TOTP_REQUIRED', message: 'أدخل رمز التحقّق بخطوتين' } }) };
    }
    try {
      await assertSecondFactor(app, user, token, j(user.totp_backup, []) || []);
    } catch (e) {
      await attempt(false, 'رمز تحقّق خاطئ', user);
      throw e;
    }
  }
  await attempt(true, null, user);

  // ترقية صامتة لتجزئات كلمات المرور القديمة
  if (needsRehash(user.password_hash)) {
    const fresh = await hashPassword(String(password));
    await app.db.run('UPDATE users SET password_hash=? WHERE id=?', fresh, user.id);
  }

  const ctx = await buildContext(app, user.id);
  if (!ctx) throw unauthorized();
  await app.db.run('UPDATE users SET last_login_at=? WHERE id=?', nowUTC(), user.id);

  const accessToken = await signAccess(app, ctx);
  const refreshToken = await issueRefresh(app, ctx, req);

  req.ctx = ctx;
  await audit(req, { action: 'login', entity: 'user', entityId: user.id, summary: `${ctx.userName} سجّل الدخول للمنصة` });

  return { found: true, valid: true,
    result: { kind: 'user', accessToken, refreshToken, ...(await sessionPayload(app, ctx)) } };
}

/**
 * الدخول الموحّد — بابٌ واحد للجميع، والخادمُ وحده يحسم نوع الحساب.
 *
 * البريد وكلمة المرور يُقاسان على حسابات المجمّعات أولاً ثم على حسابات إدارة
 * المنصة، ويُردّ `kind` يقول للواجهة أي لوحةٍ تفتح. ولا يُقبَل من الواجهة أي
 * تلميحٍ عن النوع: ما يفتح اللوحة هو الرمز الصادر لا ما طلبه المتصفّح، والرمزان
 * مختلفا الجمهور يرفض كلُّ حارسٍ رمزَ الآخر صراحةً — فلا يرفع البابُ الواحد
 * صلاحيةَ أحد.
 *
 * والفشل رسالةٌ واحدة أياً كان السبب فلا يُستدلّ منها على وجود حساب، والقفلُ
 * يُحسب على مفتاحَي الطبقتين معاً فلا يضاعف البابُ الموحّد رصيدَ المحاولات
 * الذي يمنحه بابُ اللوحة وحده. والتقييد بحسب المحاولات الفاشلة لكل حساب، مع
 * سقف واسع لكل عنوان شبكة حتى لا تُحجب جهة كاملة تشترك في عنوان واحد (NAT).
 *
 * وإن صحّت بياناتٌ للطبقتين معاً (بريدٌ واحد بكلمة مرورٍ واحدة في الجدولين)
 * قُدّم حساب المجمّع — الأقلّ صلاحيةً — ولوحة المنصة تبقى من بابها المستقل.
 */
router.post('/login',
  rateLimit({ windowMs: 60_000, max: (r, c) => c.get('app').cfg.rateLimit.loginIpMax, key: (r) => `login:${r.ip}` }),
  h(async (req) => {
    const app = req.app;
    const { email, password, totp } = req.body || {};
    if (!email || !password) throw badRequest('يرجى إدخال البريد الإلكتروني وكلمة المرور');

    const asUser = await userLogin(app, req, { email, password, totp });
    if (asUser.valid) return asUser.result;

    const asAdmin = await adminLogin(app, req, { email, password, totp });
    if (asAdmin.valid) return asAdmin.result;

    /* فشل الطبقتين معاً: كلٌّ سجّلت محاولتها على مفتاحها، والردّ لا يميّز بينهما */
    throw unauthorized('بيانات الدخول غير صحيحة');
  }));

router.post('/refresh', h(async (req) => {
  const row = await consumeRefresh(req.app, req.body?.refreshToken);
  if (!row) throw unauthorized('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
  const ctx = await buildContext(req.app, row.user_id);
  if (!ctx) throw unauthorized();
  return { accessToken: await signAccess(req.app, ctx), ...(await sessionPayload(req.app, ctx)) };
}));

router.post('/logout', h(async (req) => {
  await revokeRefresh(req.app, req.body?.refreshToken);
  return { ok: true };
}));

router.use('/2fa', authenticate());
router.use('/2fa/*', authenticate());
router.use('/me', authenticate());
router.use('/change-password', authenticate());
router.use('/sessions', authenticate());
router.use('/sessions/*', authenticate());

router.get('/me', h(async (req) => sessionPayload(req.app, req.ctx)));

router.patch('/me', h(async (req) => {
  const app = req.app;
  const { name, phone, calendar_pref, theme_pref, notify_prefs, avatar_url } = req.body || {};
  const cur = await app.db.get('SELECT * FROM users WHERE id=?', req.ctx.userId);
  await app.db.run(
    `UPDATE users SET name=?, phone=?, calendar_pref=?, theme_pref=?, notify_prefs=?, avatar_url=? WHERE id=?`,
    name?.trim() || cur.name,
    phone ?? cur.phone,
    ['hijri', 'gregorian'].includes(calendar_pref) ? calendar_pref : cur.calendar_pref,
    ['light', 'dark'].includes(theme_pref) ? theme_pref : cur.theme_pref,
    notify_prefs ? JSON.stringify({ ...(j(cur.notify_prefs, {}) || {}), ...notify_prefs }) : cur.notify_prefs,
    avatar_url ?? cur.avatar_url,
    req.ctx.userId);
  await audit(req, { action: 'update', entity: 'user', entityId: req.ctx.userId, summary: 'تحديث الملف الشخصي والتفضيلات' });
  return sessionPayload(app, await buildContext(app, req.ctx.userId));
}));

router.post('/change-password', h(async (req) => {
  const app = req.app;
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) throw badRequest('كلمة المرور الجديدة يجب أن تكون ٨ أحرف فأكثر');
  const user = await app.db.get('SELECT * FROM users WHERE id=?', req.ctx.userId);
  if (!await verifyPassword(String(current || ''), user.password_hash)) throw badRequest('كلمة المرور الحالية غير صحيحة');
  await app.db.batch([
    ['UPDATE users SET password_hash=?, must_change_pw=0 WHERE id=?', [await hashPassword(String(next)), req.ctx.userId]],
    ['UPDATE refresh_tokens SET revoked=1 WHERE user_id=?', [req.ctx.userId]]
  ]);
  await audit(req, { action: 'update', entity: 'user', entityId: req.ctx.userId, summary: 'تغيير كلمة المرور' });
  return { ok: true, message: 'تم تغيير كلمة المرور بنجاح' };
}));

router.get('/sessions', h(async (req) => req.app.db.all(
  `SELECT id,user_agent,ip,created_at,expires_at,revoked FROM refresh_tokens
   WHERE user_id=? ORDER BY created_at DESC LIMIT 20`, req.ctx.userId)));

router.delete('/sessions/:id', h(async (req) => {
  const r = await req.app.db.run('UPDATE refresh_tokens SET revoked=1 WHERE id=? AND user_id=?',
    req.params.id, req.ctx.userId);
  if (!r.changes) throw notFound('الجلسة غير موجودة');
  return { ok: true };
}));

/* ═══════════ التحقّق بخطوتين (المستوى ٣) ═══════════ */

router.get('/2fa', h(async (req) => {
  const settings = await platformSettings(req.app);
  const u = await req.app.db.get('SELECT totp_enabled, totp_backup FROM users WHERE id=?', req.ctx.userId);
  return {
    enabled: !!u.totp_enabled,
    required: needsTotpSetup({ ...u, is_platform_admin: req.ctx.isPlatformAdmin }, settings),
    backup_codes_left: (j(u.totp_backup, []) || []).length
  };
}));

/** يبدأ التفعيل: سرّ جديد ورابط للتطبيق — لا يُفعَّل قبل تأكيد رمز صحيح */
router.post('/2fa/setup', h(async (req) => {
  const app = req.app;
  const settings = await platformSettings(app);
  const secret = generateTotpSecret();
  await app.db.run('UPDATE users SET totp_secret=? WHERE id=?', secret, req.ctx.userId);
  return {
    secret,
    uri: totpUri(secret, { account: req.ctx.email, issuer: settings.platform_name }),
    message: 'امسح الرمز بتطبيق المصادقة ثم أدخل الرمز المعروض لتأكيد التفعيل'
  };
}));

router.post('/2fa/enable', h(async (req) => {
  const app = req.app;
  const u = await app.db.get('SELECT totp_secret FROM users WHERE id=?', req.ctx.userId);
  if (!u?.totp_secret) throw badRequest('ابدأ التفعيل أولاً');
  if (!await verifyTotp(u.totp_secret, req.body?.token)) throw badRequest('الرمز غير صحيح — تحقّق من ساعة جهازك');

  const codes = generateBackupCodes(8);
  await app.db.run('UPDATE users SET totp_enabled=1, totp_backup=? WHERE id=?',
    JSON.stringify(await hashBackupCodes(codes)), req.ctx.userId);
  await audit(req, { action: 'update', entity: 'user', entityId: req.ctx.userId,
    summary: `${req.ctx.userName} فعّل التحقّق بخطوتين` });
  /* رموز الاسترداد تُعرض مرة واحدة فقط ولا تُخزَّن نصاً */
  return { enabled: true, backup_codes: codes };
}));

router.post('/2fa/disable', h(async (req) => {
  const app = req.app;
  const settings = await platformSettings(app);
  const u = await app.db.get('SELECT * FROM users WHERE id=?', req.ctx.userId);
  if (settings.require_2fa_admins && u.is_platform_admin) {
    throw badRequest('التحقّق بخطوتين إلزامي لمالكي المنصة — عطّل الإلزام من إعدادات المنصة أولاً');
  }
  if (!await verifyPassword(String(req.body?.password || ''), u.password_hash)) {
    throw badRequest('كلمة المرور غير صحيحة');
  }
  await app.db.run('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_backup=NULL WHERE id=?', req.ctx.userId);
  await audit(req, { action: 'update', entity: 'user', entityId: req.ctx.userId,
    summary: `${req.ctx.userName} عطّل التحقّق بخطوتين` });
  return { enabled: false };
}));

export default router;