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
          ? el('button.btn.sm', { text: '💳 إبلاغ بالسداد', onclick: () => payDialog(r, data, refresh) }) : null
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

    clear(root).append(header, usage, invoices, ...(bank ? [bank] : []),
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
                toast(r.invoice ? `تم التغيير وصدرت الفاتورة ${r.invoice.number}` : 'تم تغيير الخطة', 'ok');
                m.close(); await refresh();
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
