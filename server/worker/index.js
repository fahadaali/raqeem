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
<style>
 :root{--brand:#0F5132;--gold:#C9A227;--bg:#f6f7f5;--card:#fff;--line:#e3e6e1;--txt:#1c2320;--dim:#6b736e}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);
  font:15px/1.9 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;
  display:grid;place-items:center;min-height:100dvh;padding:20px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:28px;max-width:560px;width:100%;box-shadow:0 6px 24px rgba(0,0,0,.06)}
 h1{margin:0 0 4px;font-size:20px;color:var(--brand)} p.sub{margin:0 0 20px;color:var(--dim);font-size:13.5px}
 label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
 input[type=text]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;
  font:inherit;direction:ltr;text-align:left}
 .row{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13.5px}
 .row label{display:flex;align-items:center;gap:7px;font-weight:400;margin:0}
 button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:11px;background:var(--brand);
  color:#fff;font:600 15px/1 inherit;cursor:pointer;min-height:48px}
 button:disabled{opacity:.55;cursor:default}
 pre{background:#0f1613;color:#d6e4dc;padding:14px;border-radius:11px;overflow:auto;
  font-size:12.5px;direction:ltr;text-align:left;margin-top:18px;white-space:pre-wrap;word-break:break-word}
 .msg{margin-top:16px;padding:12px 14px;border-radius:11px;font-size:13.5px;display:none}
 .ok{background:#e7f4ec;color:#15633a;border:1px solid #bfe0cd}
 .err{background:#fdeaea;color:#a32020;border:1px solid #f3c4c4}
 .warn{background:#fdf6e3;color:#8a6d1f;border:1px solid #ecdcae}
 ol{margin:10px 0 0;padding-inline-start:20px;font-size:13.5px;color:var(--dim)}
 code{background:#eef1ee;padding:1px 6px;border-radius:5px;font-size:12.5px;direction:ltr;display:inline-block}
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
   b.textContent='تمّت التهيئة ✔';
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
const CRON_JOBS = {
  /* كل ٥ دقائق: تصريف طابور المعالجة الخلفية وإعادة العالق منه */
  '*/5 * * * *': async (app) => ({ drained: await drain(app, { max: 40 }), requeued: await requeueStuck(app) }),
  /* كل ١٥ دقيقة: تصعيد التذاكر المتجاوزة لاتفاقية مستوى الخدمة (البند ٨) */
  '*/15 * * * *': async (app) => periodic.sla(app),
  /* كل ساعة: إعادة احتساب مؤشرات الأداء (البند ٧) */
  '0 * * * *': async (app) => periodic.kpi(app),
  /* ٠٦:٠٠ بتوقيت الرياض = ٠٣:٠٠ عالمياً: تذكير المهام المستحقة */
  '0 3 * * *': async (app) => periodic.deadlines(app),
  /* ٠٥:٠٠ بتوقيت الرياض = ٠٢:٠٠ عالمياً: النسخ الاحتياطي اليومي إلى R2 (البند ١٠) */
  '0 2 * * *': async (app) => periodic.backup(app),
  /* ٠٤:٠٠ بتوقيت الرياض = ٠١:٠٠ عالمياً: دورة الاشتراكات والفوترة (المرحلة الثانية) */
  '0 1 * * *': async (app) => periodic.subscriptions(app),
  /* ٠٣:٠٠ بتوقيت الرياض = ٠٠:٠٠ عالمياً: لقطة مؤشرات المنصة وتقليم السجلات */
  '0 0 * * *': async (app) => periodic.metrics(app)
};

async function runCron(cron, container) {
  const results = {};
  const job = CRON_JOBS[cron];
  if (job) {
    results[cron] = await job(container);
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
    ctx.waitUntil(runCron(event.cron, container).catch(e => console.error('[cron] خطأ:', e.message)));
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
