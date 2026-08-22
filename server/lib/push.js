import webpush from 'web-push';
import db, { nowUTC } from '../db/index.js';
import config from '../config.js';

let configured = false;
if (config.vapid.publicKey && config.vapid.privateKey) {
  try {
    webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
    configured = true;
  } catch (e) {
    console.warn('[push] مفاتيح VAPID غير صالحة:', e.message);
  }
} else {
  console.warn('[push] لم تُضبط مفاتيح VAPID — إشعارات الدفع معطّلة. شغّل: npm run gen:vapid');
}

export const pushEnabled = () => configured;
export const publicKey = () => config.vapid.publicKey;

const delSub = db.prepare('DELETE FROM push_subscriptions WHERE id=?');
const failSub = db.prepare('UPDATE push_subscriptions SET failed_count=failed_count+1 WHERE id=?');
const okSub = db.prepare('UPDATE push_subscriptions SET last_used_at=?, failed_count=0 WHERE id=?');

/** إرسال إشعار دفع لمستخدمين محددين (متصفح سطح المكتب + أندرويد + آيفون PWA) */
export async function sendPush(tenantId, userIds, payload) {
  if (!configured || !userIds?.length) return { sent: 0, removed: 0 };
  const ids = [...new Set(userIds)];
  const subs = db.prepare(
    `SELECT * FROM push_subscriptions WHERE tenant_id=? AND user_id IN (${ids.map(() => '?').join(',')})`
  ).all(tenantId, ...ids);
  if (!subs.length) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0, removed = 0;

  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, body, { TTL: 3600, urgency: payload.urgency || 'normal' });
      okSub.run(nowUTC(), s.id);
      sent++;
    } catch (err) {
      const code = err.statusCode || 0;
      if (code === 404 || code === 410) { delSub.run(s.id); removed++; }
      else {
        failSub.run(s.id);
        if (s.failed_count >= 5) { delSub.run(s.id); removed++; }
      }
    }
  }));
  return { sent, removed };
}

export default { sendPush, pushEnabled, publicKey };
