import { Hono } from 'hono';
import { createApi } from '../core/app.js';
import { securityHeaders, errorHandler } from '../core/http.js';
import { verifyJWT } from '../core/crypto.js';
import { buildContext } from '../core/middleware/auth.js';
import { drain, requeueStuck } from '../core/queue.js';
import { periodic } from '../core/jobs/index.js';
import { seed } from '../core/seed.js';
import { createWorkerContainer } from './container.js';
import { migrate } from './migrate.js';

export { RealtimeHub } from './hub.js';

const NO_CACHE = 'no-cache, must-revalidate';
const ASSET_CACHE = 'public, max-age=604800';

/**
 * نقطة الدخول على Cloudflare Workers — الشيفرة المشتركة نفسها المستخدمة على Node،
 * ولا يختلف هنا إلا ربط المزوّدات: D1 للبيانات، R2 للملفات، Durable Object للبثّ اللحظي،
 * Static Assets للواجهة، Cron Triggers للوظائف الدورية، وQueues للمعالجة الخلفية.
 */
const app = new Hono({ strict: false });

/* حاوية التطبيق تُبنى لكل طلب لأن البيئة على Workers تُمرَّر مع الطلب */
app.use('*', async (c, next) => {
  let exec = null;
  try { exec = c.executionCtx; } catch { /* غير متاح خارج سياق الطلب */ }
  const container = createWorkerContainer(c.env, exec);
  c.set('container', container);
  return securityHeaders(container.cfg)(c, next);
});

/* واجهات المنصة — الشيفرة المشتركة بحذافيرها */
app.route('/api', createApi((c) => c.get('container')));

/* الملفات الثابتة وتوجيه تطبيق الصفحة الواحدة (شبكة أمان إن مرّ الطلب إلى العامل) */
app.all('*', async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api'))
    return c.json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } }, 404);

  const assets = c.env.ASSETS;
  if (!assets) return c.text('لم يُربط مجلّد الواجهة (ASSETS) في wrangler.toml', 500);

  const serve = (pathname) => {
    const target = new URL(url);
    target.pathname = pathname;
    target.search = '';
    return assets.fetch(new Request(target.toString(), { method: 'GET', headers: c.req.raw.headers }));
  };

  let res = await serve(url.pathname);
  let isShell = false;
  if (res.status === 404) { res = await serve('/index.html'); isShell = true; }

  res = new Response(res.body, res);
  if (isShell) {
    res.headers.set('Content-Type', 'text/html; charset=utf-8');
    res.headers.set('Cache-Control', NO_CACHE);
  } else if (url.pathname === '/sw.js') {
    res.headers.set('Content-Type', 'application/javascript; charset=utf-8');
    res.headers.set('Service-Worker-Allowed', '/');
    res.headers.set('Cache-Control', NO_CACHE);
  } else if (url.pathname.endsWith('.webmanifest')) {
    res.headers.set('Content-Type', 'application/manifest+json; charset=utf-8');
    res.headers.set('Cache-Control', NO_CACHE);
  } else if (/\.(png|svg|ico|webp|woff2?|jpe?g)$/i.test(url.pathname)) {
    res.headers.set('Cache-Control', ASSET_CACHE);
  } else {
    res.headers.set('Cache-Control', NO_CACHE);
  }
  return res;
});

app.onError(errorHandler);

/* ───────────────── ترقية اتصال البثّ اللحظي (البند ٨) ───────────────── */
async function handleWebSocket(request, container) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response('يتطلّب هذا المسار اتصال WebSocket', { status: 426 });

  if (!container.realtime)
    return new Response('البثّ اللحظي غير مفعّل — يعمل التطبيق بالاستطلاع الدوري', { status: 501 });

  const token = new URL(request.url).searchParams.get('token');
  if (!token) return new Response('رمز الدخول مفقود', { status: 401 });

  try {
    const payload = await verifyJWT(token, container.cfg.jwtSecret);
    const ctx = await buildContext(container, payload.sub);
    if (!ctx || ctx.tenantId !== payload.tid) return new Response('رمز غير صالح', { status: 401 });
    return container.realtime.connect(ctx, request);
  } catch {
    return new Response('رمز غير صالح أو منتهي', { status: 401 });
  }
}

/* ───────────────── صفحة التهيئة من المتصفّح ─────────────────
 * التهيئة تحتاج POST برأس x-bootstrap-token، وهذا لا يُنفَّذ من شريط العنوان.
 * فتُقدَّم هنا صفحة صغيرة قائمة بذاتها تأخذ الرمز وتُرسله كما هو — فيتم النشر
 * كاملاً من المتصفّح دون وحدة طرفية. الرمز يبقى شرطاً، ولا تكشف الصفحة شيئاً.
 */
