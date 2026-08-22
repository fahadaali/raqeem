import { nowUTC, j } from './sql.js';
import { badRequest, quotaExceeded } from './errors.js';

/**
 * محرّك الاشتراكات والفوترة (المرحلة الثانية).
 * كل الحسابات هنا خالصة قدر الإمكان ليسهل التحقق منها، والكتابة تمرّ على
 * الواجهة غير المتزامنة نفسها فتعمل على SQLite و D1 دون فرق.
 */

export const CYCLES = ['monthly', 'yearly'];
export const SUB_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'];

export const STATUS_AR = {
  trialing: 'فترة تجريبية',
  active: 'نشط',
  past_due: 'متأخر السداد',
  canceled: 'ملغى',
  expired: 'منتهٍ'
};

export const INVOICE_STATUS_AR = {
  open: 'غير مسددة', paid: 'مسددة', void: 'ملغاة', uncollectible: 'متعذّر تحصيلها'
};

/* ─────────────────────────── إعدادات المنصة ─────────────────────────── */

const DEFAULT_SETTINGS = {
  id: 1,
  platform_name: 'منصة نور',
  platform_name_en: 'Noor Platform',
  tagline: 'منصة الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم',
  support_email: 'support@noor.sa',
  support_phone: null,
  saas_enabled: 0,
  signup_enabled: 0,
  signup_needs_review: 0,
  default_plan_code: 'growth',
  trial_days: 14,
  grace_days: 7,
  vat_rate: 15,
  currency: 'SAR',
  vat_number: null,
  cr_number: null,
  bank_details: '{}',
  invoice_prefix: 'NOOR',
  invoice_seq: 0
};

