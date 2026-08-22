import api from '../api.js';
import { state, can } from '../state.js';
import {
  el, clear, card, chip, stat, table, toast, modal, field, input, select, textarea,
  AR_NUM, money, progressBar, empty, skeleton, confirmDialog, mount
} from '../util.js';
import { fmtDate, fmtDateTime } from '../hijri.js';

/**
 * شاشة الاشتراك والفوترة الخاصة بالجهة (المرحلة الثانية).
 * تُظهر الخطة والاستهلاك مقابل حدودها، وتتيح الترقية والسداد وطباعة الفواتير.
 */
const STATUS_KIND = { active: 'ok', trialing: 'info', past_due: 'warn', canceled: '', expired: 'danger' };
const INV_KIND = { paid: 'ok', open: 'warn', void: '', uncollectible: 'danger' };

const gb = (mb) => (mb === null || mb === undefined ? 'بلا حدود'
  : mb >= 1024 ? `${AR_NUM(Math.round(mb / 1024 * 10) / 10)} جيجابايت` : `${AR_NUM(mb)} ميجابايت`);

function usageRow(label, u, unit) {
  const limitText = u.limit === null || u.limit === undefined ? 'بلا حدود'
    : (unit === 'mb' ? gb(u.limit) : AR_NUM(u.limit));
  const usedText = unit === 'mb' ? gb(u.used) : AR_NUM(u.used);
  const kind = u.percent === null ? '' : (u.percent >= 100 ? 'danger' : u.percent >= 80 ? 'warn' : 'ok');
  return el('div.usage-row', {}, [
    el('div.row', { style: { justifyContent: 'space-between' } }, [
      el('b', { text: label }),
      el('span.hint', { text: `${usedText} من ${limitText}` })
    ]),
    progressBar(u.percent ?? 0, kind)
  ]);
}

