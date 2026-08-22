import { nowUTC, j } from './sql.js';
import { sendPush, pushEnabled } from './push.js';

/**
 * ناقل الإشعارات المتكامل — يوصل الإشعار عبر ثلاث قنوات في آنٍ واحد:
 *   ١) داخل التطبيق  (جدول notifications + جرس الإشعارات)
 *   ٢) لحظياً        (WebSocket لكل الأجهزة المفتوحة)
 *   ٣) دفع خارجي     (Web Push للمتصفح والجوال حتى والتطبيق مغلق)
 * ويحترم تفضيلات كل مستخدم لكل قناة وفئة على حدة.
 */
const INSERT = `INSERT INTO notifications
  (tenant_id,user_id,type,category,title,body,url,icon,data,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`;

function allowed(prefs, category, channel) {
  if (prefs?.[channel] === false) return false;
  if (category && prefs?.[category] === false) return false;
  return true;
}

export async function notifyUsers(app, tenantId, userIds, n) {
  const ids = [...new Set((userIds || []).filter(Boolean))].map(Number);
  if (!ids.length) return { created: 0, pushed: 0 };

  const category = n.category || 'general';
  const users = await app.db.all(
    `SELECT id, notify_prefs FROM users WHERE tenant_id=? AND status='active' AND id IN (${ids.map(() => '?').join(',')})`,
    tenantId, ...ids);

  const inapp = [], pushTargets = [];
  for (const u of users) {
    const prefs = j(u.notify_prefs, {}) || {};
    if (!allowed(prefs, category, 'inapp')) continue;
    inapp.push(u.id);
    if (!n.silent && allowed(prefs, category, 'push')) pushTargets.push(u.id);
  }
  if (!inapp.length) return { created: 0, pushed: 0 };

  const stamp = nowUTC();
  await app.db.batch(inapp.map(uid => [INSERT, [
    tenantId, uid, n.type, category, n.title, n.body || null,
    n.url || null, n.icon || null, JSON.stringify(n.data || {}), stamp
  ]]));

  // القناة اللحظية
  app.realtime?.emitToUsers?.(tenantId, inapp, {
    type: 'notification',
    notification: { type: n.type, category, title: n.title, body: n.body || '', url: n.url || '/', data: n.data || {}, created_at: stamp }
  });

  // قناة الدفع
  let pushed = 0;
  if (pushEnabled(app.cfg) && pushTargets.length) {
    const job = sendPush(app, tenantId, pushTargets, {
      title: n.title, body: n.body || '', url: n.url || '/',
      tag: `${n.type}-${n.data?.id ?? ''}`, category,
      urgency: n.urgency || 'normal', data: n.data || {}
    }).then(async (res) => {
      pushed = res.sent;
      await app.db.run(
        `UPDATE notifications SET pushed=1 WHERE tenant_id=? AND created_at=? AND user_id IN (${pushTargets.map(() => '?').join(',')})`,
        tenantId, stamp, ...pushTargets).catch(() => {});
      return res;
    }).catch(() => ({ sent: 0 }));

    if (n.awaitPush === false && app.waitUntil) { app.waitUntil(job); }
    else { const r = await job; pushed = r.sent; }
  }
  return { created: inapp.length, pushed };
}

/** إشعار لكل من يملك صلاحية معيّنة (مثال: أصحاب الاعتماد المالي) */
export async function notifyByPermission(app, tenantId, permissionKey, n, { branchId = null } = {}) {
  let sql = `SELECT DISTINCT u.id FROM users u
             JOIN role_permissions rp ON rp.role_id = u.role_id
             WHERE u.tenant_id=? AND u.status='active' AND rp.permission_key=?`;
  const params = [tenantId, permissionKey];
  if (branchId) {
    sql += ` AND (u.id IN (SELECT user_id FROM user_branches WHERE tenant_id=? AND branch_id=?)
                  OR u.role_id IN (SELECT id FROM roles WHERE tenant_id=? AND key IN ('owner','auditor')))`;
    params.push(tenantId, branchId, tenantId);
  }
  const ids = (await app.db.all(sql, ...params)).map(r => r.id);
  return notifyUsers(app, tenantId, ids, n);
}

/** إشعار حسب مفتاح الدور */
export async function notifyByRole(app, tenantId, roleKeys, n) {
  const keys = Array.isArray(roleKeys) ? roleKeys : [roleKeys];
  const ids = (await app.db.all(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.tenant_id=? AND u.status='active' AND r.key IN (${keys.map(() => '?').join(',')})`,
    tenantId, ...keys)).map(r => r.id);
  return notifyUsers(app, tenantId, ids, n);
}

/** بث عام لكل مستخدمي الجهة أو فرع محدد */
export async function broadcast(app, tenantId, n, { branchId = null } = {}) {
  const ids = branchId
    ? (await app.db.all('SELECT DISTINCT user_id AS id FROM user_branches WHERE tenant_id=? AND branch_id=?', tenantId, branchId)).map(r => r.id)
    : (await app.db.all(`SELECT id FROM users WHERE tenant_id=? AND status='active'`, tenantId)).map(r => r.id);
  return notifyUsers(app, tenantId, ids, n);
}
