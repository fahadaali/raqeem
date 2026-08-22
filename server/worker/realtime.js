/**
 * محوّل الاتصال اللحظي على Cloudflare — يتحدّث إلى الكائن الدائم RealtimeHub
 * بالواجهة نفسها التي يستخدمها محوّل Node، فلا تعرف الشيفرة المشتركة أيّ بيئة تعمل.
 * إن لم يكن الربط HUB متاحاً (خطة لا تدعم Durable Objects) يعود null،
 * فيتحوّل العميل تلقائياً إلى الاستطلاع الدوري دون أي خطأ.
 */
export function createWorkerRealtime(env, waitUntil) {
  const ns = env?.HUB;
  if (!ns) return null;

  const stub = (tenantId) => ns.get(ns.idFromName(`tenant:${tenantId}`));
  const keep = (p) => { const q = Promise.resolve(p).catch(() => {}); waitUntil?.(q); return q; };

  const hub = {
    kind: 'durable-object',

    emitToUsers(tenantId, userIds, payload) {
      const ids = [...new Set((userIds || []).filter(Boolean))].map(Number);
      if (!ids.length) return 0;
      keep(stub(tenantId).fetch('https://hub/emit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: ids, payload })
      }));
      return ids.length;
    },

    emitToUser(tenantId, userId, payload) { return hub.emitToUsers(tenantId, [userId], payload); },

    async isOnline(tenantId, userId) {
      try {
        const r = await stub(tenantId).fetch(`https://hub/online?uid=${Number(userId)}`);
        return !!(await r.json()).online;
      } catch { return false; }
    },

    async onlineUsers(tenantId) {
      try {
        const r = await stub(tenantId).fetch('https://hub/online');
        return (await r.json()).users || [];
      } catch { return []; }
    },

    /** ترقية طلب /ws إلى اتصال دائم بعد التحقّق من هوية المستخدم */
    connect(ctx, request) {
      const u = new URL('https://hub/connect');
      u.searchParams.set('uid', String(ctx.userId));
      u.searchParams.set('name', ctx.userName || '');
      u.searchParams.set('tenant', ctx.tenantName || '');
      return stub(ctx.tenantId).fetch(u.toString(), {
        headers: { upgrade: 'websocket', connection: 'Upgrade' }
      });
    }
  };

  return hub;
}
