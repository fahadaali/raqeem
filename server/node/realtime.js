import { WebSocketServer } from 'ws';
import { verifyJWT } from '../core/crypto.js';
import { buildContext } from '../core/middleware/auth.js';

/**
 * الاتصال لوقت فعلي (WebSockets) على Node — البند ٨
 * (على Cloudflare يُستخدم Durable Object بالواجهة نفسها)
 */
export function createNodeRealtime() {
  const clients = new Map();   // "tenantId:userId" -> Set<ws>
  const key = (t, u) => `${t}:${u}`;

  const hub = {
    kind: 'ws',
    emitToUser(tenantId, userId, payload) {
      const set = clients.get(key(tenantId, userId));
      if (!set) return 0;
      const data = JSON.stringify(payload);
      let n = 0;
      for (const ws of set) if (ws.readyState === 1) { ws.send(data); n++; }
      return n;
    },
    emitToUsers(tenantId, userIds, payload) {
      let n = 0;
      for (const uid of new Set(userIds || [])) n += hub.emitToUser(tenantId, uid, payload);
      return n;
    },
    isOnline: (tenantId, userId) => clients.has(key(tenantId, userId)),
    onlineUsers: (tenantId) => [...clients.keys()].filter(k => k.startsWith(`${tenantId}:`)).map(k => Number(k.split(':')[1]))
  };

  hub.attach = (server, app) => {
    /* التحقّق من الرمز قبل إتمام المصافحة — السلوك نفسه على Cloudflare */
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req, socket, head) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
      if (url.pathname !== '/ws') return;   // مسار آخر — يتولّاه مستمع غيرنا

      const deny = (code, msg) => {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };

      const token = url.searchParams.get('token');
      if (!token) return deny(401, 'Unauthorized');

      let ctx = null;
      try {
        const payload = await verifyJWT(token, app.cfg.jwtSecret);
        ctx = await buildContext(app, payload.sub);
        if (!ctx || ctx.tenantId !== payload.tid) ctx = null;
      } catch { ctx = null; }
      if (!ctx) return deny(401, 'Unauthorized');

      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ctx));
    });

    wss.on('connection', (ws, req, ctx) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });

      const k = key(ctx.tenantId, ctx.userId);
      if (!clients.has(k)) clients.set(k, new Set());
      clients.get(k).add(ws);
      ws.send(JSON.stringify({ type: 'ready', user: ctx.userName, tenant: ctx.tenantName }));

      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        if (msg.type === 'typing' && msg.conversationId) {
          hub.emitToUsers(ctx.tenantId, (msg.members || []).filter(m => m !== ctx.userId),
            { type: 'chat.typing', conversationId: msg.conversationId, user: ctx.userName });
        }
      });

      ws.on('close', () => {
        const set = clients.get(k);
        if (set) { set.delete(ws); if (!set.size) clients.delete(k); }
      });
    });

    const hb = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* تجاهل */ }
      }
    }, 30_000);
    hb.unref?.();
    wss.on('close', () => clearInterval(hb));
    return wss;
  };

  return hub;
}
