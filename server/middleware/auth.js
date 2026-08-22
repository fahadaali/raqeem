import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import db, { nowUTC, j } from '../db/index.js';
import config from '../config.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/** يبني سياق التنفيذ (ctx) الذي تعتمد عليه طبقة العزل بالكامل */
export function buildContext(userId) {
  const user = db.prepare(`
    SELECT u.*, r.key AS role_key, r.name AS role_name, r.level AS role_level,
           t.name AS tenant_name, t.code AS tenant_code, t.logo_url AS tenant_logo,
           t.primary_color, t.accent_color, t.calendar_default, t.settings AS tenant_settings
    FROM users u
    JOIN roles r   ON r.id = u.role_id
    JOIN tenants t ON t.id = u.tenant_id
    WHERE u.id = ?`).get(userId);
  if (!user || user.status !== 'active') return null;

  const perms = db.prepare('SELECT permission_key FROM role_permissions WHERE role_id=?')
    .all(user.role_id).map(r => r.permission_key);

  const branchRows = db.prepare('SELECT branch_id FROM user_branches WHERE tenant_id=? AND user_id=?')
    .all(user.tenant_id, user.id).map(r => r.branch_id);

  // مدير الجهة والمدقق يريان كل فروع جهتهم
  const allBranches = ['owner', 'auditor'].includes(user.role_key);
  const branchIds = allBranches
    ? db.prepare('SELECT id FROM branches WHERE tenant_id=?').all(user.tenant_id).map(r => r.id)
    : branchRows;

  return {
    tenantId: user.tenant_id,
    tenantName: user.tenant_name,
    tenantCode: user.tenant_code,
    tenantLogo: user.tenant_logo,
    tenantColors: { primary: user.primary_color, accent: user.accent_color },
    tenantSettings: j(user.tenant_settings, {}),
    userId: user.id,
    userName: user.name,
    email: user.email,
    roleId: user.role_id,
    roleKey: user.role_key,
    roleName: user.role_name,
    roleLevel: user.role_level,
    perms,
    branchIds,
    allBranches,
    primaryBranchId: user.primary_branch_id,
    calendarPref: user.calendar_pref || user.calendar_default,
    notifyPrefs: j(user.notify_prefs, {}),
    user
  };
}

export function signAccess(ctx) {
  return jwt.sign(
    { sub: ctx.userId, tid: ctx.tenantId, role: ctx.roleKey },
    config.jwtSecret,
    { expiresIn: config.jwtExpires, issuer: 'noor-erp' }
  );
}

export function issueRefresh(ctx, req) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + config.refreshDays * 86400000).toISOString();
  db.prepare(`INSERT INTO refresh_tokens(id,tenant_id,user_id,token_hash,user_agent,ip,expires_at)
              VALUES(?,?,?,?,?,?,?)`).run(
    id, ctx.tenantId, ctx.userId,
    crypto.createHash('sha256').update(raw).digest('hex'),
    (req?.get?.('user-agent') || '').slice(0, 250), req?.ip || '', expires);
  return `${id}.${raw}`;
}

export function consumeRefresh(token) {
  if (!token || !token.includes('.')) return null;
  const [id, raw] = token.split('.');
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE id=?').get(id);
  if (!row || row.revoked) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.token_hash))) return null;
  return row;
}

export function revokeRefresh(token) {
  if (!token || !token.includes('.')) return;
  db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE id=?').run(token.split('.')[0]);
}

/** الحارس الأساسي: يتحقق من JWT ويحقن ctx في الطلب */
export function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.noor_at || null);
    if (!token) throw unauthorized();
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'noor-erp' });
    const ctx = buildContext(payload.sub);
    if (!ctx) throw unauthorized('الحساب موقوف أو غير موجود');
    if (ctx.tenantId !== payload.tid) throw forbidden('عدم تطابق نطاق الجهة');
    req.ctx = ctx;

    // الفرع النشط (مبدّل الفروع — البند ٢)
    const requested = req.get('x-branch-id') || req.query.branch_id;
    if (requested && requested !== 'all') {
      const bid = Number(requested);
      if (ctx.allBranches || ctx.branchIds.includes(bid)) req.ctx.activeBranchId = bid;
    }
    // الفصل النشط
    const term = req.get('x-term-id') || req.query.term_id;
    if (term) req.ctx.activeTermId = Number(term);

    db.prepare('UPDATE users SET last_login_at=COALESCE(last_login_at, ?) WHERE id=?').run(nowUTC(), ctx.userId);
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') return next(unauthorized('انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول'));
    if (e.name === 'JsonWebTokenError') return next(unauthorized());
    next(e);
  }
}