export async function render({ navigate }) {
  const root = el('div.stack');
  clear(root).append(skeleton(6));

  const load = async () => {
    const [data, plansData, invoicesData] = await Promise.all([
      api.get('/api/billing'),
      api.get('/api/billing/plans'),
      api.get('/api/billing/invoices')
    ]);
    const sub = data.subscription;
    const manage = can('billing.manage');

    /* ── حالة الاشتراك ── */
    const header = card('اشتراك الجهة', el('div.stack', {}, [
      sub ? el('div.row.wrap', { style: { gap: '10px', alignItems: 'center' } }, [
        el('h3', { text: sub.plan?.name || 'بلا خطة', style: { margin: 0 } }),
        chip(sub.status_label, STATUS_KIND[sub.status] || ''),
        sub.cancel_at_period_end ? chip('التجديد موقوف', 'warn') : null,
        sub.price ? chip(`${money(sub.price)} ${data.currency} / ${sub.cycle === 'yearly' ? 'سنة' : 'شهر'}`) : chip('مجانية', 'ok')
      ]) : el('p', { text: 'لا يوجد اشتراك مرتبط بهذه الجهة.' }),

      sub?.block_reason ? el('div.alert.danger', { text: sub.block_reason }) : null,
      sub?.status === 'trialing' && sub.trial_ends_at
        ? el('div.alert.info', { text: `الفترة التجريبية تنتهي في ${fmtDate(sub.trial_ends_at, state.calendar)}` }) : null,
      sub?.status === 'past_due'
        ? el('div.alert.warn', { text: `فاتورة مستحقة — مهلة السداد حتى ${sub.grace_until ? fmtDate(sub.grace_until, state.calendar) : 'إشعار آخر'}` }) : null,

      sub ? el('div.row.wrap', { style: { gap: '18px' } }, [
        el('div', {}, [el('span.hint', { text: 'الفترة الحالية' }),
          el('div', { text: `${fmtDate(sub.current_period_start, state.calendar)} — ${fmtDate(sub.current_period_end, state.calendar)}` })]),
        el('div', {}, [el('span.hint', { text: 'الرصيد المستحق' }),
          el('div', { text: `${money(data.balance.due)} ${data.currency}` })])
      ]) : null,

      manage && sub ? el('div.row.wrap', { style: { gap: '8px' } }, [
        el('button.btn.gold', { text: '⭑ تغيير الخطة', onclick: () => planPicker(plansData, data, refresh) }),
        sub.cancel_at_period_end
          ? el('button.btn.ghost', { text: '↻ استئناف التجديد', onclick: async () => {
              await api.post('/api/billing/resume', {}); toast('أُعيد تفعيل التجديد التلقائي', 'ok'); await refresh();
            } })
          : el('button.btn.ghost', { text: '⏸ إيقاف التجديد', onclick: async () => {
              if (!await confirmDialog('سيستمر اشتراكك حتى نهاية الفترة الحالية ثم يتوقف.', { confirmText: 'إيقاف التجديد', danger: true })) return;
              await api.post('/api/billing/cancel', {}); toast('أُوقف التجديد التلقائي', 'ok'); await refresh();
            } })
      ]) : null
    ]));

    /* ── الاستهلاك مقابل الحدود ── */
    const usage = card('الاستهلاك مقابل حدود الخطة', el('div.stack', {}, [
      usageRow('الفروع', data.usage.branches, 'n'),
      usageRow('المستخدمون النشطون', data.usage.users, 'n'),
      usageRow('مساحة التخزين', data.usage.storage_mb, 'mb'),
      el('p.hint', { text: 'عند بلوغ الحدّ يمنع النظام إضافة المزيد ويقترح ترقية الخطة — ولا يُحذف شيء من بياناتك.' })
    ]));

    /* ── الفواتير ── */
    const invoices = card('فواتير الاشتراك', invoicesData.items.length ? table([
      { header: 'الرقم', key: 'number', render: r => el('code', { text: r.number, style: { direction: 'ltr', fontSize: '11px' } }) },
      { header: 'الفترة', key: 'period', render: r => `${fmtDate(r.period_start, state.calendar)} — ${fmtDate(r.period_end, state.calendar)}` },
      { header: 'الإجمالي', key: 'total', num: true, render: r => `${money(r.total)} ${r.currency}` },
      { header: 'الحالة', key: 'status', render: r => chip(r.status_label, INV_KIND[r.status] || '') },
      { header: 'الاستحقاق', key: 'due_at', render: r => (r.due_at ? fmtDate(r.due_at, state.calendar) : '—') },
      { header: '', key: 'a', render: r => el('div.row', { style: { gap: '4px' } }, [
        el('button.btn.sm.ghost', { text: '🖨 طباعة', onclick: () => api.openPrintGet(`/api/billing/invoices/${r.id}/print`) }),
        r.status === 'open' && can('billing.manage')
          ? (data.gateway?.redirects
              ? el('button.btn.sm', { text: '💳 ادفع الآن', onclick: async (e) => {
                  e.target.disabled = true;
                  try {
                    const out = await api.post(`/api/billing/invoices/${r.id}/pay`, {});
                    if (out.redirect_url) location.href = out.redirect_url;
                    else { toast(out.message || 'بدأت عملية الدفع', 'ok'); await refresh(); }
                  } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
                } })
              : el('button.btn.sm', { text: '💳 إبلاغ بالسداد', onclick: () => payDialog(r, data, refresh) }))
          : null,
        r.zatca_qr ? el('button.btn.sm.ghost', { text: '⬛ فاتورة إلكترونية',
          onclick: () => eInvoiceDialog(r) }) : null
      ]) }
    ], invoicesData.items) : empty('🧾', 'لا توجد فواتير بعد', 'ستظهر هنا فواتير الاشتراك عند إصدارها.'),
    { sub: `الرصيد المستحق: ${money(invoicesData.balance.due)} ${data.currency}` });

    /* ── بيانات التحويل ── */
    const bank = data.bank_details && Object.keys(data.bank_details).length
      ? card('بيانات السداد', el('div.kv', {}, [
          ...Object.entries({
            'البنك': data.bank_details.bank, 'المستفيد': data.bank_details.beneficiary,
            'الآيبان': data.bank_details.iban, 'ملاحظة': data.bank_details.note
          }).filter(([, v]) => v).flatMap(([k, v]) => [
            el('span.k', { text: k }),
            el('span.v', { text: v, style: /IBAN|iban|SA/.test(v) ? { direction: 'ltr', textAlign: 'right' } : {} })
          ])
        ]))
      : null;

    /* ── الكوبون ── */
    const couponInput = input({ placeholder: 'أدخل رمز الكوبون', dir: 'ltr', style: { textTransform: 'uppercase' } });
    const couponCard = manage ? card('كوبون خصم', el('div.stack', {}, [
      data.coupon
        ? el('div.row', { style: { gap: '10px' } }, [
            chip(`${data.coupon.code} — ${data.coupon.type === 'percent' ? AR_NUM(data.coupon.value) + '٪' : money(data.coupon.value)}`, 'ok'),
            data.coupon.until ? el('span.hint', { text: `ساري حتى ${fmtDate(data.coupon.until, state.calendar)}` }) : null,
            el('button.btn.sm.ghost', { text: 'إزالة', onclick: async () => {
              await api.del('/api/billing/coupon'); toast('أُزيل الكوبون', 'ok'); await refresh(); } })
          ])
        : el('div.row', { style: { gap: '8px' } }, [
            el('div', { style: { flex: 1 } }, [couponInput]),
            el('button.btn', { text: 'تفعيل', onclick: async (e) => {
              if (!couponInput.value.trim()) return;
              e.target.disabled = true;
              try {
                const r = await api.post('/api/billing/coupon', { code: couponInput.value.trim() });
                toast(`فُعّل كوبون «${r.code}» — خصم ${money(r.discount_preview)}`, 'ok');
                await refresh();
              } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
            } })
          ]),
      el('p.hint', { text: 'يُخصم الكوبون من فاتورتك القادمة قبل احتساب الضريبة.' })
    ])) : null;

    /* ── الرصيد المُرحَّل ── */
    const creditCard = data.credit_balance > 0 ? el('div.alert.ok', {
      text: `لديك رصيد ${money(data.credit_balance)} ${data.currency} سيُخصم تلقائياً من فاتورتك القادمة.` }) : null;

    /* ── ما تشمله خطتك ── */
    const featuresCard = data.features ? card('ما تشمله خطتك', el('div.grid-2', {},
      data.features.map(f => el('div.row', { style: { gap: '6px' } }, [
        el('span', { text: f.enabled ? '✓' : '✕', style: { color: `var(--${f.enabled ? 'ok' : 'text-3'})`, fontWeight: '700' } }),
        el('span', { text: f.label, style: f.enabled ? {} : { color: 'var(--text-3)' } })
      ])))) : null;

    /* ── بيانات الفوترة وأمر الشراء ── */
    const be = data.billing_entity || {};
    const beFields = {
      name: input({ value: be.name || '', placeholder: 'الاسم النظامي للجهة' }),
      vat: input({ value: be.vat_number || '', dir: 'ltr', placeholder: '١٥ رقماً', maxlength: 15 }),
      cr: input({ value: be.cr_number || '', dir: 'ltr' }),
      po: input({ value: be.po_number || '', dir: 'ltr', placeholder: 'PO-2026-001' }),
      city: input({ value: be.address?.city || '' }),
      street: input({ value: be.address?.street || '' })
    };
    const beCard = manage ? card('بيانات الفوترة وأمر الشراء', el('div.stack', {}, [
      el('p.hint', { text: 'تُثبَّت هذه البيانات على الفاتورة وقت إصدارها. الرقم الضريبي إلزامي للفاتورة الضريبية بين المنشآت.' }),
      field('اسم الجهة النظامي', beFields.name),
      el('div.grid-2', {}, [field('الرقم الضريبي', beFields.vat), field('السجل التجاري', beFields.cr)]),
      field('رقم أمر الشراء (للجهات الحكومية)', beFields.po),
      el('div.grid-2', {}, [field('المدينة', beFields.city), field('الشارع', beFields.street)]),
      el('button.btn.sm', { text: '💾 حفظ', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.put('/api/billing/billing-entity', {
            name: beFields.name.value.trim(), vat_number: beFields.vat.value.trim(),
            cr_number: beFields.cr.value.trim(), po_number: beFields.po.value.trim(),
            address: { city: beFields.city.value.trim(), street: beFields.street.value.trim() }
          });
          toast('حُفظت بيانات الفوترة', 'ok');
        } catch (err) { toast(err.message, 'warn'); }
        finally { e.target.disabled = false; }
      } })
    ])) : null;

    clear(root).append(header, creditCard, usage, featuresCard, invoices,
      ...(couponCard ? [couponCard] : []), ...(beCard ? [beCard] : []), ...(bank ? [bank] : []),
      el('p.hint', { text: `للاستفسار: ${data.support_email || '—'}` }));
  };

  const refresh = async () => { clear(root).append(skeleton(6)); await load(); };
  await load();
  return root;
}

