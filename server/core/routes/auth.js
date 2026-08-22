import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, unauthorized, notFound, tooMany } from '../errors.js';
import { authenticate, buildContext, signAccess, issueRefresh, consumeRefresh, revokeRefresh,
  hashPassword, verifyPassword, needsRehash } from '../middleware/auth.js';
import { rateLimit, recordFailure, clearFailures, failureCount } from '../middleware/rateLimit.js';
import { audit } from '../middleware/audit.js';
import { currentTerm } from '../scope.js';
import { pushEnabled, publicKey } from '../push.js';

const router = new Hono();
const LOCK_WINDOW = 15 * 60_000;

/** ملخّص الجلسة الذي تعتمد عليه الواجهة المرنة (البند ١) */
export async function sessionPayload(app, ctx) {
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
    push: { enabled: pushEnabled(app.cfg), publicKey: publicKey(app.cfg) }
  };
}

/**
 * شاشة الدخول الموحّدة (SSO) — تتعرف على دور المستخدم وتوجهه للوحته.
 * التقييد بحسب المحاولات الفاشلة لكل حساب، مع سقف واسع لكل عنوان شبكة
 * حتى لا تُحجب جهة كاملة تشترك في عنوان واحد (NAT).
 */
router.post('/login',
  rateLimit({ windowMs: 60_000, max: (r, c) => c.get('app').cfg.rateLimit.loginIpMax, key: (r) => `login:${r.ip}` }),
  h(async (req) => {
    const app = req.app;
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest('يرجى إدخال البريد الإلكتروني وكلمة المرور');

    const account = `pw:${String(email).trim().toLowerCase()}`;
    if (failureCount(account, LOCK_WINDOW) >= app.cfg.rateLimit.loginAccountMax) {
      throw tooMany('تم إيقاف المحاولات مؤقتاً بعد عدة محاولات فاشلة — أعد المحاولة بعد ١٥ دقيقة أو راجع الإدارة');
    }

    const user = await app.db.get('SELECT * FROM users WHERE lower(email)=lower(?)', String(email).trim());
    const valid = user && await verifyPassword(String(password), user.password_hash);
    if (!valid) { recordFailure(account, LOCK_WINDOW); throw unauthorized('بيانات الدخول غير صحيحة'); }
    if (user.status !== 'active') throw unauthorized('الحساب موقوف، يرجى مراجعة الإدارة');
    clearFailures(account);

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

    return { accessToken, refreshToken, ...(await sessionPayload(app, ctx)) };
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

export default router;
