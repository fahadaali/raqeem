import { Hono } from 'hono';
import { j } from '../sql.js';
import { h, status } from '../http.js';
import { badRequest, unauthorized, tooMany } from '../errors.js';
import { hashPassword, verifyPassword, needsRehash } from '../crypto.js';
import { authenticateAdmin, buildAdminContext, signAdminAccess,
  issueAdminRefresh, consumeAdminRefresh, revokeAdminRefresh } from '../middleware/admin-auth.js';
import { rateLimit, recordFailure, clearFailures, failureCount } from '../middleware/rateLimit.js';
import { platformSettings } from '../billing.js';
import { recordLoginAttempt, assertSecondFactor, generateTotpSecret, totpUri,
  verifyTotp, generateBackupCodes, hashBackupCodes } from '../security.js';
import { plog } from '../plog.js';

/**
 * دخول مالكي المنصة — مسار مستقل عن /api/auth تماماً.
 * الحسابات في جدولها الخاص، والرمز الصادر هنا يحمل adm:1 ولا يفتح إلا لوحة المنصة.
 */
const router = new Hono();
const LOCK_WINDOW = 15 * 60_000;

/** ملخّص جلسة الادمن — مسطّح بلا جهة ولا فروع ولا فصول */
async function adminSession(app, ctx) {
  const settings = await platformSettings(app);
  const a = await app.db.get(
    'SELECT totp_enabled, totp_backup FROM platform_admins WHERE id=?', ctx.adminId);
  return {
    admin: { id: ctx.adminId, name: ctx.adminName, email: ctx.email },
    platform: {
      name: settings.platform_name,
      name_en: settings.platform_name_en,
      saas_enabled: !!settings.saas_enabled,
      currency: settings.currency,
      vat_rate: settings.vat_rate
    },
    security: {
      totp_enabled: !!a?.totp_enabled,
      /* الإلزام يسري على حسابات الادمن وحدها */
      totp_required: !!settings.require_2fa_admins && !a?.totp_enabled,
      backup_codes_left: (j(a?.totp_backup, []) || []).length
    }
  };
}

/** مفتاح قفل المحاولات لحساب ادمن — يقرؤه الدخول الموحّد أيضاً فلا يتضاعف الرصيد بين بابين */
export const adminLockKey = (email) => `adm:${String(email).trim().toLowerCase()}`;

/**
 * التحقّق من حساب ادمن وإصدار جلسته.
 *
 * تُنادى من بابين: مسار اللوحة المستقل هنا، والدخولُ الموحّد في `/api/auth/login`.
 * ولذلك يقع القفل والتسجيل وإصدار الرمز كلُّها هنا لا في المسار، فيتصرّف الحساب
 * تصرّفاً واحداً أياً كان الباب. الرمز الصادر يحمل `adm:1` بلا `tid`، فلا يفتح
 * إلا لوحة المنصة مهما كان الباب الذي دخل منه.
 *
 * @returns {{ found: boolean, valid: boolean, result?: object }}
 *   `found` كان للبريد حساب ادمن، `valid` صحّت كلمة مروره، و`result` ما يُردّ
 *   (جلسة، أو استجابة ٤٠١ تطلب رمز التحقّق). ولا يُرمى خطأٌ إلا لسببٍ في الحساب
 *   نفسه (موقوف، رمز تحقّق خاطئ) — فالباب الموحّد يقرّر وحده متى يُعلن الفشل.
 */
export async function adminLogin(app, req, { email, password, totp }) {
  const account = adminLockKey(email);
  if (failureCount(account, LOCK_WINDOW) >= app.cfg.rateLimit.loginAccountMax) {
    throw tooMany('تم إيقاف المحاولات مؤقتاً بعد عدة محاولات فاشلة — أعد المحاولة بعد ١٥ دقيقة');
  }

  /* محاولات دخول الادمن تُسجَّل في السجل نفسه بلا جهة — العمود يقبل NULL */
  const attempt = (success, reason, a = null) => recordLoginAttempt(app, {
    email, tenantId: null, userId: a?.id ?? null,
    success, reason, ip: req.ip, userAgent: req.get('user-agent') || ''
  });

  const admin = await app.db.get(
    'SELECT * FROM platform_admins WHERE lower(email)=lower(?)', String(email).trim());
  const valid = admin && await verifyPassword(String(password), admin.password_hash);
  if (!valid) {
    recordFailure(account, LOCK_WINDOW);
    await attempt(false, admin ? 'كلمة مرور خاطئة' : 'حساب ادمن غير موجود', admin);
    return { found: !!admin, valid: false };
  }
  if (admin.status !== 'active') {
    await attempt(false, 'الحساب موقوف', admin);
    throw unauthorized('الحساب موقوف');
  }
  clearFailures(account);

  if (admin.totp_enabled) {
    const token = String(totp || '').trim();
    if (!token) {
      await attempt(false, 'بانتظار رمز التحقّق بخطوتين', admin);
      return { found: true, valid: true,
        result: status(401, { error: { code: 'TOTP_REQUIRED', message: 'أدخل رمز التحقّق بخطوتين' } }) };
    }
    try {
      await assertSecondFactor(app, admin, token, j(admin.totp_backup, []) || [], 'platform_admins');
    } catch (e) {
      await attempt(false, 'رمز تحقّق خاطئ', admin);
      throw e;
    }
  }
  await attempt(true, null, admin);

  if (needsRehash(admin.password_hash)) {
    await app.db.run('UPDATE platform_admins SET password_hash=? WHERE id=?',
      await hashPassword(String(password)), admin.id);
  }

  const ctx = await buildAdminContext(app, admin.id);
  if (!ctx) throw unauthorized();
  await app.db.run('UPDATE platform_admins SET last_login_at=? WHERE id=?',
    new Date().toISOString(), admin.id);

  req.ctx = ctx;
  await plog(req, { action: 'login', entity: 'platform_admin', entityId: admin.id,
    summary: `${ctx.adminName} دخل لوحة المنصة` });

  return {
    found: true, valid: true,
    result: {
      kind: 'admin',
      accessToken: await signAdminAccess(app, ctx),
      refreshToken: await issueAdminRefresh(app, ctx, req),
      ...(await adminSession(app, ctx))
    }
  };
}

