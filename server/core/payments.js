import { nowUTC, j } from './sql.js';
import { badRequest } from './errors.js';
import { platformSettings, settleInvoice } from './billing.js';

/**
 * بوابات الدفع (المستوى ٤) — واجهة واحدة ومزوّدون قابلون للتبديل.
 *
 * الافتراضي «يدوي»: تحويل بنكي يعتمده مالك المنصة، وهو الأشيع في السوق المحلي.
 * ومزوّد مدى/الشبكات السعودية (Moyasar) مبنيّ على الواجهة نفسها: يُنشئ عملية دفع
 * ويعيد رابط تحويل، ثم يستقبل إشعار البوابة (Webhook) فيعتمد الفاتورة تلقائياً.
 *
 * لا يُخزَّن أي بيان بطاقة في المنصة إطلاقاً — الدفع يقع في صفحة البوابة،
 * ولا يعود منها إلا معرّف العملية وحالتها.
 */

export const GATEWAYS = {
  manual: { key: 'manual', label: 'تحويل بنكي يدوي', needsKeys: false, redirects: false },
  moyasar: { key: 'moyasar', label: 'ميسر (مدى · فيزا · Apple Pay)', needsKeys: true, redirects: true },
  tap: { key: 'tap', label: 'تاب (Tap Payments)', needsKeys: true, redirects: true }
};

const halalas = (amount) => Math.round(Number(amount || 0) * 100);

/* ─────────────────────────── المزوّد اليدوي ─────────────────────────── */

const manual = {
  key: 'manual',
  async createPayment(app, { invoice }) {
    const s = await platformSettings(app);
    return {
      gateway: 'manual',
      status: 'pending',
      redirect_url: null,
      instructions: s.bank_details,
      message: 'حوّل المبلغ إلى الحساب الموضّح ثم أبلغ عن السداد ليعتمده فريق المنصة'
    };
  },
  async verify() { return { status: 'pending' }; }
};

/* ─────────────────────────── ميسر (Moyasar) ─────────────────────────── */

