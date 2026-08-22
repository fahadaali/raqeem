import { Hono } from 'hono';
import { nowUTC, j } from '../sql.js';
import { h, created } from '../http.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { can } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { buildReportHTML } from '../report.js';
import {
  platformSettings, tenantSubscription, tenantUsage, planLimits, planPrice, yearlySavings,
  startSubscription, issueInvoice, outstandingBalance, subscriptionWritable,
  subscriptionBlockReason, STATUS_AR, INVOICE_STATUS_AR, CYCLES, periodEnd
} from '../billing.js';

/**
 * شاشة الاشتراك والفوترة الخاصة بالجهة (المرحلة الثانية).
 * تُظهر الخطة والاستهلاك مقابل الحدود، وتتيح الترقية والسداد وتنزيل الفواتير.
 */
const router = new Hono();

const pct = (used, limit) => (limit ? Math.min(100, Math.round((used / limit) * 100)) : null);

async function overview(app, tenantId) {
  const settings = await platformSettings(app);
  const sub = await tenantSubscription(app, tenantId);
  const usage = await tenantUsage(app, tenantId);
  const balance = await outstandingBalance(app, tenantId);
  const limits = sub?.plan ? planLimits(sub.plan) : { branches: null, users: null, storage_mb: null };

  return {
    saas_enabled: !!settings.saas_enabled,
    currency: settings.currency,
    vat_rate: settings.vat_rate,
    bank_details: settings.bank_details,
    support_email: settings.support_email,
    subscription: sub && {
      status: sub.status, status_label: STATUS_AR[sub.status] || sub.status,
      cycle: sub.cycle,
      trial_ends_at: sub.trial_ends_at,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      grace_until: sub.grace_until,
      writable: subscriptionWritable(sub),
      block_reason: subscriptionBlockReason(sub),
      price: sub.plan ? planPrice(sub.plan, sub.cycle) : 0,
      plan: sub.plan && {
        code: sub.plan.code, name: sub.plan.name, tagline: sub.plan.tagline,
        price_monthly: sub.plan.price_monthly, price_yearly: sub.plan.price_yearly,
        features: sub.plan.features, perks: sub.plan.perks
      }
    },
    usage: {
      branches: { used: usage.branches, limit: limits.branches, percent: pct(usage.branches, limits.branches) },
      users: { used: usage.users, limit: limits.users, percent: pct(usage.users, limits.users) },
      storage_mb: { used: usage.storage_mb, limit: limits.storage_mb, percent: pct(usage.storage_mb, limits.storage_mb) }
    },
    balance
  };
}

router.get('/', can('billing.view'), h(async (req) => overview(req.app, req.ctx.tenantId)));

/* الخطط المتاحة للترقية أو التخفيض */
router.get('/plans', can('billing.view'), h(async (req) => {
  const sub = await tenantSubscription(req.app, req.ctx.tenantId);
  const usage = await tenantUsage(req.app, req.ctx.tenantId);
  const rows = await req.app.db.all('SELECT * FROM plans WHERE is_active=1 ORDER BY sort, price_monthly');
  return {
    current: sub?.plan?.code || null,
    plans: rows.map(p => {
      const limits = planLimits(p);
      /* خطة لا تتسع للاستهلاك الحالي لا يمكن النزول إليها */
      const blockers = Object.entries(limits)
        .filter(([k, v]) => v !== null && Number(usage[k] || 0) > v)
        .map(([k, v]) => ({ resource: k, limit: v, current: usage[k] }));
      return {
        code: p.code, name: p.name, tagline: p.tagline, description: p.description,
        price_monthly: p.price_monthly, price_yearly: p.price_yearly, currency: p.currency,
        limits, features: j(p.features, []) || [], perks: j(p.perks, []) || [],
        highlight: !!p.highlight, yearly_savings: yearlySavings(p),
        selectable: blockers.length === 0, blockers
      };
    })
  };
}));

