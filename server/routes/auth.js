import express from 'express';
import bcrypt from 'bcryptjs';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, unauthorized, notFound } from '../lib/errors.js';
import { authenticate, buildContext, signAccess, issueRefresh, consumeRefresh, revokeRefresh } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { audit } from '../middleware/audit.js';
import { currentTerm } from '../lib/scope.js';
import { publicKey, pushEnabled } from '../lib/push.js';

const router = express.Router();

/** ملخّص الجلسة الذي تعتمد عليه الواجهة المرنة (البند ١) */
function sessionPayload(ctx) {
  const branches = ctx.branchIds.length
    ? db.prepare(`SELECT id,code,name,address,lat,lng,geofence_radius FROM branches
                  WHERE tenant_id=? AND id IN (${ctx.branchIds.map(() => '?').join(',')}) AND is_active=1
                  ORDER BY code`).all(ctx.tenantId, ...ctx.branchIds)
    : [];
  const terms = db.prepare('SELECT id,code,name,start_date,end_date,status,is_current FROM terms WHERE tenant_id=? ORDER BY start_date DESC')
    .all(ctx.tenantId);
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
    current_term: currentTerm(ctx.tenantId),
    push: { enabled: pushEnabled(), publicKey: publicKey() }
  };
}
export { sessionPayload };

/** شاشة الدخول الموحّدة (SSO) — تتعرف على دور المستخدم وتوجهه للوحته */
router.post('/login', rateLimit({ max: 20, windowMs: 60_000, key: r => `login:${r.ip}` }), ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('يرجى إدخال البريد الإلكتروني وكلمة المرور');

  const user = db.prepare(`SELECT u.* FROM users u WHERE lower(u.email)=lower(?)`).get(String(email).trim());
  const ok = user && bcrypt.compareSync(String(password), user.password_hash);
  if (!ok) throw unauthorized('بيانات الدخول غير صحيحة');
  if (user.status !== 'active') throw unauthorized('الحساب موقوف، يرجى مراجعة الإدارة');

  const ctx = buildContext(user.id);
  if (!ctx) throw unauthorized();

  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(nowUTC(), user.id);
  const accessToken = signAccess(ctx);
  const refreshToken = issueRefresh(ctx, req);

  req.ctx = ctx;
  audit(req, { action: 'login', entity: 'user', entityId: user.id, summary: `${ctx.userName} سجّل الدخول للمنصة` });

  res.cookie?.('noor_at', accessToken, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  res.json({ accessToken, refreshToken, ...sessionPayload(ctx) });
}));

router.post('/refresh', ah(async (req, res) => {
  const row = consumeRefresh(req.body?.refreshToken);
  if (!row) throw unauthorized('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
  const ctx = buildContext(row.user_id);
  if (!ctx) throw unauthorized();
  res.json({ accessToken: signAccess(ctx), ...sessionPayload(ctx) });
}));

router.post('/logout', ah(async (req, res) => {
  revokeRefresh(req.body?.refreshToken);
  res.clearCookie?.('noor_at');
  res.json({ ok: true });
}));

router.get('/me', authenticate, ah(async (req, res) => res.json(sessionPayload(req.ctx))));

router.patch('/me', authenticate, ah(async (req, res) => {
  const { name, phone, calendar_pref, theme_pref, notify_prefs, avatar_url } = req.body || {};
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.ctx.userId);
  db.prepare(`UPDATE users SET name=?, phone=?, calendar_pref=?, theme_pref=?, notify_prefs=?, avatar_url=? WHERE id=?`).run(
    name?.trim() || cur.name,
    phone ?? cur.phone,
    ['hijri', 'gregorian'].includes(calendar_pref) ? calendar_pref : cur.calendar_pref,
    ['light', 'dark'].includes(theme_pref) ? theme_pref : cur.theme_pref,
    notify_prefs ? JSON.stringify({ ...j(cur.notify_prefs, {}), ...notify_prefs }) : cur.notify_prefs,
    avatar_url ?? cur.avatar_url,
    req.ctx.userId
  );
  audit(req, { action: 'update', entity: 'user', entityId: req.ctx.userId, summary: 'تحديث الملف الشخصي والتفضيلات' });
  res.json(sessionPayload(buildContext(req.ctx.userId)));
}));

router.post('/change-password', authenticate, ah(async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) throw badRequest('كلمة المرور الجديدة يجب أن تكون ٨ أحرف فأكثر');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.ctx.userId);
  if (!bcrypt.compareSync(String(current || ''), user.password_hash)) throw badRequest('كلمة المرور الحالية غير صحيحة');
  db.prepare('UPDATE users SET password_hash=?, must_change_pw=0 WHERE id=?')
    .run(bcrypt.hashSync(String(next), 10), req.ctx.userId);
  db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?').run(req.ctx.userId);
  audit(req, { action: 'update', entity: 'user', entityId: req.ctx.userId, summary: 'تغيير كلمة المرور' });
  res.json({ ok: true, message: 'تم تغيير كلمة المرور بنجاح' });
}));

router.get('/sessions', authenticate, ah(async (req, res) => {
  res.json(db.prepare(`SELECT id,user_agent,ip,created_at,expires_at,revoked FROM refresh_tokens
    WHERE user_id=? ORDER BY created_at DESC LIMIT 20`).all(req.ctx.userId));
}));

router.delete('/sessions/:id', authenticate, ah(async (req, res) => {
  const r = db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE id=? AND user_id=?').run(req.params.id, req.ctx.userId);
  if (!r.changes) throw notFound('الجلسة غير موجودة');
  res.json({ ok: true });
}));

export default router;
