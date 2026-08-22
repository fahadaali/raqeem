import { state } from './state.js';

/** عميل الاتصال اللحظي (WebSocket) — الرسائل والإشعارات فوراً */
let ws = null, retry = 0, timer = null, alive = null;
const handlers = new Map();

export const on = (type, fn) => {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
};
const emit = (type, payload) => { for (const fn of handlers.get(type) || []) { try { fn(payload); } catch (e) { console.error(e); } } };

export function connect() {
  if (!state.accessToken) return;
  if (ws && [0, 1].includes(ws.readyState)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.accessToken)}`); }
  catch { return schedule(); }

  ws.onopen = () => { retry = 0; emit('open'); heartbeat(); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    emit(m.type, m);
    emit('*', m);
  };
  ws.onclose = () => { emit('close'); stopBeat(); schedule(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function heartbeat() {
  stopBeat();
  alive = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
}
const stopBeat = () => { if (alive) { clearInterval(alive); alive = null; } };

function schedule() {
  if (timer || !state.accessToken) return;
  const delay = Math.min(30000, 1200 * Math.pow(1.6, retry++));
  timer = setTimeout(() => { timer = null; connect(); }, delay);
}

export function send(payload) { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); }
export function disconnect() {
  stopBeat();
  if (timer) { clearTimeout(timer); timer = null; }
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
}
export const isConnected = () => ws?.readyState === 1;