/* ترقية / تخفيض / تغيير الدورة */
router.post('/subscribe', can('billing.manage'), h(async (req) => {
  const app = req.app;
  const tenantId = req.ctx.tenantId;
  const planCode = String(req.body?.plan_code || '');
  const cycle = CYCLES.includes(req.body?.cycle) ? req.body.cycle : 'monthly';

  const plan = await app.db.get('SELECT * FROM plans WHERE code=? AND is_active=1', planCode);
  if (!plan) throw badRequest('الخطة المطلوبة غير متاحة');

  const usage = await tenantUsage(app, tenantId);
  const limits = planLimits(plan);
  for (const [key, limit] of Object.entries(limits)) {
    if (limit !== null && Number(usage[key] || 0) > limit) {
      throw badRequest(`استهلاك الجهة الحالي يتجاوز حدود خطة «${plan.name}» — قلّل ${key} أولاً`, { resource: key, limit, current: usage[key] });
    }
  }

  const before = await tenantSubscription(app, tenantId);
  const sub = await startSubscription(app, tenantId, { planCode, cycle, status: 'active' });

  /* فاتورة الفترة الجديدة تُصدر فوراً للخطط المدفوعة */
  let invoice = null;
  if (planPrice(plan, cycle) > 0) {
    invoice = await issueInvoice(app, tenantId, sub, { note: `اشتراك ${plan.name} — ${cycle === 'yearly' ? 'سنوي' : 'شهري'}` });
  }
  await app.db.run('UPDATE tenants SET plan=? WHERE id=?', plan.code, tenantId);

  await audit(req, {
    action: 'update', entity: 'subscription', entityId: sub.id,
    summary: `${req.ctx.userName} غيّر خطة الاشتراك إلى «${plan.name}» (${cycle === 'yearly' ? 'سنوي' : 'شهري'})`,
    before: before && { plan: before.plan?.code, cycle: before.cycle, status: before.status },
    after: { plan: plan.code, cycle, status: sub.status }
  });
  return created({ subscription: await overview(app, tenantId), invoice });
}));

/* إيقاف التجديد التلقائي */
router.post('/cancel', can('billing.manage'), h(async (req) => {
  const sub = await tenantSubscription(req.app, req.ctx.tenantId);
  if (!sub) throw notFound('لا يوجد اشتراك فعّال');
  await req.app.db.run(
    'UPDATE subscriptions SET cancel_at_period_end=1, canceled_at=?, updated_at=? WHERE id=?',
    nowUTC(), nowUTC(), sub.id);
  await audit(req, { action: 'update', entity: 'subscription', entityId: sub.id,
    summary: `${req.ctx.userName} أوقف التجديد التلقائي للاشتراك — يستمر حتى ${String(sub.current_period_end).slice(0, 10)}` });
  return overview(req.app, req.ctx.tenantId);
}));

router.post('/resume', can('billing.manage'), h(async (req) => {
  const sub = await tenantSubscription(req.app, req.ctx.tenantId);
  if (!sub) throw notFound('لا يوجد اشتراك فعّال');
  await req.app.db.run(
    'UPDATE subscriptions SET cancel_at_period_end=0, canceled_at=NULL, updated_at=? WHERE id=?',
    nowUTC(), sub.id);
  await audit(req, { action: 'update', entity: 'subscription', entityId: sub.id,
    summary: `${req.ctx.userName} أعاد تفعيل التجديد التلقائي للاشتراك` });
  return overview(req.app, req.ctx.tenantId);
}));

/* ─────────────── الفواتير ─────────────── */
router.get('/invoices', can('billing.view'), h(async (req) => {
  const rows = await req.app.db.all(
    'SELECT * FROM subscription_invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 100', req.ctx.tenantId);
  return {
    items: rows.map(r => ({ ...r, status_label: INVOICE_STATUS_AR[r.status] || r.status })),
    balance: await outstandingBalance(req.app, req.ctx.tenantId)
  };
}));

router.get('/invoices/:id', can('billing.view'), h(async (req) => {
  const inv = await req.app.db.get('SELECT * FROM subscription_invoices WHERE id=? AND tenant_id=?',
    req.params.id, req.ctx.tenantId);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  const payments = await req.app.db.all(
    `SELECT p.*, u.name AS declared_by_name FROM subscription_payments p
     LEFT JOIN users u ON u.id=p.declared_by WHERE p.invoice_id=? ORDER BY p.id DESC`, inv.id);
  return { ...inv, status_label: INVOICE_STATUS_AR[inv.status] || inv.status, payments };
}));

