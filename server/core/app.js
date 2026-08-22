import { Hono } from 'hono';
import { withRequest, errorHandler, notFoundHandler, securityHeaders, h } from './http.js';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { registerAllJobs } from './jobs/index.js';
import { pushEnabled, publicKey } from './push.js';

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
import { importsRouter, reportsRouter, auditRouter, dashboardRouter } from './routes/data.js';
import { keysRouter, publicRouter } from './routes/integration.js';
import publicSaasRoutes from './routes/public.js';
import billingRoutes from './routes/billing.js';
import adminRoutes from './routes/admin.js';
import adminAuthRoutes from './routes/admin-auth.js';
import { subscriptionGate } from './middleware/saas.js';
import { requireFeature } from './features.js';

registerAllJobs();

/**
 * يبني تطبيق واجهات المنصة — شيفرة واحدة تعمل على Node وعلى Cloudflare Workers،
 * ويُمرَّر إليها «الحاوية» (app) التي تحمل قاعدة البيانات والتخزين والإعدادات.
 */
export function createApi(container) {
  /* strict:false ⇒ /api/v1 و /api/v1/ يشيران إلى المسار نفسه */
  const api = new Hono({ strict: false });

  api.use('*', async (c, next) => {
    c.set('app', typeof container === 'function' ? container(c) : container);
    c.set('ip', c.req.header('cf-connecting-ip')
      || (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
      || c.req.header('x-real-ip') || '0.0.0.0');
    await next();
  });
  api.use('*', withRequest);
  api.onError(errorHandler);
  api.notFound(notFoundHandler);

  /* فحص الجاهزية */
  api.get('/health', h(async (req) => {
    const t = await req.app.db.get('SELECT COUNT(*) AS c FROM tenants');
    return {
      status: 'ok', service: 'raqeem-erp', time: new Date().toISOString(),
      env: req.app.cfg.env, runtime: req.app.runtime, tenants: t.c,
      push: pushEnabled(req.app.cfg), storage: req.app.storage.driver,
      database: req.app.db.dialect
    };
  }));

  /* المفتاح العام لإشعارات الدفع (عام بطبيعته) */
  api.get('/push/vapid', h(async (req) => ({ enabled: pushEnabled(req.app.cfg), publicKey: publicKey(req.app.cfg) })));

  /* الواجهة البرمجية العامة للأنظمة الخارجية */
  api.route('/v1', publicRouter);

  /* الواجهات العامة للمرحلة الثانية: الأسعار والتسجيل الآلي وهوية النطاق */
  api.route('/public', publicSaasRoutes);

  /* إشعار بوابة الدفع — تُناديه البوابة نفسها بلا جلسة */
  api.post('/webhooks/payments', h(async (req) => {
    const { paymentWebhook } = await import('./routes/admin.js');
    return paymentWebhook(req.app, req.body || {});
  }));

  /* المصادقة */
  api.route('/auth', authRoutes);

  /* المسارات المحمية — كل مجموعة تُغلَّف بحارسها الخاص داخل بادئتها فقط،
     حتى لا تتسرَّب مصادقة الجلسة إلى الواجهة العامة /api/v1 */
  const guard = (routes, { gate = true, feature = null } = {}) => {
    const g = new Hono();
    g.use('*', authenticate());
    g.use('*', rateLimit({ key: (r) => `u:${r.ctx?.userId || r.ip}` }));
    /* بوابة الاشتراك: تمنع الكتابة عند توقف الاشتراك وتُبقي القراءة والسداد */
    if (gate) g.use('*', subscriptionGate());
    /* حارس الميزة: يجعل قائمة مزايا الخطة نافذة لا تزيينية */
    if (feature) g.use('*', requireFeature(feature));
    g.route('/', routes);
    return g;
  };

  api.route('/org', guard(orgRoutes));
  api.route('/terms', guard(termRoutes));
  api.route('/tasks', guard(taskRoutes, { feature: 'tasks' }));
  api.route('/hr', guard(hrRoutes));    /* الحضور والرواتب ميزتان منفصلتان */
  api.route('/finance', guard(financeRoutes, { feature: 'finance' }));
  api.route('/forms', guard(formRoutes)); /* النماذج ومؤشرات الأداء ميزتان منفصلتان */
  api.route('/comms', guard(commsRoutes)); /* البوابة داخل الوحدة: التذاكر والمحادثات ميزتان منفصلتان */
  api.route('/files', guard(fileRoutes));
  api.route('/notifications', guard(notificationRoutes));
  api.route('/api-keys', guard(keysRouter, { feature: 'api' }));
  api.route('/imports', guard(importsRouter, { feature: 'imports' }));
  api.route('/reports', guard(reportsRouter, { feature: 'reports' }));
  api.route('/audit', guard(auditRouter));
  api.route('/dashboard', guard(dashboardRouter));

  /* المرحلة الثانية: اشتراك الجهة */
  api.route('/billing', guard(billingRoutes, { gate: false }));

  /*
   * لوحة المنصة: طبقة مستقلة تماماً — هويّة أخرى وحارس آخر.
   * لا تمرّ بـ guard() لأن ذاك يبني سياق مستأجر، ولا سياق مستأجر هنا أصلاً.
   * حدّ الطلبات يُفتَح على معرّف الادمن لا على مستخدم جهة.
   */
  api.route('/admin/auth', adminAuthRoutes);
  const adminGuarded = new Hono();
  adminGuarded.use('*', rateLimit({ key: (r) => `adm:${r.ctx?.adminId || r.ip}` }));
  adminGuarded.route('/', adminRoutes);
  api.route('/admin', adminGuarded);

  return api;
}

/** يبني التطبيق الكامل مع رؤوس الأمان (الملفات الثابتة تُخدَم من كل بيئة بطريقتها) */
export function createApp(container, { cfg }) {
  const app = new Hono({ strict: false });
  app.use('*', securityHeaders(cfg));
  app.route('/api', createApi(container));
  app.onError(errorHandler);
  return app;
}
