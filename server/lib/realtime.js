import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import config from '../config.js';
import { buildContext } from '../middleware/auth.js';

/**
 * الاتصال لوقت فعلي (WebSockets) — البند ٨
 * يتيح ظهور الرسائل والإشعارات في نفس اللحظة دون تحديث الصفحة.
 */
const clients = new Map();   // userId -> Set<ws>

function key(tenantId, userId) { return `${tenantId}:${userId}`; }

export function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let ctx = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');

    const authenticate = (t) => {
      try {
        const payload = jwt.verify(t, config.jwtSecret, { issuer: 'noor-erp' });
        const c = buildContext(payload.sub);
        if (!c || c.tenantId !== payload.tid) return false;
        ctx = c;
        ws.ctx = { tenantId: c.tenantId, userId: c.userId };
        const k = key(c.tenantId, c.userId);
        if (!clients.has(k)) clients.set(k, new Set());
        clients.get(k).add(ws);
        ws.send(JSON.stringify({ type: 'ready', user: c.userName, tenant: c.tenantName }));
        return true;
      } catch { return false; }
    };

    if (token && !authenticate(token)) {
      ws.send(JSON.stringify({ type: 'error', message: 'رمز غير صالح' }));
      return ws.close();
    }

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth' && !ctx) {
        if (!authenticate(msg.token)) { ws.send(JSON.stringify({ type: 'error', message: 'رمز غير صالح' })); ws.close(); }
        return;
      }
      if (!ctx) return;
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      if (msg.type === 'typing' && msg.conversationId) {
        emitToConversation(ctx.tenantId, msg.members || [], {
          type: 'chat.typing', conversationId: msg.conversationId, user: ctx.userName
        }, ctx.userId);
      }
    });

    ws.on('close', () => {
      if (!ctx) return;
      const k = key(ctx.tenantId, ctx.userId);
      const set = clients.get(k);
      if (set) { set.delete(ws); if (!set.size) clients.delete(k); }
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  hb.unref?.();
  wss.on('close', () => clearInterval(hb));
  return wss;
}

/** إرسال حدث لمستخدم واحد عبر جميع أجهزته المفتوحة */
export function emitToUser(tenantId, userId, payload) {
  const set = clients.get(key(tenantId, userId));
  if (!set) return 0;
  const data = JSON.stringify(payload);
  let n = 0;
  for (const ws of set) { if (ws.readyState === 1) { ws.send(data); n++; } }
  return n;
}

export function emitToUsers(tenantId, userIds, payload) {
  let n = 0;
  for (const uid of new Set(userIds)) n += emitToUser(tenantId, uid, payload);
  return n;
}

export function emitToConversation(tenantId, memberIds, payload, exceptUserId = null) {
  return emitToUsers(tenantId, memberIds.filter(id => id !== exceptUserId), payload);
}

export const onlineUsers = (tenantId) =>
  [...clients.keys()].filter(k => k.startsWith(`${tenantId}:`)).map(k => Number(k.split(':')[1]));

export const isOnline = (tenantId, userId) => clients.has(key(tenantId, userId));
