import { state } from './state.js';

/**
 * عميل القناة اللحظية — الرسائل والإشعارات فوراً.
 * يعمل عبر WebSocket (خادم Node أو Durable Object على Cloudflare)، وإن تعذّر
 * فتح القناة (خطة لا تدعم الكائنات الدائمة، أو وسيط شبكة يمنع الترقية) يتحوّل
 * تلقائياً إلى الاستطلاع الدوري فلا تتوقّف الإشعارات ولا المحادثات عن التحديث.
 */
let ws = null, retry = 0, timer = null, alive = null;
let mode = 'ws', pollTimer = null, retryWsTimer = null;
const POLL_MS = 20_000;          // مدّة الاستطلاع في وضع التراجع
const WS_RETRY_MS = 90_000;      // إعادة محاولة القناة الدائمة أثناء الاستطلاع
const MAX_WS_FAILURES = 3;

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

  ws.onopen = () => { retry = 0; stopPolling(); setMode('ws'); emit('open'); heartbeat(); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    emit(m.type, m);
    emit('*', m);
  };
  ws.onclose = () => { emit('close'); stopBeat(); schedule(); };
  ws.onerror = () => { try { ws.close(); } catch { /* مغلق أصلاً */ } };
}

function heartbeat() {
  stopBeat();
  alive = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
}
const stopBeat = () => { if (alive) { clearInterval(alive); alive = null; } };

function schedule() {
  if (timer || !state.accessToken) return;
  if (retry >= MAX_WS_FAILURES) return startPolling();
  const delay = Math.min(30000, 1200 * Math.pow(1.6, retry++));
  timer = setTimeout(() => { timer = null; connect(); }, delay);
}

/* ── وضع التراجع: الاستطلاع الدوري ── */
function startPolling() {
  if (pollTimer) return;
  setMode('poll');
  pollTimer = setInterval(() => { if (state.accessToken && !document.hidden) emit('poll', { at: Date.now() }); }, POLL_MS);
  retryWsTimer = setInterval(() => { if (state.accessToken) { retry = 0; connect(); } }, WS_RETRY_MS);
  emit('poll', { at: Date.now() });
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (retryWsTimer) { clearInterval(retryWsTimer); retryWsTimer = null; }
}
function setMode(m) {
  if (mode === m) return;
  mode = m;
  emit('mode', { mode: m });
}

export function send(payload) { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); }
export function disconnect() {
  stopBeat();
  stopPolling();
  retry = 0;
  mode = 'ws';
  if (timer) { clearTimeout(timer); timer = null; }
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* مغلق أصلاً */ } ws = null; }
}
export const isConnected = () => ws?.readyState === 1;
export const currentMode = () => (isConnected() ? 'ws' : mode);
