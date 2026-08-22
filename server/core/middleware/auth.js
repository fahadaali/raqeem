import { signJWT, verifyJWT, hashPassword, verifyPassword, needsRehash,
  randomToken, uuid, sha256Hex, timingSafeEqual, parseDuration } from '../crypto.js';
import { nowUTC, j } from '../sql.js';
import { unauthorized, forbidden } from '../errors.js';
import { effectiveFeatures } from '../features.js';

/** يبني سياق التنفيذ (ctx) الذي تعتمد عليه طبقة العزل بالكامل */
export async function buildContext(app, userId) {
  const { db } = app;
  const user = await db.get(`
    SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level,
           t.name AS tenant_name, t.code AS tenant_code, t.logo_url AS tenant_logo,
           t.primary_color, t.accent_color, t.calendar_default, t.settings AS tenant_settings,
           t.status AS tenant_status, t.suspend_reason AS tenant_suspend_reason,
           t.feature_overrides, t.limit_overrides,
           s.status AS sub_status, p.code AS plan_code, p.name AS plan_name, p.features AS plan_features
    FROM users u
    JOIN roles r   ON r.id = u.role_id
    JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN subscriptions s ON s.tenant_id = t.id
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE u.id = ?`, userId);
  if (!user || user.status !== 'active') return null;

  const perms = (await db.all('SELECT permission_key FROM role_permissions WHERE role_id=?', user.role_id))
    .map(r => r.permission_key);
  const assigned = (await db.all('SELECT branch_id FROM user_branches WHERE tenant_id=? AND user_id=?',
    user.tenant_id, user.id)).map(r => r.branch_id);

  // مدير الجهة والمدقق يريان كل فروع جهتهم
  const allBranches = ['owner', 'auditor'].includes(user.role_key);
  const branchIds = allBranches
    ? (await db.all('SELECT id FROM branches WHERE tenant_id=?', user.tenant_id)).map(r => r.id)
    : assigned;

  return {
    tenantId: user.tenant_id, tenantName: user.tenant_name, tenantCode: user.tenant_code,
    tenantLogo: user.tenant_logo,
    tenantStatus: user.tenant_status, tenantSuspendReason: user.tenant_suspend_reason,
    isPlatformAdmin: !!user.is_platform_admin,
    /* مزايا الخطة النافذة — تُحسب مرة واحدة مع السياق فلا تكلّف استعلاماً إضافياً */
    planCode: user.plan_code || null,
    planName: user.plan_name || null,
    subStatus: user.sub_status || null,
    features: user.plan_code
      ? effectiveFeatures({ features: user.plan_features }, { feature_overrides: user.feature_overrides })
      : null,
    tenantColors: { primary: user.primary_color, accent: user.accent_color },
    tenantSettings: j(user.tenant_settings, {}) || {},
    userId: user.id, userName: user.name, email: user.email,
    roleId: user.role_id, roleKey: user.role_key, roleName: user.role_name, roleLevel: user.role_level,
    perms, branchIds, allBranches,
    primaryBranchId: user.primary_branch_id,
    calendarPref: user.calendar_pref || user.calendar_default,
    notifyPrefs: j(user.notify_prefs, {}) || {},
    user
  };
}

export const signAccess = (app, ctx) => signJWT(
  { sub: ctx.userId, tid: ctx.tenantId, role: ctx.roleKey },
  app.cfg.jwtSecret, { expiresIn: app.cfg.jwtExpires });

export async function issueRefresh(app, ctx, req) {
  const raw = randomToken(48);
  const id = uuid();
  const expires = new Date(Date.now() + app.cfg.refreshDays * 86400000).toISOString();
  await app.db.run(
    `INSERT INTO refresh_tokens(id,tenant_id,user_id,token_hash,user_agent,ip,expires_at) VALUES(?,?,?,?,?,?,?)`,
    id, ctx.tenantId, ctx.userId, await sha256Hex(raw),
    (req?.get('user-agent') || '').slice(0, 250), req?.ip || '', expires);
  return `${id}.${raw}`;
}

export async function consumeRefresh(app, token) {
  if (!token || !String(token).includes('.')) return null;
  const [id, raw] = String(token).split('.');
  const row = await app.db.get('SELECT * FROM refresh_tokens WHERE id=?', id);
  if (!row || row.revoked) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (!timingSafeEqual(await sha256Hex(raw), row.token_hash)) return null;
  return row;
}

export async function revokeRefresh(app, token) {
  if (!token || !String(token).includes('.')) return;
  await app.db.run('UPDATE refresh_tokens SET revoked=1 WHERE id=?', String(token).split('.')[0]);
}

/** الحارس الأساسي: يتحقق من الرمز ويحقن سياق التنفيذ */
export function authenticate() {
  return async (c, next) => {
    const app = c.get('app');
    const req = c.get('request');
    const header = req.get('authorization') || '';
    const cookie = req.get('cookie') || '';
    const fromCookie = (cookie.match(/(?:^|;\s*)noor_at=([^;]+)/) || [])[1];
    const token = header.startsWith('Bearer ') ? header.slice(7) : fromCookie;
    if (!token) throw unauthorized();

    let payload;
    try { payload = await verifyJWT(token, app.cfg.jwtSecret); }
    catch (e) {
      throw unauthorized(e.code === 'EXPIRED'
        ? 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول' : undefined);
    }

    const ctx = await buildContext(app, payload.sub);
    if (!ctx) throw unauthorized('الحساب موقوف أو غير موجود');
    if (ctx.tenantId !== payload.tid) throw forbidden('عدم تطابق نطاق الجهة');

    // الفرع النشط (مبدّل الفروع — البند ٢) والفصل النشط
    const requested = req.get('x-branch-id') || req.query.branch_id;
    if (requested && requested !== 'all') {
      const bid = Number(requested);
      if (ctx.allBranches || ctx.branchIds.includes(bid)) ctx.activeBranchId = bid;
    }
    const term = req.get('x-term-id') || req.query.term_id;
    if (term && term !== 'all') ctx.activeTermId = Number(term);

    req.ctx = ctx;
    c.set('ctx', ctx);
    await next();
  };
}

export { hashPassword, verifyPassword, needsRehash, parseDuration };