/* ═════════ اختيار الخطة ═════════ */
function planPicker(plansData, data, refresh) {
  let cycle = 'monthly';
  const grid = el('div.plan-grid.compact');

  const draw = () => grid.replaceChildren(...plansData.plans.map(p => {
    const price = cycle === 'yearly' ? p.price_yearly : p.price_monthly;
    const current = p.code === plansData.current;
    return el('article.plan-card' + (p.highlight ? '.featured' : '') + (current ? '.current' : ''), {}, [
      current ? el('div.plan-tag', { text: 'خطتك الحالية' }) : (p.highlight ? el('div.plan-tag', { text: 'الأكثر اختياراً' }) : null),
      el('h3', { text: p.name }),
      el('div.plan-price', {}, [
        el('b', { text: price ? `${money(price)} ${p.currency}` : 'مجاناً' }),
        price ? el('span', { text: cycle === 'yearly' ? '/ سنة' : '/ شهر' }) : null
      ]),
      el('ul.plan-perks', {}, [
        el('li', { text: `الفروع: ${p.limits.branches === null ? 'بلا حدود' : AR_NUM(p.limits.branches)}` }),
        el('li', { text: `المستخدمون: ${p.limits.users === null ? 'بلا حدود' : AR_NUM(p.limits.users)}` }),
        el('li', { text: `التخزين: ${p.limits.storage_mb === null ? 'بلا حدود' : (p.limits.storage_mb >= 1024 ? AR_NUM(Math.round(p.limits.storage_mb / 1024)) + ' جيجابايت' : AR_NUM(p.limits.storage_mb) + ' ميجابايت')}` }),
        ...p.perks.slice(0, 4).map(t => el('li', { text: t }))
      ]),
      !p.selectable
        ? el('div.hint', { style: { color: 'var(--danger)' },
            text: 'استهلاك الجهة الحالي يتجاوز حدود هذه الخطة' })
        : el('button.btn.block' + (current ? '.ghost' : '.gold'), {
            text: current ? 'الخطة الحالية' : 'اختيار هذه الخطة',
            disabled: current,
            onclick: async () => {
              const label = cycle === 'yearly' ? 'سنوي' : 'شهري';
              if (!await confirmDialog(
                `سيتم تحويل اشتراك الجهة إلى خطة «${p.name}» (${label})${price ? ` وإصدار فاتورة بمبلغ ${money(price)} ${p.currency} + الضريبة` : ''}.`,
                { confirmText: 'تأكيد التغيير' })) return;
              try {
                const r = await api.post('/api/billing/subscribe', { plan_code: p.code, cycle });
                m.close(); await refresh();
                /* التناسب يستحق شرحاً صريحاً: الجهة دفعت ولها رصيد، فلا نتركها تخمّن */
                if (r.proration?.credit > 0) prorationDialog(r);
                else toast(r.invoice ? `تم التغيير وصدرت الفاتورة ${r.invoice.number}` : 'تم تغيير الخطة', 'ok');
              } catch (e) { toast(e.message, 'warn'); }
            }
          })
    ]);
  }));

  const toggle = el('div.cycle-toggle', {}, [
    el('button.btn.sm.active', { text: 'شهري', onclick: (e) => { cycle = 'monthly'; mark(e); draw(); } }),
    el('button.btn.sm.ghost', { text: 'سنوي', onclick: (e) => { cycle = 'yearly'; mark(e); draw(); } })
  ]);
  const mark = (e) => { for (const b of toggle.children) { b.classList.remove('active'); b.classList.add('ghost'); }
    e.currentTarget.classList.add('active'); e.currentTarget.classList.remove('ghost'); };

  draw();
  const m = modal({ title: 'خطط الاشتراك', size: 'lg', body: el('div.stack', {}, [toggle, grid]) });
  return m;
}

