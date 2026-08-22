import { sendWebPush } from './webpush.js';
import { nowUTC } from './sql.js';

/** إشعارات الدفع — تعتمد تنفيذ Web Crypto المحمول */
export const pushEnabled = (cfg) => !!(cfg.vapid.publicKey && cfg.vapid.privateKey);
export const publicKey = (cfg) => cfg.vapid.publicKey;

/**
 * إرسال إشعار دفع لمستخدمين محددين
 * (متصفحات سطح المكتب، أندرويد، وآيفون بعد تثبيت التطبيق)
 */
export async function sendPush(app, tenantId, userIds, payload) {
  const cfg = app.cfg;
  if (!pushEnabled(cfg) || !userIds?.length) return { sent: 0, removed: 0 };
  const ids = [...new Set(userIds)];
  const subs = await app.db.all(
    `SELECT * FROM push_subscriptions WHERE tenant_id=? AND user_id IN (${ids.map(() => '?').join(',')})`,
    tenantId, ...ids);
  if (!subs.length) return { sent: 0, removed: 0 };

  const vapid = { publicKey: cfg.vapid.publicKey, privateKey: cfg.vapid.privateKey, subject: cfg.vapid.subject };
  let sent = 0, removed = 0;
  const drop = [], touch = [], fail = [];

  await Promise.all(subs.map(async (s) => {
    try {
      const r = await sendWebPush(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload, vapid, { ttl: 3600, urgency: payload.urgency || 'normal', topic: payload.tag });
      if (r.ok) { sent++; touch.push(s.id); }
      else if (r.gone) { drop.push(s.id); removed++; }
      else if (s.failed_count >= 5) { drop.push(s.id); removed++; }
      else fail.push(s.id);
    } catch {
      if (s.failed_count >= 5) { drop.push(s.id); removed++; } else fail.push(s.id);
    }
  }));

  const stmts = [];
  if (drop.length) stmts.push([`DELETE FROM push_subscriptions WHERE id IN (${drop.map(() => '?').join(',')})`, drop]);
  if (touch.length) stmts.push([`UPDATE push_subscriptions SET last_used_at=?, failed_count=0 WHERE id IN (${touch.map(() => '?').join(',')})`, [nowUTC(), ...touch]]);
  if (fail.length) stmts.push([`UPDATE push_subscriptions SET failed_count=failed_count+1 WHERE id IN (${fail.map(() => '?').join(',')})`, fail]);
  if (stmts.length) await app.db.batch(stmts);

  return { sent, removed };
}