const moyasar = {
  key: 'moyasar',
  async createPayment(app, { invoice, config, callbackUrl }) {
    if (!config?.secret_key) throw badRequest('لم تُضبط مفاتيح بوابة ميسر');
    const res = await fetch('https://api.moyasar.com/v1/invoices', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + btoa(`${config.secret_key}:`)
      },
      body: JSON.stringify({
        amount: halalas(invoice.total),
        currency: invoice.currency || 'SAR',
        description: `${invoice.number} — اشتراك ${invoice.plan_name}`,
        callback_url: callbackUrl,
        metadata: { invoice_id: String(invoice.id), tenant_id: String(invoice.tenant_id) }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw badRequest(`تعذّر إنشاء عملية الدفع: ${data.message || res.status}`);
    return {
      gateway: 'moyasar',
      status: 'pending',
      gateway_ref: data.id,
      redirect_url: data.url,
      message: 'أكمل الدفع في صفحة البوابة'
    };
  },
  async verify(app, { ref, config }) {
    const res = await fetch(`https://api.moyasar.com/v1/invoices/${encodeURIComponent(ref)}`, {
      headers: { authorization: 'Basic ' + btoa(`${config.secret_key}:`) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'unknown' };
    return { status: data.status === 'paid' ? 'paid' : (data.status || 'pending'), raw: data };
  }
};

/* ─────────────────────────── تاب (Tap) ─────────────────────────── */

const tap = {
  key: 'tap',
  async createPayment(app, { invoice, config, callbackUrl }) {
    if (!config?.secret_key) throw badRequest('لم تُضبط مفاتيح بوابة تاب');
    const res = await fetch('https://api.tap.company/v2/charges', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret_key}` },
      body: JSON.stringify({
        amount: Number(invoice.total),
        currency: invoice.currency || 'SAR',
        description: `${invoice.number} — اشتراك ${invoice.plan_name}`,
        reference: { transaction: invoice.number, order: String(invoice.id) },
        redirect: { url: callbackUrl },
        source: { id: 'src_all' },
        metadata: { invoice_id: String(invoice.id), tenant_id: String(invoice.tenant_id) }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw badRequest(`تعذّر إنشاء عملية الدفع: ${data?.errors?.[0]?.description || res.status}`);
    return {
      gateway: 'tap', status: 'pending', gateway_ref: data.id,
      redirect_url: data?.transaction?.url, message: 'أكمل الدفع في صفحة البوابة'
    };
  },
  async verify(app, { ref, config }) {
    const res = await fetch(`https://api.tap.company/v2/charges/${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${config.secret_key}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'unknown' };
    return { status: data.status === 'CAPTURED' ? 'paid' : String(data.status || 'pending').toLowerCase(), raw: data };
  }
};

const PROVIDERS = { manual, moyasar, tap };

export async function activeGateway(app) {
  const s = await platformSettings(app);
  const key = PROVIDERS[s.payment_gateway] ? s.payment_gateway : 'manual';
  return { key, provider: PROVIDERS[key], config: j(s.gateway_config, {}) || {}, settings: s };
}

/**
 * يبدأ عملية دفع لفاتورة ويُسجّلها معلّقة.
 * @returns تعليمات الدفع أو رابط التحويل إلى البوابة
 */
export async function startPayment(app, invoice, { userId = null, callbackUrl = null } = {}) {
  if (invoice.status === 'paid') throw badRequest('الفاتورة مسددة مسبقاً');
  if (invoice.status === 'void') throw badRequest('الفاتورة ملغاة');

  const { key, provider, config } = await activeGateway(app);
  const out = await provider.createPayment(app, { invoice, config, callbackUrl });

  const r = await app.db.run(
    `INSERT INTO subscription_payments(tenant_id,invoice_id,amount,currency,method,status,
       gateway,gateway_ref,gateway_status,declared_by,note)
     VALUES(?,?,?,?,?,'pending',?,?,?,?,?)`,
    invoice.tenant_id, invoice.id, invoice.total, invoice.currency,
    key === 'manual' ? 'bank_transfer' : 'card',
    key, out.gateway_ref || null, out.status || 'pending', userId,
    `عملية دفع عبر ${GATEWAYS[key]?.label || key}`);

  return { ...out, payment_id: r.lastId, invoice_number: invoice.number, amount: invoice.total };
}

/**
 * يتحقّق من حالة عملية لدى البوابة ويعتمد الفاتورة عند نجاح الدفع.
 * يُستدعى من صفحة العودة ومن إشعار البوابة معاً — والاعتماد لا يقع مرتين.
 */
export async function reconcilePayment(app, paymentId) {
  const pay = await app.db.get('SELECT * FROM subscription_payments WHERE id=?', paymentId);
  if (!pay) throw badRequest('عملية الدفع غير موجودة');
  if (pay.status === 'confirmed') return { status: 'confirmed', already: true };

  const { provider, config } = await activeGateway(app);
  if (!pay.gateway_ref || pay.gateway === 'manual') {
    return { status: pay.status, manual: true };
  }

  const res = await provider.verify(app, { ref: pay.gateway_ref, config });
  await app.db.run('UPDATE subscription_payments SET gateway_status=? WHERE id=?', res.status, pay.id);

  if (res.status === 'paid') {
    const invoice = await settleInvoice(app, pay.invoice_id, { confirmedBy: null });
    await app.db.run(
      `UPDATE subscription_payments SET status='confirmed', confirmed_at=? WHERE id=?`, nowUTC(), pay.id);
    return { status: 'confirmed', invoice };
  }
  return { status: res.status };
}

/** إشعار البوابة (Webhook) — يبحث عن العملية بمعرّفها لدى البوابة */
export async function handleWebhook(app, { gatewayRef, status }) {
  const pay = await app.db.get('SELECT * FROM subscription_payments WHERE gateway_ref=?', gatewayRef);
  if (!pay) return { matched: false };
  if (status && status !== 'paid') {
    await app.db.run('UPDATE subscription_payments SET gateway_status=? WHERE id=?', status, pay.id);
    return { matched: true, status };
  }
  return { matched: true, ...(await reconcilePayment(app, pay.id)) };
}