/* ═════════ إشعار سداد ═════════ */
function payDialog(inv, data, refresh) {
  const amount = input({ type: 'number', step: '0.01', value: inv.total, dir: 'ltr' });
  const method = select([
    { value: 'bank_transfer', label: 'تحويل بنكي' },
    { value: 'cash', label: 'نقداً' },
    { value: 'manual', label: 'وسيلة أخرى' }
  ]);
  const reference = input({ placeholder: 'رقم العملية / المرجع', dir: 'ltr' });
  const note = textarea({ rows: 2, placeholder: 'ملاحظة اختيارية' });

  const m = modal({
    title: `إبلاغ بسداد الفاتورة ${inv.number}`,
    body: el('div.stack', {}, [
      data.bank_details?.iban ? el('div.alert.info', {}, [
        el('div', { text: `${data.bank_details.bank || ''} — ${data.bank_details.beneficiary || ''}` }),
        el('code', { text: data.bank_details.iban, style: { direction: 'ltr' } })
      ]) : null,
      field('المبلغ المحوَّل', amount, { required: true }),
      field('وسيلة السداد', method),
      field('رقم العملية', reference),
      field('ملاحظة', note),
      el('p.hint', { text: 'يُراجع الإشعار من إدارة المنصة، وتتحوّل الفاتورة إلى «مسددة» بعد التحقق.' })
    ]),
    footer: el('button.btn.gold', { text: 'إرسال الإشعار', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.post(`/api/billing/invoices/${inv.id}/declare-payment`, {
          amount: Number(amount.value), method: method.value,
          reference: reference.value.trim() || null, note: note.value.trim() || null
        });
        toast(r.message, 'ok'); m.close(); await refresh();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
  return m;
}

/* ═════════ عرض الفاتورة الإلكترونية ورمز QR ═════════ */

/** رسم رمز QR بلا مكتبات: نستخدم خدمة العرض المدمجة في المتصفح عبر canvas بسيط
 *  — وبما أن الشبكة الخارجية محجوبة، نعرض السلسلة المُرمَّزة نصّاً قابلاً للنسخ
 *  إضافةً إلى حقولها المفكوكة، وهو ما يحتاجه المدقّق فعلياً. */
/**
 * شرح التناسب بعد تغيير الخطة: كم بقي من الفترة المدفوعة، وكم رُحِّل رصيداً،
 * وكيف انعكس على فاتورة الفترة الجديدة.
 */
function prorationDialog(r) {
  const p = r.proration;
  const inv = r.invoice;
  const m = modal({
    title: 'رُحِّل رصيد الفترة غير المستهلكة',
    body: el('div.stack', {}, [
      el('div.alert.ok', { text: 'الجزء الذي دفعتِه ولم تستهلكيه من خطتك السابقة لم يضِع — أُضيف رصيداً لحسابك.' }),
      el('div.kv', {}, [
        el('span.k', { text: 'الخطة السابقة' }),
        el('span.v', { text: `${p.from_plan_name || p.from_plan} · ${p.from_cycle === 'yearly' ? 'سنوي' : 'شهري'}` }),
        el('span.k', { text: 'الأيام المتبقية من فترتها' }),
        el('span.v', { text: `${AR_NUM(p.unusedDays)} من ${AR_NUM(p.totalDays)} يوماً` }),
        el('span.k', { text: 'المدفوع فعلاً عن الفترة' }),
        el('span.v', { text: money(p.paid_for_period) }),
        el('span.k', { text: 'الرصيد المُرحَّل' }),
        el('span.v', {}, [el('b', { text: money(p.credit) })])
      ]),
      inv ? card('فاتورة الفترة الجديدة', el('div.kv', {}, [
        el('span.k', { text: 'رقمها' }),
        el('span.v', { text: inv.number, style: { direction: 'ltr' } }),
        el('span.k', { text: 'قبل الرصيد' }),
        el('span.v', { text: money(Number(inv.subtotal) + Number(inv.credit_applied || 0)) }),
        el('span.k', { text: 'خُصم من الرصيد' }),
        el('span.v', { text: `− ${money(inv.credit_applied || 0)}` }),
        el('span.k', { text: 'الضريبة' }),
        el('span.v', { text: money(inv.vat_amount) }),
        el('span.k', { text: 'المستحق الآن' }),
        el('span.v', {}, [el('b', { text: money(inv.total) })])
      ])) : el('div.hint', { text: 'الرصيد غطّى الفترة الجديدة بالكامل — لا فاتورة مستحقة.' }),
      el('div.hint', { text: 'الرصيد يُطبَّق قبل احتساب الضريبة، ويُخصم تلقائياً من كل فاتورة تالية حتى ينفد.' })
    ]),
    footer: el('button.btn.gold', { text: 'فهمت', onclick: () => m.close() })
  });
}

async function eInvoiceDialog(invoiceRow) {
  const d = await api.get(`/api/billing/invoices/${invoiceRow.id}/einvoice`);
  const LABELS = { 1: 'اسم البائع', 2: 'الرقم الضريبي', 3: 'تاريخ ووقت الإصدار',
    4: 'الإجمالي شامل الضريبة', 5: 'قيمة الضريبة', 6: 'تجزئة المستند', 7: 'التوقيع', 8: 'المفتاح العام' };

  modal({
    title: `الفاتورة الإلكترونية — ${d.number}`, size: 'lg',
    body: el('div.stack', {}, [
      el('div.kv', {}, Object.entries(d.fields).flatMap(([tag, v]) => [
        el('span.k', { text: LABELS[tag] || `الوسم ${tag}` }),
        el('span.v', { text: v, style: Number(tag) >= 6 ? { direction: 'ltr', fontSize: '11px', wordBreak: 'break-all' } : {} })
      ])),
      card('رمز QR (TLV بترميز Base64)', el('div.stack', {}, [
        el('code', { text: d.qr, style: { direction: 'ltr', fontSize: '10.5px', wordBreak: 'break-all', lineHeight: '1.8' } }),
        el('button.btn.sm.ghost', { text: '📋 نسخ', onclick: async () => {
          try { await navigator.clipboard.writeText(d.qr); toast('نُسخ رمز QR', 'ok'); }
          catch { toast('تعذّر النسخ — حدّد النص يدوياً', 'warn'); }
        } })
      ])),
      el('div.kv', {}, [
        el('span.k', { text: 'المعرّف الفريد' }),
        el('span.v', { text: d.uuid, style: { direction: 'ltr', fontSize: '11px' } }),
        el('span.k', { text: 'تجزئة الفاتورة' }),
        el('span.v', { text: d.hash, style: { direction: 'ltr', fontSize: '11px', wordBreak: 'break-all' } })
      ]),
      d.xml_available ? el('button.btn.ghost', { text: '⬇ تنزيل مستند XML',
        onclick: () => api.downloadGet(`/api/billing/invoices/${invoiceRow.id}/xml`, `${d.number}.xml`) }) : null,
      el('p.hint', { text: 'المستند بمعيار UBL 2.1 وسلسلة التجزئة مترابطة. الختم التشفيري يُضاف بعد استخراج شهادة CSID من هيئة الزكاة والضريبة والجمارك.' })
    ])
  });
}
