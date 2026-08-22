import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest } from '../errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { pushEnabled, publicKey } from '../push.js';
import { notifyUsers, broadcast } from '../notify.js';

const router = new Hono();

router.get('/vapid', h(async (req) => ({ enabled: pushEnabled(req.app.cfg), publicKey: publicKey(req.app.cfg) })));

router.get('/', h(async (req) => {
  const app = req.app;
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const onlyUnread = req.query.unread === '1';
  const rows = await app.db.all(
    `SELECT * FROM notifications WHERE tenant_id=? AND user_id=? ${onlyUnread ? 'AND is_read=0' : ''} ORDER BY id DESC LIMIT ?`,
    req.ctx.tenantId, req.ctx.userId, limit);
  const unread = (await app.db.get('SELECT COUNT(*) AS c FROM notifications WHERE tenant_id=? AND user_id=? AND is_read=0',
    req.ctx.tenantId, req.ctx.userId)).c;
  return { items: rows.map(n => ({ ...n, data: j(n.data, {}) })), unread };
}));

router.post('/read', h(async (req) => {
  const app = req.app;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (ids?.length) {
    await app.db.run(
      `UPDATE notifications SET is_read=1, read_at=? WHERE tenant_id=? AND user_id=? AND id IN (${ids.map(() => '?').join(',')})`,
      nowUTC(), req.ctx.tenantId, req.ctx.userId, ...ids);
  } else {
    await app.db.run('UPDATE notifications SET is_read=1, read_at=? WHERE tenant_id=? AND user_id=? AND is_read=0',
      nowUTC(), req.ctx.tenantId, req.ctx.userId);
  }
  const unread = (await app.db.get('SELECT COUNT(*) AS c FROM notifications WHERE tenant_id=? AND user_id=? AND is_read=0',
    req.ctx.tenantId, req.ctx.userId)).c;
  return { ok: true, unread };
}));

router.delete('/:id', h(async (req) => {
  await req.app.db.run('DELETE FROM notifications WHERE id=? AND tenant_id=? AND user_id=?',
    req.params.id, req.ctx.tenantId, req.ctx.userId);
  return { ok: true };
}));

/* تسجيل جهاز لاستقبال إشعارات الدفع */
router.post('/subscribe', h(async (req) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw badRequest('بيانات اشتراك الدفع غير مكتملة');
  await req.app.db.run(
    `INSERT INTO push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth,user_agent,platform,last_used_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, tenant_id=excluded.tenant_id,
       p256dh=excluded.p256dh, auth=excluded.auth, failed_count=0, last_used_at=excluded.last_used_at`,
    req.ctx.tenantId, req.ctx.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth,
    (req.get('user-agent') || '').slice(0, 250), req.body?.platform || null, nowUTC());
  await audit(req, { action: 'create', entity: 'push_subscription', summary: 'تفعيل إشعارات الدفع على جهاز جديد' });
  return created({ ok: true, message: 'تم تفعيل الإشعارات على هذا الجهاز' });
}));

router.post('/unsubscribe', h(async (req) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) await req.app.db.run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?', endpoint, req.ctx.userId);
  else await req.app.db.run('DELETE FROM push_subscriptions WHERE user_id=? AND tenant_id=?', req.ctx.userId, req.ctx.tenantId);
  return { ok: true };
}));

router.get('/devices', h(async (req) =>
  req.app.db.all(`SELECT id, substr(endpoint,1,60) AS endpoint_preview, user_agent, platform, created_at, last_used_at, failed_count
    FROM push_subscriptions WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC`, req.ctx.tenantId, req.ctx.userId)));

router.post('/test', h(async (req) => {
  const result = await notifyUsers(req.app, req.ctx.tenantId, [req.ctx.userId], {
    type: 'system.test', category: 'system', title: '🔔 إشعار تجريبي من منصة نور',
    body: 'وصلك هذا الإشعار بنجاح — نظام الإشعارات يعمل على هذا الجهاز.', url: '/notifications'
  });
  return { ok: true, ...result, push_enabled: pushEnabled(req.app.cfg) };
}));

router.post('/broadcast', can('notifications.broadcast'), h(async (req) => {
  const { title, body, url, branch_id } = req.body || {};
  if (!title) throw badRequest('عنوان الإشعار إلزامي');
  const r = await broadcast(req.app, req.ctx.tenantId, {
    type: 'announcement', category: 'system', title: String(title).trim(),
    body: body || '', url: url || '/', urgency: 'high'
  }, { branchId: branch_id ? Number(branch_id) : null });
  await audit(req, { action: 'create', entity: 'notification', summary: `بث إشعار عام: ${title} (${r.created} مستلم)` });
  return { ok: true, ...r };
}));

router.get('/preferences', h(async (req) => {
  const u = await req.app.db.get('SELECT notify_prefs FROM users WHERE id=?', req.ctx.userId);
  return {
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
    push_enabled: pushEnabled(req.app.cfg),
    online: !!(await req.app.realtime?.isOnline?.(req.ctx.tenantId, req.ctx.userId))
  };
}));

router.put('/preferences', h(async (req) => {
  const cur = j((await req.app.db.get('SELECT notify_prefs FROM users WHERE id=?', req.ctx.userId)).notify_prefs, {}) || {};
  const next = { ...cur, ...(req.body?.preferences || {}) };
  await req.app.db.run('UPDATE users SET notify_prefs=? WHERE id=?', JSON.stringify(next), req.ctx.userId);
  return { ok: true, preferences: next };
}));

export default router;
