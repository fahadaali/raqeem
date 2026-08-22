import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import config, { ROOT } from './config.js';
import db from './db/index.js';
import { migrate } from './db/migrate.js';
import { AppError } from './lib/errors.js';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { attach as attachRealtime } from './lib/realtime.js';
import { startJobs } from './jobs/index.js';
import { pushEnabled } from './lib/push.js';

import authRoutes from './routes/auth.js';
import orgRoutes from './routes/org.js';
import termRoutes from './routes/terms.js';
import taskRoutes from './routes/tasks.js';
import hrRoutes from './routes/hr.js';
import financeRoutes from './routes/finance.js';
import formRoutes from './routes/forms.js';
import commsRoutes from './routes/comms.js';
import fileRoutes from './routes/files.js';
import notificationRoutes from './routes/notifications.js';
import dataRoutes from './routes/data.js';
import { keysRouter, publicRouter } from './routes/integration.js';

migrate();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

// ── رؤوس الأمان ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  if (config.env === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
});

// ── فحص الجاهزية ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const tenants = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  res.json({
    status: 'ok', service: 'noor-erp', time: new Date().toISOString(),
    env: config.env, tenants, push: pushEnabled(), uptime: Math.round(process.uptime())
  });
});

// ── المفتاح العام لإشعارات الدفع (عام بطبيعته — يُقرأ قبل الاشتراك) ────────
app.get('/api/push/vapid', (req, res) => {
  res.json({ enabled: pushEnabled(), publicKey: config.vapid.publicKey });
});

// ── الواجهة البرمجية العامة للأنظمة الخارجية (مفاتيح ربط + حد للطلبات) ─────
app.use('/api/v1', publicRouter);

// ── المصادقة ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── المسارات المحمية ────────────────────────────────────────────────────────
const api = express.Router();
api.use(authenticate);
api.use(rateLimit({ key: (r) => `u:${r.ctx?.userId || r.ip}` }));

api.use('/org', orgRoutes);
api.use('/terms', termRoutes);
api.use('/tasks', taskRoutes);
api.use('/hr', hrRoutes);
api.use('/finance', financeRoutes);
api.use('/forms', formRoutes);
api.use('/comms', commsRoutes);
api.use('/files', fileRoutes);
api.use('/notifications', notificationRoutes);
api.use('/api-keys', keysRouter);
api.use('/', dataRoutes);
app.use('/api', api);

// ── الملفات الثابتة (واجهة المستخدم) ───────────────────────────────────────
const WEB = path.join(ROOT, 'web');
app.use('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(WEB, 'sw.js'));
});
app.use(express.static(WEB, {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(png|svg|ico|webp|woff2?)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ── توجيه تطبيق الصفحة الواحدة ─────────────────────────────────────────────
app.get(/^\/(?!api|ws).*/, (req, res, next) => {
  const file = path.join(WEB, 'index.html');
  if (!fs.existsSync(file)) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file);
});

// ── معالج الأخطاء الموحّد ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: `حجم الملف يتجاوز الحد المسموح (${config.uploadMaxMb} ميجابايت)` } });
  }
  if (String(err?.message || '').includes('TERM_CLOSED')) {
    return res.status(423).json({ error: { code: 'TERM_CLOSED', message: 'هذا الفصل مؤرشف ومغلق للقراءة فقط — لا يمكن التعديل عليه' } });
  }
  if (String(err?.message || '').includes('AUDIT_APPEND_ONLY')) {
    return res.status(423).json({ error: { code: 'AUDIT_APPEND_ONLY', message: 'سجلات التدقيق غير قابلة للتعديل أو الحذف' } });
  }
  console.error('[error]', err);
  res.status(500).json({
    error: {
      code: 'SERVER_ERROR',
      message: config.env === 'production' ? 'حدث خطأ غير متوقع في الخادم' : err.message
    }
  });
});

const server = http.createServer(app);
attachRealtime(server);
startJobs();

server.listen(config.port, () => {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   منصة نور — الإدارة المتكاملة للمجمعات     │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  ▸ الخادم يعمل على : ${config.appUrl}`);
  console.log(`  ▸ البيئة          : ${config.env}`);
  console.log(`  ▸ قاعدة البيانات  : ${config.dbFile}`);
  console.log(`  ▸ إشعارات الدفع   : ${pushEnabled() ? 'مفعّلة ✔' : 'معطّلة (شغّل npm run gen:vapid)'}`);
  console.log('');
});

const shutdown = (sig) => {
  console.log(`\n[${sig}] إيقاف الخادم بأمان...`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
