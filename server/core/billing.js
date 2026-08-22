import { nowUTC, j } from './sql.js';
import { badRequest, quotaExceeded } from './errors.js';
import { stampZatca } from './zatca.js';
import { activeCoupon } from './coupons.js';

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
  platform_name: 'منصة رقيم',
  platform_name_en: 'Raqeem Platform',
  tagline: 'منصة الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم',
  support_email: 'support@raqeem.sa',
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
  invoice_prefix: 'RQM',
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
  return {
    ...row,
    bank_details: j(row.bank_details, {}) || {},
    seller_address: j(row.seller_address, {}) || {}
  };
}

/* ─────────────────────────── الخطط والحدود ─────────────────────────── */

export const planLimits = (plan) => ({
  branches: plan?.max_branches ?? null,
  users: plan?.max_users ?? null,
  storage_mb: plan?.max_storage_mb ?? null
});

/**
 * الحدود النافذة = حدود الخطة، معدَّلة بتجاوزات الجهة.
 * التجاوز {users: 250} يرفع الحدّ لجهة بعينها دون تغيير الخطة — للصفقات الخاصة.
 * القيمة null في التجاوز تعني «بلا حدّ لهذه الجهة».
 */
export function effectiveLimits(plan, tenant) {
  const base = planLimits(plan);
  const over = j(tenant?.limit_overrides, {}) || {};
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in over)) continue;
    const v = over[key];
    out[key] = (v === null || v === '' || v === 'unlimited') ? null : Number(v);
  }
  return out;
}

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

  const tenant = await app.db.get('SELECT limit_overrides FROM tenants WHERE id=?', tenantId);
  const limit = effectiveLimits(sub.plan, tenant)[resource];
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

/* ─────────────────────────── التناسب (Proration) ─────────────────────────── */

const DAY = 86400000;

/**
 * يحسب رصيد الجزء غير المستهلَك من الفترة الحالية عند تغيير الخطة في منتصفها.
 * بلا هذا الحساب يُحاسَب العميل مرتين على الأيام نفسها.
 *
 * الرصيد يُبنى على ما **دُفع فعلاً** عن الفترة الجارية لا على سعر الخطة المعلن،
 * وإلا لأمكن تكديس رصيد بتغيير الخطة ذهاباً وإياباً بلا سداد فاتورة واحدة.
 *
 * @param {number} paidForPeriod صافي ما سُدِّد عن الفترة الحالية (قبل الضريبة)
 */
export function prorationCredit(sub, plan, { paidForPeriod = 0, at = null } = {}) {
  const now = at ? new Date(at) : new Date();
  const start = new Date(sub.current_period_start);
  const end = new Date(sub.current_period_end);
  const totalDays = Math.max(1, Math.round((end - start) / DAY));
  const unusedDays = Math.max(0, Math.min(totalDays, Math.ceil((end - now) / DAY)));

  /* الفترة التجريبية أو فترة لم يُسدَّد عنها شيء: لا رصيد */
  const paid = Math.max(0, Number(paidForPeriod || 0));
  if (sub.status === 'trialing' || !plan || paid <= 0) {
    return { unusedDays, totalDays, credit: 0, dailyRate: 0, paid_for_period: paid };
  }
  const dailyRate = paid / totalDays;
  return {
    unusedDays, totalDays, paid_for_period: paid,
    dailyRate: Math.round(dailyRate * 10000) / 10000,
    credit: Math.round(dailyRate * unusedDays * 100) / 100
  };
}

