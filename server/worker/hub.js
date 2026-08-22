/**
 * كائن دائم (Durable Object) — مركز البث اللحظي لكل جهة تعليمية (Tenant).
 * يقابل خادم WebSocket في بيئة Node، ويوفّر الواجهة نفسها للبند ٨ من الوثيقة:
 *   • محادثات سياقية فورية        • إشعارات لحظية داخل المنصة
 *   • مؤشّر «يكتب الآن»           • معرفة من هو متصل الآن
 *
 * يستخدم واجهة السبات (Hibernation API) فلا يُحتسب وقت المعالجة أثناء
 * انتظار الرسائل، ويستمر الاتصال مفتوحاً بتكلفة شبه معدومة.
 */
export class RealtimeHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // نبضات القلب يردّ عليها التشغيل تلقائياً دون إيقاظ الكائن
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(JSON.stringify({ type: 'ping' }), JSON.stringify({ type: 'pong' })));
    } catch { /* غير متاح في بعض الإصدارات — النبضات ستمرّ عبر المعالج العادي */ }
  }

  tag(userId) { return `u:${userId}`; }

  sockets(userId) {
    try { return this.state.getWebSockets(this.tag(userId)); } catch { return []; }
  }

  async fetch(request) {
    const url = new URL(request.url);

    /* ── فتح اتصال جديد (بعد أن تحقّق الـ Worker من الرمز) ── */
    if (url.pathname === '/connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
        return new Response('يتطلّب ترقية الاتصال إلى WebSocket', { status: 426 });

      const uid = Number(url.searchParams.get('uid'));
      const name = url.searchParams.get('name') || '';
      const tenant = url.searchParams.get('tenant') || '';
      if (!uid) return new Response('مستخدم غير معروف', { status: 400 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [this.tag(uid)]);
      try { server.serializeAttachment({ uid, name }); } catch { /* اختياري */ }
      server.send(JSON.stringify({ type: 'ready', user: name, tenant }));
      return new Response(null, { status: 101, webSocket: client });
    }

    /* ── بثّ حمولة إلى مستخدمين محدّدين ── */
    if (url.pathname === '/emit' && request.method === 'POST') {
      const { userIds = [], payload } = await request.json();
      const data = JSON.stringify(payload);
      let delivered = 0;
      for (const uid of new Set(userIds)) {
        for (const ws of this.sockets(uid)) {
          try { ws.send(data); delivered++; } catch { /* اتصال منتهٍ */ }
        }
      }
      return Response.json({ delivered });
    }

    /* ── حالة الاتصال ── */
    if (url.pathname === '/online') {
      const uid = url.searchParams.get('uid');
      if (uid) return Response.json({ online: this.sockets(Number(uid)).length > 0 });
      const users = new Set();
      for (const ws of this.state.getWebSockets()) {
        try { const a = ws.deserializeAttachment(); if (a?.uid) users.add(a.uid); } catch { /* تجاهل */ }
      }
      return Response.json({ users: [...users] });
    }

    return new Response('المسار غير موجود', { status: 404 });
  }

  /* ── الرسائل الواردة من العميل ── */
  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    let me = null;
    try { me = ws.deserializeAttachment(); } catch { /* تجاهل */ }

    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));

    if (msg.type === 'typing' && msg.conversationId && me) {
      const data = JSON.stringify({ type: 'chat.typing', conversationId: msg.conversationId, user: me.name });
      for (const uid of (msg.members || []).filter(m => m !== me.uid)) {
        for (const peer of this.sockets(uid)) { try { peer.send(data); } catch { /* تجاهل */ } }
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code === 1006 ? 1000 : code, reason); } catch { /* مغلق أصلاً */ }
  }

  async webSocketError() { /* يُغلق الاتصال تلقائياً */ }
}