function bootstrapPage(hasToken) {
  const html = `<!doctype html><html dir="rtl" lang="ar"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>تهيئة منصة رقيم</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600&family=Zain:wght@800&display=swap">
<style>
 /* توكنز هوية رقيم — الصفحة قائمة بذاتها فلا تصل إليها app.css */
 :root{--primary:#2F8A6F;--primary-dark:#1C5E4C;--secondary:#E8A25C;--mint:#CBE7DC;
  --cream:#FBF7EF;--ink:#22302B;--line:#EDE5D8;--light:#F6F0E6;
  --text:#55645C;--dim:#8A9790;--error:#B4552E;--warning:#D9A036;--clay:#EFD4C8;--mint-2:#F6E1C6}
 *{box-sizing:border-box} body{margin:0;background:var(--cream);color:var(--text);
  font:15px/1.9 "IBM Plex Sans Arabic",system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;
  display:grid;place-items:center;min-height:100dvh;padding:20px}
 .card{background:#fff;border:1px solid var(--line);border-radius:22px;
  padding:28px;max-width:560px;width:100%;box-shadow:0 10px 45px rgba(34,48,43,.05)}
 h1{margin:0 0 4px;font:800 24px/1.35 "Zain","IBM Plex Sans Arabic",sans-serif;color:var(--primary-dark)}
 p.sub{margin:0 0 20px;color:var(--dim);font-size:13.5px}
 label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;color:var(--ink)}
 input[type=text]{width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:12px;
  font:inherit;direction:ltr;text-align:left}
 input[type=text]:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--mint)}
 .row{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13.5px}
 .row label{display:flex;align-items:center;gap:7px;font-weight:400;margin:0}
 /* التهيئة إجراءٌ رئيسي — المشمشي هنا في موضعه الوحيد */
 button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:999px;background:var(--secondary);
  color:#fff;font:600 15px/1 inherit;cursor:pointer;min-height:48px;transition:.2s}
 button:hover:not(:disabled){background:#D98F45;box-shadow:0 5px 24px rgba(232,162,92,.35)}
 button:disabled{opacity:.55;cursor:default}
 pre{background:var(--ink);color:var(--cream);padding:14px;border-radius:12px;overflow:auto;
  font-size:12.5px;direction:ltr;text-align:left;margin-top:18px;white-space:pre-wrap;word-break:break-word}
 .msg{margin-top:16px;padding:12px 14px;border-radius:12px;font-size:13.5px;display:none}
 .ok{background:var(--mint);color:var(--primary-dark);border:1px solid var(--primary)}
 .err{background:var(--clay);color:var(--error);border:1px solid var(--error)}
 .warn{background:var(--mint-2);color:#8A5A20;border:1px solid var(--warning)}
 ol{margin:10px 0 0;padding-inline-start:20px;font-size:13.5px;color:var(--dim)}
 code{background:var(--light);padding:1px 6px;border-radius:6px;font-size:12.5px;direction:ltr;display:inline-block}
</style></head><body><div class="card">
 <h1>تهيئة منصة رقيم</h1>
 <p class="sub">تُنفَّذ مرّة واحدة: تُنشئ جداول قاعدة البيانات وتعبّئ الجهة رقم ١.</p>
 ${hasToken ? '' : '<div class="msg warn" style="display:block">لم يُضبط السرّ <code>BOOTSTRAP_TOKEN</code> على العامل. أضِفه من لوحة Cloudflare ← العامل ← Settings ← Variables and Secrets، ثم أعِد تحميل هذه الصفحة.</div>'}
 <form id="f" ${hasToken ? '' : 'style="opacity:.45;pointer-events:none"'}>
  <label for="t">رمز التهيئة (BOOTSTRAP_TOKEN)</label>
  <input id="t" type="text" autocomplete="off" spellcheck="false" placeholder="الصق الرمز هنا">
  <div class="row">
   <label><input type="checkbox" id="schema"> المخطط فقط بلا بيانات تجريبية</label>
   <label><input type="checkbox" id="force"> إعادة التعبئة رغم وجود بيانات</label>
  </div>
  <button id="b" type="submit">تهيئة المنصة</button>
 </form>
 <div class="msg" id="m"></div>
 <pre id="o" style="display:none"></pre>
</div><script>
const f=document.getElementById('f'),b=document.getElementById('b'),
      m=document.getElementById('m'),o=document.getElementById('o');
const show=(k,h)=>{m.className='msg '+k;m.innerHTML=h;m.style.display='block';};
f.addEventListener('submit',async(e)=>{
 e.preventDefault();
 const tok=document.getElementById('t').value.trim();
 if(!tok)return show('err','الصق رمز التهيئة أولاً.');
 b.disabled=true;b.textContent='جارٍ التهيئة…';m.style.display='none';o.style.display='none';
 const q=new URLSearchParams();
 if(document.getElementById('schema').checked)q.set('schema-only','1');
 if(document.getElementById('force').checked)q.set('force','1');
 try{
  const r=await fetch('/__bootstrap'+(q.toString()?'?'+q:''),
    {method:'POST',headers:{'x-bootstrap-token':tok}});
  const d=await r.json().catch(()=>({}));
  o.textContent=JSON.stringify(d,null,1);o.style.display='block';
  if(r.ok){
   show('ok','<b>تمّت التهيئة.</b><ol>'
    +'<li>افتح <code>/</code> وادخل بـ <code>admin@riyadh-qu.sa</code> / <code>Admin@123</code></li>'
    +'<li>لوحة المنصة على <code>/admin</code> بحساب مستقل: <code>admin@raqeem.sa</code> / <code>Admin@123</code></li>'
    +'<li>غيّر كل كلمات المرور الافتراضية فوراً</li>'
    +'<li>احذف السرّ <code>BOOTSTRAP_TOKEN</code> من إعدادات العامل</li></ol>');
   b.textContent='تمّت التهيئة';
  }else{
   show('err',(d.error||'فشلت التهيئة')+' — رمز الاستجابة '+r.status);
   b.disabled=false;b.textContent='إعادة المحاولة';
  }
 }catch(err){
  show('err','تعذّر الاتصال بالعامل: '+err.message);
  b.disabled=false;b.textContent='إعادة المحاولة';
 }
});
</script></body></html>`;
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow'
  } });
}