router.post('/login',
  rateLimit({ windowMs: 60_000, max: (r, c) => c.get('app').cfg.rateLimit.loginIpMax,
    key: (r) => `adminlogin:${r.ip}` }),
  h(async (req) => {
    const { email, password, totp } = req.body || {};
    if (!email || !password) throw badRequest('يرجى إدخال البريد الإلكتروني وكلمة المرور');
    const r = await adminLogin(req.app, req, { email, password, totp });
    if (!r.valid) throw unauthorized('بيانات الدخول غير صحيحة');
    return r.result;
  }));

router.post('/refresh', h(async (req) => {
  const row = await consumeAdminRefresh(req.app, req.body?.refreshToken);
  if (!row) throw unauthorized('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
  const ctx = await buildAdminContext(req.app, row.admin_id);
  if (!ctx) throw unauthorized();
  return { accessToken: await signAdminAccess(req.app, ctx), ...(await adminSession(req.app, ctx)) };
}));

router.post('/logout', h(async (req) => {
  await revokeAdminRefresh(req.app, req.body?.refreshToken);
  return { ok: true };
}));

/* ─────────────── ما يلي يتطلّب جلسة ادمن ─────────────── */
for (const p of ['/me', '/change-password', '/2fa', '/2fa/*']) router.use(p, authenticateAdmin());

router.get('/me', h(async (req) => adminSession(req.app, req.ctx)));

router.post('/change-password', h(async (req) => {
  const app = req.app;
  const { current, next } = req.body || {};
  if (String(next || '').length < 8) throw badRequest('كلمة المرور الجديدة لا تقل عن ٨ خانات');
  const a = await app.db.get('SELECT * FROM platform_admins WHERE id=?', req.ctx.adminId);
  if (!await verifyPassword(String(current || ''), a.password_hash)) {
    throw badRequest('كلمة المرور الحالية غير صحيحة');
  }
  await app.db.run('UPDATE platform_admins SET password_hash=? WHERE id=?',
    await hashPassword(String(next)), a.id);
  /* تغيير كلمة المرور يُنهي كل الجلسات الأخرى */
  await app.db.run('UPDATE admin_sessions SET revoked=1 WHERE admin_id=?', a.id);
  await plog(req, { action: 'update', entity: 'platform_admin', entityId: a.id,
    summary: `${req.ctx.adminName} غيّر كلمة مروره` });
  return { ok: true };
}));

router.get('/2fa', h(async (req) => {
  const settings = await platformSettings(req.app);
  const a = await req.app.db.get(
    'SELECT totp_enabled, totp_backup FROM platform_admins WHERE id=?', req.ctx.adminId);
  return {
    enabled: !!a.totp_enabled,
    required: !!settings.require_2fa_admins && !a.totp_enabled,
    backup_codes_left: (j(a.totp_backup, []) || []).length
  };
}));

router.post('/2fa/setup', h(async (req) => {
  const app = req.app;
  const settings = await platformSettings(app);
  const secret = generateTotpSecret();
  await app.db.run('UPDATE platform_admins SET totp_secret=? WHERE id=?', secret, req.ctx.adminId);
  return {
    secret,
    uri: totpUri(secret, { account: req.ctx.email, issuer: `${settings.platform_name} — لوحة المنصة` }),
    message: 'امسح الرمز بتطبيق المصادقة ثم أدخل الرمز المعروض لتأكيد التفعيل'
  };
}));

router.post('/2fa/enable', h(async (req) => {
  const app = req.app;
  const a = await app.db.get('SELECT totp_secret FROM platform_admins WHERE id=?', req.ctx.adminId);
  if (!a?.totp_secret) throw badRequest('ابدأ التفعيل أولاً');
  if (!await verifyTotp(a.totp_secret, req.body?.token)) {
    throw badRequest('الرمز غير صحيح — تحقّق من ساعة جهازك');
  }
  const codes = generateBackupCodes(8);
  await app.db.run('UPDATE platform_admins SET totp_enabled=1, totp_backup=? WHERE id=?',
    JSON.stringify(await hashBackupCodes(codes)), req.ctx.adminId);
  await plog(req, { action: 'update', entity: 'platform_admin', entityId: req.ctx.adminId,
    summary: `${req.ctx.adminName} فعّل التحقّق بخطوتين` });
  return { enabled: true, backup_codes: codes };
}));

router.post('/2fa/disable', h(async (req) => {
  const app = req.app;
  const settings = await platformSettings(app);
  if (settings.require_2fa_admins) {
    throw badRequest('التحقّق بخطوتين إلزامي لحسابات الادمن — عطّل الإلزام من إعدادات المنصة أولاً');
  }
  const a = await app.db.get('SELECT * FROM platform_admins WHERE id=?', req.ctx.adminId);
  if (!await verifyPassword(String(req.body?.password || ''), a.password_hash)) {
    throw badRequest('كلمة المرور غير صحيحة');
  }
  await app.db.run(
    'UPDATE platform_admins SET totp_enabled=0, totp_secret=NULL, totp_backup=NULL WHERE id=?', a.id);
  await plog(req, { action: 'update', entity: 'platform_admin', entityId: a.id,
    summary: `${req.ctx.adminName} عطّل التحقّق بخطوتين` });
  return { enabled: false };
}));

export default router;