/** يقرأ إعدادات المنصة وينشئ الصف الأوحد عند أول استدعاء */
export async function platformSettings(app) {
  let row = await app.db.get('SELECT * FROM platform_settings WHERE id=1');
  if (!row) {
    const cols = Object.keys(DEFAULT_SETTINGS);
    await app.db.run(
      `INSERT OR IGNORE INTO platform_settings(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
      ...cols.map(c => DEFAULT_SETTINGS[c]));
    row = await app.db.get('SELECT * FROM platform_settings WHERE id=1');
  }
  return { ...row, bank_details: j(row.bank_details, {}) || {} };
}

/* ─────────────────────────── الخطط والحدود ─────────────────────────── */

export const planLimits = (plan) => ({
  branches: plan?.max_branches ?? null,
  users: plan?.max_users ?? null,
  storage_mb: plan?.max_storage_mb ?? null
});

export const planFeatures = (plan) => j(plan?.features, []) || [];

/** هل تتيح الخطة ميزة معيّنة؟ (غياب القائمة يعني إتاحة كل شيء) */
export function planAllows(plan, featureKey) {
  const features = planFeatures(plan);
  return !features.length || features.includes(featureKey);
}

export const planPrice = (plan, cycle) =>
  (cycle === 'yearly' ? Number(plan?.price_yearly || 0) : Number(plan?.price_monthly || 0));

/** الوفر السنوي مقابل الدفع الشهري (نسبة مئوية) */
export function yearlySavings(plan) {
  const monthly = Number(plan?.price_monthly || 0) * 12;
  const yearly = Number(plan?.price_yearly || 0);
  if (!monthly || !yearly || yearly >= monthly) return 0;
  return Math.round(((monthly - yearly) / monthly) * 100);
}

/* ─────────────────────────── الاستخدام الفعلي ─────────────────────────── */

/** يقيس استهلاك الجهة الحقيقي مقابل حدود خطتها */
export async function tenantUsage(app, tenantId) {
  const one = async (sql, ...p) => (await app.db.get(sql, ...p))?.c ?? 0;
  const bytes = (await app.db.get(
    'SELECT COALESCE(SUM(size),0) AS s FROM files WHERE tenant_id=?', tenantId))?.s || 0;
  return {
    branches: await one('SELECT COUNT(*) AS c FROM branches WHERE tenant_id=? AND is_active=1', tenantId),
    users: await one(`SELECT COUNT(*) AS c FROM users WHERE tenant_id=? AND status='active'`, tenantId),
    storage_mb: Math.round((bytes / 1048576) * 100) / 100,
    storage_bytes: bytes
  };
}

const RESOURCE_AR = { branches: 'الفروع', users: 'المستخدمين', storage_mb: 'مساحة التخزين' };

/**
 * يمنع تجاوز حدود الخطة قبل إنشاء مورد جديد.
 * @param {'branches'|'users'|'storage_mb'} resource
 * @param {number} adding الكمية المضافة (مساحة بالميغابايت للتخزين)
 */
export async function assertQuota(app, tenantId, resource, adding = 1) {
  const sub = await tenantSubscription(app, tenantId);
  if (!sub?.plan) return { ok: true, unlimited: true };

  const limit = planLimits(sub.plan)[resource];
  if (limit === null || limit === undefined) return { ok: true, unlimited: true };

  const usage = await tenantUsage(app, tenantId);
  const next = Number(usage[resource] || 0) + Number(adding || 0);
  if (next > limit) {
    throw quotaExceeded(
      `بلغت الجهة حدّ ${RESOURCE_AR[resource]} في خطة «${sub.plan.name}» (${limit}). رقِّ الخطة للمتابعة.`,
      { resource, limit, current: usage[resource], plan: sub.plan.code });
  }
  return { ok: true, limit, current: usage[resource] };
}

/* ─────────────────────────── الاشتراك ─────────────────────────── */

/** اشتراك الجهة مع خطته — أو null إن لم تُشترك بعد */
export async function tenantSubscription(app, tenantId) {
  const sub = await app.db.get('SELECT * FROM subscriptions WHERE tenant_id=?', tenantId);
  if (!sub) return null;
  const plan = await app.db.get('SELECT * FROM plans WHERE id=?', sub.plan_id);
  return { ...sub, plan: plan ? { ...plan, features: planFeatures(plan), perks: j(plan.perks, []) || [] } : null };
}

const addMonths = (date, n) => {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  /* ٣١ يناير + شهر = ٢٨/٢٩ فبراير لا ٣ مارس */
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
};

export const periodEnd = (startISO, cycle) =>
  addMonths(new Date(startISO), cycle === 'yearly' ? 12 : 1).toISOString();

export const addDays = (fromISO, days) =>
  new Date(new Date(fromISO).getTime() + days * 86400000).toISOString();

/** هل الاشتراك يسمح بالكتابة الآن؟ */
export function subscriptionWritable(sub) {
  if (!sub) return true;                       // لا طبقة SaaS مفعّلة لهذه الجهة
  if (['trialing', 'active'].includes(sub.status)) return true;
  if (sub.status === 'past_due') {
    return !sub.grace_until || sub.grace_until > nowUTC();
  }
  return false;
}

export function subscriptionBlockReason(sub) {
  if (!sub || subscriptionWritable(sub)) return null;
  if (sub.status === 'past_due') return 'انتهت مهلة السداد — يرجى تسديد الفاتورة المستحقة لاستئناف العمل';
  if (sub.status === 'canceled') return 'تم إلغاء اشتراك الجهة — يرجى التواصل مع إدارة المنصة';
  if (sub.status === 'expired') return 'انتهت الفترة التجريبية — اختر خطة اشتراك لمتابعة العمل';
  return 'اشتراك الجهة غير نشط حالياً';
}

/** ينشئ اشتراكاً جديداً لجهة (فترة تجريبية أو مدفوع مباشرةً) */
export async function startSubscription(app, tenantId, { planCode, cycle = 'monthly', trialDays = null, status = null } = {}) {
  const plan = await app.db.get('SELECT * FROM plans WHERE code=? AND is_active=1', planCode);
  if (!plan) throw badRequest('الخطة المطلوبة غير متاحة');
  if (!CYCLES.includes(cycle)) throw badRequest('دورة الاشتراك غير مدعومة');

  const settings = await platformSettings(app);
  const days = trialDays ?? plan.trial_days ?? settings.trial_days;
  const start = nowUTC();
  const free = planPrice(plan, cycle) === 0;
  const state = status || (free ? 'active' : (days > 0 ? 'trialing' : 'active'));
  const trialEnds = state === 'trialing' ? addDays(start, days) : null;
  const end = state === 'trialing' ? trialEnds : periodEnd(start, cycle);

  const existing = await app.db.get('SELECT id FROM subscriptions WHERE tenant_id=?', tenantId);
  if (existing) {
    await app.db.run(
      `UPDATE subscriptions SET plan_id=?, status=?, cycle=?, trial_ends_at=?,
        current_period_start=?, current_period_end=?, cancel_at_period_end=0, canceled_at=NULL,
        grace_until=NULL, updated_at=? WHERE tenant_id=?`,
      plan.id, state, cycle, trialEnds, start, end, nowUTC(), tenantId);
  } else {
    await app.db.run(
      `INSERT INTO subscriptions(tenant_id,plan_id,status,cycle,trial_ends_at,
        current_period_start,current_period_end) VALUES(?,?,?,?,?,?,?)`,
      tenantId, plan.id, state, cycle, trialEnds, start, end);
  }
  return tenantSubscription(app, tenantId);
}

/* ─────────────────────────── الفواتير ─────────────────────────── */

/** رقم فاتورة متسلسل على مستوى المنصة (ذرّي عبر UPDATE ... RETURNING البديل) */
export async function nextInvoiceNumber(app) {
  const s = await platformSettings(app);
  await app.db.run('UPDATE platform_settings SET invoice_seq = invoice_seq + 1, updated_at=? WHERE id=1', nowUTC());
  const after = await app.db.get('SELECT invoice_seq FROM platform_settings WHERE id=1');
  const seq = after?.invoice_seq ?? (s.invoice_seq + 1);
  const year = new Date().getUTCFullYear();
  return `${s.invoice_prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

export function computeTotals(amount, vatRate) {
  const subtotal = Math.round(Number(amount || 0) * 100) / 100;
  const vat = Math.round(subtotal * (Number(vatRate || 0) / 100) * 100) / 100;
  return { subtotal, vat_amount: vat, total: Math.round((subtotal + vat) * 100) / 100 };
}

/** يُصدر فاتورة اشتراك لفترة محددة */
export async function issueInvoice(app, tenantId, sub, { periodStart, periodEnd: pEnd, note = null } = {}) {
  const plan = sub.plan || await app.db.get('SELECT * FROM plans WHERE id=?', sub.plan_id);
  const settings = await platformSettings(app);
  const amount = planPrice(plan, sub.cycle);
  const { subtotal, vat_amount, total } = computeTotals(amount, settings.vat_rate);
  const number = await nextInvoiceNumber(app);
  const issued = nowUTC();

  const r = await app.db.run(
    `INSERT INTO subscription_invoices(tenant_id,subscription_id,number,status,plan_code,plan_name,cycle,
      period_start,period_end,subtotal,vat_rate,vat_amount,total,currency,issued_at,due_at,notes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    tenantId, sub.id, number, total > 0 ? 'open' : 'paid',
    plan.code, plan.name, sub.cycle,
    periodStart || sub.current_period_start, pEnd || sub.current_period_end,
    subtotal, settings.vat_rate, vat_amount, total, plan.currency || settings.currency,
    issued, addDays(issued, settings.grace_days), note);

  if (total === 0) {
    await app.db.run('UPDATE subscription_invoices SET paid_at=? WHERE id=?', issued, r.lastId);
  }
  return app.db.get('SELECT * FROM subscription_invoices WHERE id=?', r.lastId);
}

/** يعتمد سداد فاتورة ويعيد الاشتراك إلى الحالة النشطة */
export async function settleInvoice(app, invoiceId, { confirmedBy = null } = {}) {
  const inv = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', invoiceId);
  if (!inv) throw badRequest('الفاتورة غير موجودة');
  if (inv.status === 'paid') return inv;
  if (inv.status === 'void') throw badRequest('الفاتورة ملغاة');

  const stamp = nowUTC();
  const ops = [
    ['UPDATE subscription_invoices SET status=?, paid_at=? WHERE id=?', ['paid', stamp, invoiceId]],
    [`UPDATE subscription_payments SET status='confirmed', confirmed_by=?, confirmed_at=?
      WHERE invoice_id=? AND status='pending'`, [confirmedBy, stamp, invoiceId]]
  ];

  const sub = await app.db.get('SELECT * FROM subscriptions WHERE tenant_id=?', inv.tenant_id);
  if (sub && ['past_due', 'trialing'].includes(sub.status)) {
    ops.push([`UPDATE subscriptions SET status='active', grace_until=NULL, updated_at=? WHERE id=?`, [stamp, sub.id]]);
  }
  await app.db.batch(ops);
  return app.db.get('SELECT * FROM subscription_invoices WHERE id=?', invoiceId);
}

/** رصيد الجهة غير المسدّد */
export async function outstandingBalance(app, tenantId) {
  const r = await app.db.get(
    `SELECT COALESCE(SUM(total),0) AS due, COUNT(*) AS n
     FROM subscription_invoices WHERE tenant_id=? AND status='open'`, tenantId);
  return { due: r?.due || 0, invoices: r?.n || 0 };
}