/** فاتورة رسمية مرَوَّسة بهوية المنصة (البند ١٣ مطبَّقاً على فواتير الاشتراك) */
router.get('/invoices/:id/print', can('billing.view'), h(async (req) => {
  const app = req.app;
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=? AND tenant_id=?',
    req.params.id, req.ctx.tenantId);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  const settings = await platformSettings(app);
  const tenant = await app.db.get('SELECT * FROM tenants WHERE id=?', req.ctx.tenantId);

  const html = buildReportHTML({
    tenant: { ...tenant, name: settings.platform_name },
    title: `فاتورة اشتراك ${inv.number}`,
    subtitle: `${inv.plan_name} — ${inv.cycle === 'yearly' ? 'اشتراك سنوي' : 'اشتراك شهري'}`,
    columns: [
      { key: 'label', header: 'البيان' },
      { key: 'value', header: 'القيمة', num: true }
    ],
    rows: [
      { label: 'الجهة المشتركة', value: tenant.name },
      { label: 'رقم الفاتورة', value: inv.number },
      { label: 'الفترة', value: `${String(inv.period_start).slice(0, 10)} — ${String(inv.period_end).slice(0, 10)}` },
      { label: 'قيمة الاشتراك', value: `${inv.subtotal} ${inv.currency}` },
      { label: `ضريبة القيمة المضافة (${inv.vat_rate}%)`, value: `${inv.vat_amount} ${inv.currency}` },
      { label: 'الإجمالي المستحق', value: `${inv.total} ${inv.currency}` },
      { label: 'الحالة', value: INVOICE_STATUS_AR[inv.status] || inv.status }
    ],
    filters: [
      ...(settings.vat_number ? [{ label: 'الرقم الضريبي', value: settings.vat_number }] : []),
      ...(settings.cr_number ? [{ label: 'السجل التجاري', value: settings.cr_number }] : [])
    ],
    summary: [{ label: 'الإجمالي شامل الضريبة', value: `${inv.total} ${inv.currency}` }],
    calendar: req.ctx.calendarPref,
    generatedBy: req.ctx.userName,
    orientation: 'portrait'
  });
  await audit(req, { action: 'export', entity: 'subscription_invoice', entityId: inv.id,
    summary: `${req.ctx.userName} طبع فاتورة الاشتراك ${inv.number}` });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}));

/** إشعار سداد (تحويل بنكي) — يبقى معلّقاً حتى يعتمده مالك المنصة */
router.post('/invoices/:id/declare-payment', can('billing.manage'), h(async (req) => {
  const app = req.app;
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=? AND tenant_id=?',
    req.params.id, req.ctx.tenantId);
  if (!inv) throw notFound('الفاتورة غير موجودة');
  if (inv.status === 'paid') throw badRequest('الفاتورة مسددة مسبقاً');
  if (inv.status === 'void') throw badRequest('الفاتورة ملغاة');

  const amount = Number(req.body?.amount ?? inv.total);
  if (!(amount > 0)) throw badRequest('مبلغ السداد غير صالح');

  const fileId = req.body?.file_id ? Number(req.body.file_id) : null;
  if (fileId) {
    const f = await app.db.get('SELECT id FROM files WHERE id=? AND tenant_id=?', fileId, req.ctx.tenantId);
    if (!f) throw badRequest('المرفق غير موجود');
  }

  const r = await app.db.run(
    `INSERT INTO subscription_payments(tenant_id,invoice_id,amount,currency,method,reference,status,file_id,declared_by,note)
     VALUES(?,?,?,?,?,?,'pending',?,?,?)`,
    req.ctx.tenantId, inv.id, amount, inv.currency,
    ['bank_transfer', 'card', 'cash', 'manual'].includes(req.body?.method) ? req.body.method : 'bank_transfer',
    req.body?.reference || null, fileId, req.ctx.userId, req.body?.note || null);

  await audit(req, { action: 'create', entity: 'subscription_payment', entityId: r.lastId,
    summary: `${req.ctx.userName} أبلغ عن سداد ${amount} ${inv.currency} للفاتورة ${inv.number}` });
  return created({
    id: r.lastId, status: 'pending',
    message: 'سُجّل إشعار السداد — تُعتمد الفاتورة بعد تحقّق إدارة المنصة'
  });
}));

export default router;
