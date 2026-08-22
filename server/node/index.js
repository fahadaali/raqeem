import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createNodeContainer } from './container.js';
import { createApi } from '../core/app.js';
import { securityHeaders, errorHandler } from '../core/http.js';
import { migrate } from './migrate.js';
import { drain, requeueStuck } from '../core/queue.js';
import { periodic } from '../core/jobs/index.js';
import { runBackup } from './backup.js';
import { pushEnabled } from '../core/push.js';
import { ROOT } from './env.js';

const container = createNodeContainer();
const { cfg } = container;
await migrate(container);

const WEB = path.join(ROOT, 'web');
const app = new Hono({ strict: false });   // /api/v1 و /api/v1/ متكافئان
app.use('*', securityHeaders(cfg));
app.route('/api', createApi(container));

/* الملفات الثابتة وتوجيه تطبيق الصفحة الواحدة */
app.get('/sw.js', async (c) => new Response(fs.readFileSync(path.join(WEB, 'sw.js')), {
  headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' } }));
app.use('/*', serveStatic({
  root: path.relative(process.cwd(), WEB) || './web',
  onFound(pathname, c) {
    if (/\.(png|svg|ico|webp|woff2?)$/i.test(pathname)) c.header('Cache-Control', 'public, max-age=604800');
    else if (pathname.endsWith('.webmanifest')) c.header('Content-Type', 'application/manifest+json; charset=utf-8');
    else c.header('Cache-Control', 'no-cache');
  }
}));
app.get('*', (c) => {
  if (c.req.path.startsWith('/api')) return c.json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } }, 404);
  c.header('Cache-Control', 'no-cache');
  return c.html(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'));
});
app.onError(errorHandler);

const server = serve({ fetch: app.fetch, port: cfg.port, createServer: http.createServer }, (info) => {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   منصة نور — الإدارة المتكاملة للمجمعات     │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  ▸ الخادم يعمل على : http://localhost:${info.port}`);
  console.log(`  ▸ البيئة          : ${cfg.env}  ·  التشغيل: Node`);
  console.log(`  ▸ قاعدة البيانات  : ${cfg.dbFile}`);
  console.log(`  ▸ إشعارات الدفع   : ${pushEnabled(cfg) ? 'مفعّلة ✔' : 'معطّلة (شغّل npm run gen:vapid)'}`);
  console.log('');
});

container.realtime.attach(server, container);

/* الوظائف الدورية */
const safe = (name, fn) => async () => {
  try { const r = await fn(container); if (r) console.log(`[job:${name}]`, JSON.stringify(r)); }
  catch (e) { console.error(`[job:${name}] خطأ:`, e.message); }
};
const slaJob = safe('sla', periodic.sla);
const kpiJob = safe('kpi', periodic.kpi);
const dueJob = safe('deadlines', periodic.deadlines);
const backupJob = safe('backup', async () => (cfg.backup.enabled
  ? { snapshot: await runBackup(container), logical: await periodic.backup(container) }
  : null));

setTimeout(() => { kpiJob(); slaJob(); requeueStuck(container).catch(() => {}); }, 10_000).unref?.();
setInterval(() => drain(container).catch(e => console.error('[queue]', e.message)), 5_000).unref?.();
setInterval(slaJob, 15 * 60_000).unref?.();
setInterval(kpiJob, 60 * 60_000).unref?.();

let lastDaily = '';
setInterval(() => {
  const now = new Date(Date.now() + 180 * 60000);   // بتوقيت الرياض
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 6 && lastDaily !== today + 'd') { lastDaily = today + 'd'; dueJob(); }
  if (now.getUTCHours() === cfg.backup.hour && lastDaily !== today + 'b') { lastDaily = today + 'b'; backupJob(); }
}, 5 * 60_000).unref?.();

console.log('✔ تم تشغيل مجدول الوظائف الخلفية (الترحيل، الاستيراد، المؤشرات، مستوى الخدمة، النسخ الاحتياطي)');

const shutdown = (sig) => {
  console.log(`\n[${sig}] إيقاف الخادم بأمان...`);
  server.close(() => { container.db.close?.(); process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
