import express from 'express';
import db, { nowUTC, j } from '../db/index.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { publicKey, pushEnabled, sendPush } from '../lib/push.js';
import { notifyUsers, broadcast } from '../lib/notify.js';
import { onlineUsers } from '../lib/realtime.js';

const router = express.Router();

/* ── إعدادات الدفع العامة (تُقرأ قبل الاشتراك) ───────────────────────────── */
router.get('/vapid', ah(async (req, res) => {
  res.json({ enabled: pushEnabled(), publicKey: publicKey() });
}));

/* ── قائمة الإشعارات وجرس التنبيه ────────────────────────────────────────── */
router.get('/', ah(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const onlyUnread = req.query.unread === '1';
  const rows = db.prepare(`SELECT * FROM notifications WHERE tenant_id=? AND user_id=?
    ${onlyUnread ? 'AND is_read=0' : ''} ORDER BY id DESC LIMIT ?`)
    .all(req.ctx.tenantId, req.ctx.userId, limit);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE tenant_id=? AND user_id=? AND is_read=0')
    .get(req.ctx.tenantId, req.ctx.userId).c;
  res.json({ items: rows.map(n => ({ ...n, data: j(n.data, {}) })), unread });
}));

router.post('/read', ah(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (ids?.length) {
    db.prepare(`UPDATE notifications SET is_read=1, read_at=? WHERE tenant_id=? AND user_id=? AND id IN (${ids.map(() => '?').join(',')})`)
      .run(nowUTC(), req.ctx.tenantId, req.ctx.userId, ...ids);
  } else {
    db.prepare('UPDATE notifications SET is_read=1, read_at=? WHERE tenant_id=? AND user_id=? AND is_read=0')
      .run(nowUTC(), req.ctx.tenantId, req.ctx.userId);
  }
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE tenant_id=? AND user_id=? AND is_read=0')
    .get(req.ctx.tenantId, req.ctx.userId).c;
  res.json({ ok: true, unread });
}));

router.delete('/:id', ah(async (req, res) => {
  db.prepare('DELETE FROM notifications WHERE id=? AND tenant_id=? AND user_id=?')
    .run(req.params.id, req.ctx.tenantId, req.ctx.userId);
  res.json({ ok: true });
}));

/* ── تسجيل جهاز لاستقبال إشعارات الدفع (متصفح / أندرويد / آيفون PWA) ────── */
router.post('/subscribe', ah(async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw badRequest('بيانات اشتراك الدفع غير مكتملة');
  db.prepare(`INSERT INTO push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth,user_agent,platform,last_used_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, tenant_id=excluded.tenant_id,
      p256dh=excluded.p256dh, auth=excluded.auth, failed_count=0, last_used_at=excluded.last_used_at`)
    .run(req.ctx.tenantId, req.ctx.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth,
      (req.get('user-agent') || '').slice(0, 250), req.body?.platform || null, nowUTC());
  audit(req, { action: 'create', entity: 'push_subscription', summary: 'تفعيل إشعارات الدفع على جهاز جديد' });
  res.status(201).json({ ok: true, message: 'تم تفعيل الإشعارات على هذا الجهاز' });
}));

router.post('/unsubscribe', ah(async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, req.ctx.userId);
  else db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND tenant_id=?').run(req.ctx.userId, req.ctx.tenantId);
  res.json({ ok: true });
}));

router.get('/devices', ah(async (req, res) => {
  res.json(db.prepare(`SELECT id, substr(endpoint,1,60) endpoint_preview, user_agent, platform, created_at, last_used_at, failed_count
    FROM push_subscriptions WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC`)
    .all(req.ctx.tenantId, req.ctx.userId));
}));

/** إشعار تجريبي للتأكد من وصول الإشعارات على الجهاز */
router.post('/test', ah(async (req, res) => {
  const result = await notifyUsers(req.ctx.tenantId, [req.ctx.userId], {
    type: 'system.test', category: 'system', title: '🔔 إشعار تجريبي من منصة نور',
    body: 'وصلك هذا الإشعار بنجاح — نظام الإشعارات يعمل على هذا الجهاز.', url: '/notifications'
  });
  res.json({ ok: true, ...result, push_enabled: pushEnabled() });
}));

/** بث إداري لكل منسوبي الجهة أو فرع محدد */
router.post('/broadcast', can('notifications.broadcast'), ah(async (req, res) => {
  const { title, body, url, branch_id } = req.body || {};
  if (!title) throw badRequest('عنوان الإشعار إلزامي');
  const r = await broadcast(req.ctx.tenantId, {
    type: 'announcement', category: 'system', title: title.trim(),
    body: body || '', url: url || '/', urgency: 'high'
  }, { branchId: branch_id ? Number(branch_id) : null });
  audit(req, { action: 'create', entity: 'notification', summary: `بث إشعار عام: ${title} (${r.created} مستلم)` });
  res.json({ ok: true, ...r });
}));

/* ── تفضيلات الإشعارات ───────────────────────────────────────────────────── */
router.get('/preferences', ah(async (req, res) => {
  const u = db.prepare('SELECT notify_prefs FROM users WHERE id=?').get(req.ctx.userId);
  res.json({
    preferences: j(u.notify_prefs, {}),
    channels: [
      { key: 'inapp', label: 'داخل المنصة', description: 'جرس الإشعارات داخل التطبيق' },
      { key: 'push', label: 'إشعارات الجوال والمتصفح', description: 'تصلك حتى والتطبيق مغلق' }
    ],
    categories: [
      { key: 'tasks', label: 'المهام واللجان' },
      { key: 'finance', label: 'الطلبات المالية والاعتمادات' },
      { key: 'hr', label: 'الحضور والإجازات والرواتب' },
      { key: 'chat', label: 'المحادثات السياقية' },
      { key: 'tickets', label: 'تذاكر الدعم الفني' },
      { key: 'system', label: 'تنبيهات النظام والإعلانات' }
    ],
    push_enabled: pushEnabled(),
    online: onlineUsers(req.ctx.tenantId).includes(req.ctx.userId)
  });
}));

router.put('/preferences', ah(async (req, res) => {
  const cur = j(db.prepare('SELECT notify_prefs FROM users WHERE id=?').get(req.ctx.userId).notify_prefs, {});
  const next = { ...cur, ...(req.body?.preferences || {}) };
  db.prepare('UPDATE users SET notify_prefs=? WHERE id=?').run(JSON.stringify(next), req.ctx.userId);
  res.json({ ok: true, preferences: next });
}));

export default router;
