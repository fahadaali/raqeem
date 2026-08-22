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
  '0 2 * * *': async (app) => periodic.backup(app)
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
