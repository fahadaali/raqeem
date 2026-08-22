/**
 * تدقيق القناة اللحظية والوظائف المجدولة — يعمل على البيئتين:
 *   node scripts/verify-realtime.js                       (التشغيل الذاتي / WebSocket)
 *   BASE=http://localhost:8787 node scripts/verify-realtime.js   (Cloudflare / Durable Object)
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');
let pass = 0, fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
  return !!cond;
};

async function call(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const inbox = [];
    const timer = setTimeout(() => reject(new Error('انتهت مهلة فتح الاتصال')), 8000);
    ws.onmessage = (e) => { try { inbox.push(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('فشل الاتصال')); };
    ws.onopen = () => { clearTimeout(timer); resolve({ ws, inbox }); };
  });
}

console.log(`\n▸ القناة اللحظية والوظائف المجدولة — ${BASE}\n`);

const admin = (await call('POST', '/api/auth/login', { body: { email: 'admin@riyadh-qu.sa', password: 'Admin@123' } })).data;
const teacher = (await call('POST', '/api/auth/login', { body: { email: 'teacher@riyadh-qu.sa', password: 'Teach@123' } })).data;
if (!admin?.accessToken || !teacher?.accessToken) {
  console.error('✘ تعذّر تسجيل الدخول — شغّل التهيئة أولاً'); process.exit(1);
}

/* ── ١. رفض الاتصال بلا رمز صالح ── */
let rejected = false;
try { await openSocket('not-a-real-token'); } catch { rejected = true; }
if (!rejected) { /* بعض البيئات تفتح ثم تُغلق — نتحقق من عدم وصول رسالة جاهزية */ }
ok('رفض اتصال البثّ برمز غير صالح', rejected);

/* ── ٢. فتح اتصال ورسالة الجاهزية ── */
const t = await openSocket(teacher.accessToken);
await wait(600);
const ready = t.inbox.find(m => m.type === 'ready');
ok('فتح قناة البثّ اللحظي', !!ready);
ok('رسالة الجاهزية تحمل هوية المستخدم والجهة', !!ready?.user && !!ready?.tenant, JSON.stringify(ready));

/* ── ٣. المستخدم يظهر متصلاً في تفضيلات الإشعارات ── */
await wait(300);
const prefs = (await call('GET', '/api/notifications/preferences', { token: teacher.accessToken })).data;
ok('المنصة تعرف أن المستخدم متصل الآن', prefs.online === true, `online=${prefs.online}`);

/* ── ٤. وصول إشعار لحظي عند إسناد مهمة ── */
t.inbox.length = 0;
const task = await call('POST', '/api/tasks', {
  token: admin.accessToken,
  body: { title: 'مهمة اختبار البثّ اللحظي', assignee_id: teacher.user.id, priority: 'high' }
});
for (let i = 0; i < 30 && !t.inbox.some(m => m.type === 'notification'); i++) await wait(200);
const live = t.inbox.find(m => m.type === 'notification');
ok('وصول الإشعار لحظياً عبر القناة', !!live, JSON.stringify(t.inbox.slice(0, 3)));
ok('الإشعار اللحظي يحمل عنوان المهمة',
  !!live && String(live.notification?.body || '').includes('اختبار البثّ اللحظي'), JSON.stringify(live?.notification));

/* ── ٥. نبضة القلب ── */
t.inbox.length = 0;
t.ws.send(JSON.stringify({ type: 'ping' }));
for (let i = 0; i < 20 && !t.inbox.some(m => m.type === 'pong'); i++) await wait(150);
ok('استجابة نبضة القلب (pong)', t.inbox.some(m => m.type === 'pong'));

/* ── ٦. مؤشّر «يكتب الآن» بين مستخدمين ── */
const a = await openSocket(admin.accessToken);
await wait(400);
a.inbox.length = 0;
t.ws.send(JSON.stringify({ type: 'typing', conversationId: 1, members: [admin.user.id] }));
for (let i = 0; i < 20 && !a.inbox.some(m => m.type === 'chat.typing'); i++) await wait(150);
ok('مؤشّر «يكتب الآن» يصل للطرف الآخر', a.inbox.some(m => m.type === 'chat.typing'));

/* ── ٧. عزل البثّ: لا تصل إشعارات مستخدم لآخر ── */
a.inbox.length = 0;
await call('POST', '/api/tasks', {
  token: admin.accessToken,
  body: { title: 'مهمة خاصة بالمعلم', assignee_id: teacher.user.id }
});
await wait(1200);
ok('عزل القناة: لا يستقبل المدير إشعارات المعلم',
  !a.inbox.some(m => m.type === 'notification' && String(m.notification?.body).includes('خاصة بالمعلم')));

t.ws.close(); a.ws.close();
await wait(300);

/* ── ٨. الوظائف المجدولة (Cron) — متاحة في wrangler dev فقط ── */
if (process.env.BASE) {
  const crons = ['*/5 * * * *', '*/15 * * * *', '0 * * * *', '0 3 * * *', '0 2 * * *', '0 1 * * *', '0 0 * * *'];
  for (const cron of crons) {
    const res = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`);
    ok(`تنفيذ الوظيفة المجدولة «${cron}»`, res.status === 200, `status ${res.status}`);
  }
} else {
  console.log('  ⟳ الوظائف المجدولة على Node تعمل بمؤقّتات داخلية (setInterval) — تُختبر في بيئة Cloudflare');
}

console.log(`\n  النتيجة: ${pass} ناجح · ${fail} فاشل\n`);
process.exit(fail ? 1 : 0);