/* ───────────────── تهيئة أولية آمنة: المخطط + بيانات المستأجر رقم ١ ───────────────── */
async function handleBootstrap(request, container) {
  const secret = container.env.BOOTSTRAP_TOKEN;
  if (!secret) return Response.json({ error: 'التهيئة معطّلة — لم يُضبط السرّ BOOTSTRAP_TOKEN' }, { status: 403 });

  const given = request.headers.get('x-bootstrap-token') || '';
  if (given.length !== secret.length || given !== secret)
    return Response.json({ error: 'رمز التهيئة غير صحيح' }, { status: 401 });

  const url = new URL(request.url);
  await migrate(container);
  const tenantId = url.searchParams.get('schema-only') === '1'
    ? null
    : await seed(container, { force: url.searchParams.get('force') === '1' });

  return Response.json({
    ok: true,
    migrated: true,
    seeded: tenantId ? { tenant_id: tenantId } : 'البيانات موجودة مسبقاً — تم التخطي',
    database: container.db.dialect,
    storage: container.storage?.driver || 'غير مربوط',
    realtime: container.realtime?.kind || 'استطلاع دوري'
  });
}

/* ───────────────── الوظائف الدورية (Cron Triggers) ───────────────── */

/**
 * الوظائف اليومية موزّعةً بساعة التشغيل العالمية.
 *
 * الخطة المجانية في Cloudflare تسمح بخمسة مُشغِّلات كرون للحساب كلِّه، وكانت
 * سبعةً هنا فرُفض ضبطها جميعاً ووقف النشر. وأربعٌ منها يومية في ساعاتٍ متجاورة،
 * فجُمعت في تعبيرٍ واحد `0 0,1,2,3 * * *` وتُوزَّع هنا بالساعة: لا وظيفةَ تسقط
 * ولا موعدَ يتغيّر — الساعةُ نفسها لا تزال في التعبير.
 */
const DAILY_BY_HOUR = {
  /* ٠٣:٠٠ بتوقيت الرياض: لقطة مؤشرات المنصة وتقليم السجلات */
  0: (app) => periodic.metrics(app),
  /* ٠٤:٠٠ بتوقيت الرياض: دورة الاشتراكات والفوترة (المرحلة الثانية) */
  1: (app) => periodic.subscriptions(app),
  /* ٠٥:٠٠ بتوقيت الرياض: النسخ الاحتياطي اليومي إلى R2 (البند ١٠) */
  2: (app) => periodic.backup(app),
  /* ٠٦:٠٠ بتوقيت الرياض: تذكير المهام المستحقة */
  3: (app) => periodic.deadlines(app)
};

