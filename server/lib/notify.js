import db, { nowUTC, j } from '../db/index.js';
import { emitToUsers } from './realtime.js';
import { sendPush, pushEnabled } from './push.js';

/**
 * ناقل الإشعارات المتكامل — يوصل الإشعار عبر ثلاث قنوات في آن واحد:
 *   ١) داخل التطبيق  (جدول notifications + جرس الإشعارات)
 *   ٢) لحظياً        (WebSocket لكل الأجهزة المفتوحة)
 *   ٣) دفع خارجي     (Web Push للمتصفح والجوال حتى والتطبيق مغلق)
 * ويحترم تفضيلات كل مستخدم (notify_prefs) لكل فئة على حدة.
 */
const insert = db.prepare(`INSERT INTO notifications
  (tenant_id,user_id,type,category,title,body,url,icon,data,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);
const markPushed = db.prepare('UPDATE notifications SET pushed=1 WHERE id=?');

function prefsOf(userId) {
  const row = db.prepare('SELECT notify_prefs FROM users WHERE id=?').get(userId);
  return j(row?.notify_prefs, {}) || {};
}

function allowed(prefs, category, channel) {
  if (prefs[channel] === false) return false;               // push / inapp
  if (category && prefs[category] === false) return false;  // tasks / finance / chat ...
  return true;
}

/**
 * @param {number} tenantId
 * @param {number[]} userIds
 * @param {{type:string,category?:string,title:string,body?:string,url?:string,icon?:string,data?:object,urgency?:string,silent?:boolean}} n
 */
export async function notifyUsers(tenantId, userIds, n) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return { created: 0, pushed: 0 };

  const category = n.category || 'general';
  const created = [];
  const pushTargets = [];

  const write = db.transaction(() => {
    for (const uid of ids) {
      const prefs = prefsOf(uid);
      if (!allowed(prefs, category, 'inapp')) continue;
      const r = insert.run(tenantId, uid, n.type, category, n.title, n.body || null,
        n.url || null, n.icon || null, JSON.stringify(n.data || {}), nowUTC());
      created.push({ id: r.lastInsertRowid, userId: uid });
      if (!n.silent && allowed(prefs, category, 'push')) pushTargets.push({ uid, nid: r.lastInsertRowid });
    }
  });
  write();

  // القناة اللحظية
  emitToUsers(tenantId, created.map(c => c.userId), {
    type: 'notification',
    notification: {
      type: n.type, category, title: n.title, body: n.body || '',
      url: n.url || '/', data: n.data || {}, created_at: nowUTC()
    }
  });

  // قناة الدفع
  let pushed = 0;
  if (pushEnabled() && pushTargets.length) {
    const res = await sendPush(tenantId, pushTargets.map(p => p.uid), {
      title: n.title,
      body: n.body || '',
      url: n.url || '/',
      tag: `${n.type}-${n.data?.id ?? ''}`,
      category,
      urgency: n.urgency || 'normal',
      data: n.data || {}
    });
    pushed = res.sent;
    for (const p of pushTargets) markPushed.run(p.nid);
  }
  return { created: created.length, pushed };
}

/** إشعار حسب الدور — مثال: كل من يملك صلاحية الاعتماد المالي */
export async function notifyByPermission(tenantId, permissionKey, n, { branchId = null } = {}) {
  let sql = `SELECT DISTINCT u.id FROM users u
             JOIN role_permissions rp ON rp.role_id = u.role_id
             WHERE u.tenant_id=? AND u.status='active' AND rp.permission_key=?`;
  const params = [tenantId, permissionKey];
  if (branchId) {
    sql += ` AND (u.id IN (SELECT user_id FROM user_branches WHERE tenant_id=? AND branch_id=?)
                  OR u.role_id IN (SELECT id FROM roles WHERE tenant_id=? AND key IN ('owner','auditor')))`;
    params.push(tenantId, branchId, tenantId);
  }
  const ids = db.prepare(sql).all(...params).map(r => r.id);
  return notifyUsers(tenantId, ids, n);
}

/** إشعار حسب مفتاح الدور */
export async function notifyByRole(tenantId, roleKeys, n) {
  const keys = Array.isArray(roleKeys) ? roleKeys : [roleKeys];
  const ids = db.prepare(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.tenant_id=? AND u.status='active' AND r.key IN (${keys.map(() => '?').join(',')})`
  ).all(tenantId, ...keys).map(r => r.id);
  return notifyUsers(tenantId, ids, n);
}

/** بث عام لكل مستخدمي الجهة (أو فرع محدد) */
export async function broadcast(tenantId, n, { branchId = null } = {}) {
  let ids;
  if (branchId) {
    ids = db.prepare(`SELECT DISTINCT user_id id FROM user_branches WHERE tenant_id=? AND branch_id=?`)
      .all(tenantId, branchId).map(r => r.id);
  } else {
    ids = db.prepare(`SELECT id FROM users WHERE tenant_id=? AND status='active'`).all(tenantId).map(r => r.id);
  }
  return notifyUsers(tenantId, ids, n);
}

export default { notifyUsers, notifyByPermission, notifyByRole, broadcast };