/** صافي ما سُدِّد فعلاً عن الفترة الجارية لاشتراك (قبل الضريبة، بعد الإشعارات الدائنة) */
export async function paidForCurrentPeriod(app, sub) {
  const r = await app.db.get(
    `SELECT COALESCE(SUM(subtotal),0) AS paid FROM subscription_invoices
     WHERE subscription_id=? AND doc_type='invoice' AND status='paid'
       AND period_start=? AND period_end=?`,
    sub.id, sub.current_period_start, sub.current_period_end);
  const credited = await app.db.get(
    `SELECT COALESCE(SUM(n.subtotal),0) AS c FROM subscription_invoices n
     JOIN subscription_invoices i ON i.id = n.parent_id
     WHERE n.doc_type='credit_note' AND n.status<>'void'
       AND i.subscription_id=? AND i.period_start=?`,
    sub.id, sub.current_period_start);
  return Math.max(0, Math.round((Number(r?.paid || 0) - Number(credited?.c || 0)) * 100) / 100);
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

/**
 * يُصدر فاتورة اشتراك لفترة محددة.
 * يخصم الكوبون أولاً ثم الرصيد المُرحَّل من التناسب، ويحسب الضريبة على الصافي،
 * ويثبّت بيانات المشتري وأمر الشراء وقت الإصدار (لا تتغير بتغيير بيانات الجهة لاحقاً).
 */
export async function issueInvoice(app, tenantId, sub, {
  periodStart, periodEnd: pEnd, note = null, amount: forced = null, proration = null,
  coupon, applyCredit = true, poNumber = null
} = {}) {
  const plan = sub.plan || await app.db.get('SELECT * FROM plans WHERE id=?', sub.plan_id);
  const settings = await platformSettings(app);
  const tenant = await app.db.get('SELECT * FROM tenants WHERE id=?', tenantId);
  const billing = j(tenant?.billing_entity, {}) || {};

  const gross = forced !== null ? Number(forced) : planPrice(plan, sub.cycle);

  /*
   * ① الكوبون — يُستنبَط من الاشتراك متى لم يُمرَّر صراحةً، فيسري على
   * التجديدات الدورية والفواتير اليدوية لا على الاشتراك الأول وحده.
   * تمرير null صراحةً يعطّله (كما في الفواتير التسويّة).
   */
  const cp = coupon === undefined ? await activeCoupon(app, sub) : coupon;
  const discount = cp ? Math.min(gross, couponDiscount(cp, gross)) : 0;
  let net = Math.round((gross - discount) * 100) / 100;

  /* ② الرصيد المُرحَّل من تغيير خطة سابق */
  const balance = applyCredit ? Number(sub.credit_balance || 0) : 0;
  const creditApplied = Math.min(balance, net);
  net = Math.round((net - creditApplied) * 100) / 100;

  const { subtotal, vat_amount, total } = computeTotals(net, settings.vat_rate);
  const number = await nextInvoiceNumber(app);
  const issued = nowUTC();

  const r = await app.db.run(
    `INSERT INTO subscription_invoices(tenant_id,subscription_id,number,status,plan_code,plan_name,cycle,
      period_start,period_end,subtotal,discount,vat_rate,vat_amount,total,currency,issued_at,due_at,notes,
      doc_type,credit_applied,proration,coupon_code,po_number,buyer)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'invoice',?,?,?,?,?)`,
    tenantId, sub.id, number, total > 0 ? 'open' : 'paid',
    plan.code, plan.name, sub.cycle,
    periodStart || sub.current_period_start, pEnd || sub.current_period_end,
    subtotal, discount, settings.vat_rate, vat_amount, total, plan.currency || settings.currency,
    issued, addDays(issued, settings.grace_days), note,
    creditApplied, proration ? JSON.stringify(proration) : null,
    cp?.code || null, poNumber || billing.po_number || null,
    JSON.stringify({
      name: billing.name || tenant?.name, vat_number: billing.vat_number || null,
      cr_number: billing.cr_number || null, po_number: poNumber || billing.po_number || null,
      email: billing.email || null,
      address: billing.address || null, tenant_code: tenant?.code
    }));

  const ops = [];
  if (creditApplied > 0) {
    ops.push(['UPDATE subscriptions SET credit_balance = MAX(0, credit_balance - ?), updated_at=? WHERE id=?',
      [creditApplied, issued, sub.id]]);
  }
  if (cp && discount > 0) {
    ops.push(['UPDATE coupons SET redemptions = redemptions + 1 WHERE id=?', [cp.id]]);
    ops.push(['INSERT INTO coupon_redemptions(coupon_id,tenant_id,invoice_id,amount_off) VALUES(?,?,?,?)',
      [cp.id, tenantId, r.lastId, discount]]);
  }
  if (total === 0) ops.push(['UPDATE subscription_invoices SET paid_at=? WHERE id=?', [issued, r.lastId]]);
  if (ops.length) await app.db.batch(ops);

  const invoice = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', r.lastId);
  return stampZatca(app, invoice, settings);
}

/** خصم الكوبون على مبلغ معيّن */
export function couponDiscount(coupon, amount) {
  if (!coupon) return 0;
  const v = Number(coupon.value || 0);
  const off = coupon.type === 'percent' ? (Number(amount) * v) / 100 : v;
  return Math.max(0, Math.round(off * 100) / 100);
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

/* ─────────────────────────── الإشعارات الدائنة ─────────────────────────── */

/**
 * إشعار دائن على فاتورة (المستوى ٤).
 * الإلغاء وحده لا يكفي محاسبياً بعد إصدار الفاتورة للعميل — النظام يوجب
 * إصدار مستند دائن يشير إلى الفاتورة الأصلية ويحمل رقمه الخاص.
 * القيمة تُضاف إلى رصيد الجهة فتُخصم تلقائياً من فاتورتها التالية.
 */
export async function issueCreditNote(app, invoiceId, { amount = null, reason = '', createdBy = null } = {}) {
  const original = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', invoiceId);
  if (!original) throw badRequest('الفاتورة غير موجودة');
  if (original.doc_type === 'credit_note') throw badRequest('لا يُصدر إشعار دائن على إشعار دائن');

  const already = await app.db.get(
    `SELECT COALESCE(SUM(total),0) AS c FROM subscription_invoices
     WHERE parent_id=? AND doc_type='credit_note' AND status<>'void'`, invoiceId);
  const remaining = Math.round((Number(original.total) - Number(already.c || 0)) * 100) / 100;
  if (remaining <= 0) throw badRequest('صدرت إشعارات دائنة تغطي كامل الفاتورة');

  const gross = amount === null ? remaining : Math.min(remaining, Number(amount));
  if (!(gross > 0)) throw badRequest('قيمة الإشعار الدائن غير صالحة');

  /* المبلغ المُدخل شامل الضريبة — نستخرج منه الأصل والضريبة */
  const rate = Number(original.vat_rate || 0);
  const subtotal = Math.round((gross / (1 + rate / 100)) * 100) / 100;
  const vat = Math.round((gross - subtotal) * 100) / 100;

  const settings = await platformSettings(app);
  const number = await nextInvoiceNumber(app);
  const issued = nowUTC();

  const r = await app.db.run(
    `INSERT INTO subscription_invoices(tenant_id,subscription_id,number,status,plan_code,plan_name,cycle,
      period_start,period_end,subtotal,vat_rate,vat_amount,total,currency,issued_at,paid_at,notes,
      doc_type,parent_id,buyer)
     VALUES(?,?,?,'paid',?,?,?,?,?,?,?,?,?,?,?,?,?,'credit_note',?,?)`,
    original.tenant_id, original.subscription_id, number,
    original.plan_code, original.plan_name, original.cycle,
    original.period_start, original.period_end,
    subtotal, rate, vat, gross, original.currency, issued, issued,
    reason || `إشعار دائن على الفاتورة ${original.number}`,
    original.id, original.buyer || '{}');

  /*
   * فاتورة مسددة: القيمة تُرحَّل رصيداً يُخصم من الفاتورة التالية.
   * فاتورة غير مسددة: الإشعار يخفّض المستحق فقط — ولا يُمنح رصيد لم يُدفع أصلاً.
   */
  if (original.status === 'paid') {
    const sub = await app.db.get('SELECT * FROM subscriptions WHERE tenant_id=?', original.tenant_id);
    if (sub) {
      await app.db.run('UPDATE subscriptions SET credit_balance = credit_balance + ?, updated_at=? WHERE id=?',
        subtotal, issued, sub.id);
    }
  } else if (original.status === 'open') {
    const covered = await creditedAmount(app, original.id) + gross;
    if (covered >= Number(original.total) - 0.01) {
      await app.db.run(
        `UPDATE subscription_invoices SET status='void', void_reason=? WHERE id=?`,
        `أُلغيت بإشعار دائن ${number}`, original.id);
    }
  }

  const note = await app.db.get('SELECT * FROM subscription_invoices WHERE id=?', r.lastId);
  return stampZatca(app, note, settings);
}

/** إجمالي ما صدر من إشعارات دائنة على فاتورة */
export async function creditedAmount(app, invoiceId) {
  const r = await app.db.get(
    `SELECT COALESCE(SUM(total),0) AS c FROM subscription_invoices
     WHERE parent_id=? AND doc_type='credit_note' AND status<>'void'`, invoiceId);
  return Number(r?.c || 0);
}