/*
 * نبضةٌ واحدةٌ تُغني عن أربعة مُشغِّلات.
 *
 * الخطة المجانية في كلاود فلير تسمح بخمسة مُشغِّلات للحساب كلِّه — لا للعامل
 * وحده — فكلُّ مُشغِّلٍ نحجزه يزاحم ما سواه على سِعةٍ ضيّقة. والمواقيت التي
 * كانت موزّعةً على أربعة تُستخرَج من وقت الحدث نفسه: النبضة كلَّ خمس دقائق
 * تصرّف الطابور، وعند كلِّ ربع ساعةٍ تُصعِّد التذاكر، وعند رأس الساعة تُعيد
 * احتساب المؤشرات، وعند رأس الساعات الأربع الأولى تُشغّل يوميّتها.
 *
 * وكلُّ وظيفةٍ تُنفَّذ في عزلةٍ عن أختها: سقوط النسخ الاحتياطي لا يُسقط تصريف
 * الطابور معه، ولا يُخفي أثره — يُسجَّل خطؤه ويمضي ما بعده.
 */
async function tick(app, at) {
  const now = new Date(at);
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const out = {};

  const step = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: String(e?.message || e) };
      console.error('[cron]', name, e?.stack || e);
    }
  };

  await step('drained', () => drain(app, { max: 40 }));
  await step('requeued', () => requeueStuck(app));
  if (minute % 15 === 0) await step('sla', () => periodic.sla(app));
  if (minute === 0) await step('kpi', () => periodic.kpi(app));

  const daily = minute === 0 ? DAILY_BY_HOUR[hour] : null;
  if (daily) await step('daily', () => daily(app));

  return out;
}

const CRON_JOBS = {
  /* النبضة الوحيدة: كلُّ ما سبق يوزَّع من وقتها */
  '*/5 * * * *': tick,

  /* المفاتيح القديمة تبقى: عاملٌ منشورٌ بضبطٍ سابق لا تسقط وظائفه حتى يُحدَّث */
  '*/15 * * * *': async (app) => periodic.sla(app),
  '0 * * * *': async (app) => periodic.kpi(app),
  '0 0,1,2,3 * * *': async (app, at) => {
    const h = new Date(at).getUTCHours();
    const job = DAILY_BY_HOUR[h];
    return job ? await job(app) : { skipped: h };
  },
  '0 3 * * *': async (app) => periodic.deadlines(app),
  '0 2 * * *': async (app) => periodic.backup(app),
  '0 1 * * *': async (app) => periodic.subscriptions(app),
  '0 0 * * *': async (app) => periodic.metrics(app)
};

async function runCron(cron, container, at = Date.now()) {
  const results = {};
  const job = CRON_JOBS[cron];
  if (job) {
    results[cron] = await job(container, at);
  } else {
    results.drained = await drain(container, { max: 40 });
    results.sla = await periodic.sla(container);
    results.kpi = await periodic.kpi(container);
  }
  console.log('[cron]', cron, JSON.stringify(results));
  return results;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* صفحة التهيئة تُفتح بـ GET من المتصفّح، والتنفيذ يبقى POST برأس الرمز */
    if (url.pathname === '/__bootstrap' && request.method === 'GET') {
      return bootstrapPage(!!env.BOOTSTRAP_TOKEN);
    }

    if (url.pathname === '/ws' || (url.pathname === '/__bootstrap' && request.method === 'POST')) {
      const container = createWorkerContainer(env, ctx);
      try {
        return url.pathname === '/ws'
          ? await handleWebSocket(request, container)
          : await handleBootstrap(request, container);
      } catch (e) {
        console.error('[worker]', e?.stack || e);
        return Response.json({ error: String(e?.message || e) }, { status: 500 });
      }
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    const container = createWorkerContainer(env, ctx);
    /* وقتُ الحدث من Cloudflare لا من ساعة الجهاز — به تُعرَف أيُّ يوميّةٍ هذه */
    ctx.waitUntil(runCron(event.cron, container, event.scheduledTime)
      .catch(e => console.error('[cron] خطأ:', e.message)));
  },

  /** معالج Cloudflare Queues — يُستخدم تلقائياً عند ربط الطابور JOBS (خطة مدفوعة) */
  async queue(batch, env, ctx) {
    const container = createWorkerContainer(env, ctx);
    for (const msg of batch.messages) {
      try {
        await drain(container, { max: 1, jobId: msg.body?.jobId });
        msg.ack();
      } catch (e) {
        console.error('[queue] فشل تنفيذ وظيفة:', e.message);
        msg.retry();
      }
    }
  }
};
