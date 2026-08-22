import { signJWT, verifyJWT, randomToken, uuid, sha256Hex, timingSafeEqual } from '../crypto.js';
import { unauthorized, forbidden } from '../errors.js';

/**
 * مصادقة مالكي المنصة — منفصلة تماماً عن مصادقة المستأجرين.
 *
 * الفصل يقوم على **جمهور الرمز**: رمز المستأجر يحمل `tid` ولا يحمل `adm`،
 * ورمز الادمن يحمل `adm:1` ولا يحمل `tid`. وكل حارس يرفض رمز الآخر صراحةً،
 * فلا يفتح رمزٌ بابَ الطبقة الأخرى ولو تسرّب. والسياق هنا مسطّح بلا `tenantId`
 * أصلاً — فأي شيفرة تفترض وجود جهة تنكسر ظاهرةً لا صامتةً.
 */

/** يبني سياق الادمن من جدول الهويّة المستقل */
export async function buildAdminContext(app, adminId) {
  const admin = await app.db.get(
    'SELECT * FROM platform_admins WHERE id = ?', adminId);
  if (!admin || admin.status !== 'active') return null;
  return {
    adminId: admin.id,
    adminName: admin.name,
    email: admin.email,
    isAdmin: true,
    admin
  };
}

export const signAdminAccess = (app, ctx) => signJWT(
  { sub: ctx.adminId, adm: 1 },
  app.cfg.jwtSecret, { expiresIn: app.cfg.jwtExpires });

export async function issueAdminRefresh(app, ctx, req) {
  const raw = randomToken(48);
  const id = uuid();
  const expires = new Date(Date.now() + app.cfg.refreshDays * 86400000).toISOString();
  await app.db.run(
    `INSERT INTO admin_sessions(id,admin_id,token_hash,user_agent,ip,expires_at) VALUES(?,?,?,?,?,?)`,
    id, ctx.adminId, await sha256Hex(raw),
    (req?.get('user-agent') || '').slice(0, 250), req?.ip || '', expires);
  return `${id}.${raw}`;
}

export async function consumeAdminRefresh(app, token) {
  if (!token || !String(token).includes('.')) return null;
  const [id, raw] = String(token).split('.');
  const row = await app.db.get('SELECT * FROM admin_sessions WHERE id=?', id);
  if (!row || row.revoked) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (!timingSafeEqual(await sha256Hex(raw), row.token_hash)) return null;
  return row;
}

export async function revokeAdminRefresh(app, token) {
  if (!token || !String(token).includes('.')) return;
  await app.db.run('UPDATE admin_sessions SET revoked=1 WHERE id=?', String(token).split('.')[0]);
}

/** حارس لوحة المنصة: لا يقبل إلا رمزاً صادراً لحساب ادمن */
export function authenticateAdmin() {
  return async (c, next) => {
    const app = c.get('app');
    const req = c.get('request');
    const header = req.get('authorization') || '';
    const cookie = req.get('cookie') || '';
    const fromCookie = (cookie.match(/(?:^|;\s*)raqeem_admin_at=([^;]+)/) || [])[1];
    const token = header.startsWith('Bearer ') ? header.slice(7) : fromCookie;
    if (!token) throw unauthorized();

    let payload;
    try { payload = await verifyJWT(token, app.cfg.jwtSecret); }
    catch (e) {
      throw unauthorized(e.code === 'EXPIRED'
        ? 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول' : undefined);
    }

    /* رمز مستأجر لا يفتح لوحة المنصة مهما كانت صلاحية صاحبه في جهته */
    if (payload.adm !== 1 || payload.tid !== undefined) {
      throw forbidden('هذا الرمز ليس رمز دخول للوحة المنصة');
    }

    const ctx = await buildAdminContext(app, payload.sub);
    if (!ctx) throw unauthorized('الحساب موقوف أو غير موجود');

    req.ctx = ctx;
    c.set('ctx', ctx);
    await next();
  };
}
