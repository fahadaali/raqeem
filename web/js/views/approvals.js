import api from '../api.js';
import {
  el, clear, mount, card, chip, empty, toast, modal, textarea,
  AR_NUM, money, skeleton
} from '../util.js';
import { fmtDate } from '../hijri.js';
import { state } from '../state.js';

/**
 * صندوق الاعتمادات الموحّد.
 *
 * ما ينتظر قرار المستخدم كان موزّعاً على تبويب داخل «النظام المالي» وآخر داخل
 * «الموارد البشرية»، فمن يعتمد الاثنين يفتح شاشتين ليعرف هل ينتظره شيء أصلاً.
 * هنا صفٌّ واحد لكل ما ينتظره، والقرار في السطر نفسه — لا تُفتح نافذة إلا حين
 * يُراد التفصيل أو تُكتب ملاحظة رفض.
 *
 * ولا يقرّر هذا الملف من يعتمد ماذا: الخادم يرسل ما يملك المستخدم اعتماده وحده.
 */

const KIND = {
  finance: { label: 'طلب مالي', cls: 'info', icon: 'banknote' },
  leave:   { label: 'إجازة',    cls: 'ok',   icon: 'tree-palm' }
};

/** مدّة الإجازة بتقويم المستخدم لا بتاريخٍ خام من قاعدة البيانات */
const titleOf = (it) => (it.kind === 'leave' && it.start_date)
  ? `${it.title} — ${fmtDate(it.start_date, state.calendar, 'short')} إلى ${fmtDate(it.end_date, state.calendar, 'short')}`
  : it.title;

/** «منذ يومين» لا «منذ ٢ أيام» — العربية تُفرد وتُثنّي قبل أن تجمع */
function ageOf(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'منذ يوم';
  if (days === 2) return 'منذ يومين';
  if (days <= 10) return `منذ ${AR_NUM(days)} أيام`;
  return `منذ ${AR_NUM(days)} يوماً`;
}

export async function render({ navigate }) {
  const wrap = el('div.stack');
  const body = el('div');

  const load = async () => {
    clear(body).append(skeleton(5));
    const d = await api.get('/api/approvals');
    paint(d);
  };

  const decide = async (item, approve) => {
    let note = '';
    if (!approve) {
      note = await askNote();
      if (note === null) return;   /* أُلغي */
    }
    try {
      if (item.kind === 'finance') {
        await api.post(`/api/finance/requests/${item.id}/decide`,
          { action: approve ? 'approve' : 'reject', note });
      } else {
        /* مسار الإجازات يقرأ `action` كما يقرؤه المسار المالي — لا `status` */
        await api.post(`/api/hr/leaves/${item.id}/decide`,
          { action: approve ? 'approve' : 'reject', note });
      }
      toast(approve ? 'اعتُمد الطلب وأُشعِر مُقدّمه' : 'رُفض الطلب وأُشعِر مُقدّمه',
        approve ? 'ok' : 'info');
      await load();
    } catch (e) {
      toast(e.message || 'تعذّر تنفيذ القرار', 'err');
    }
  };

  const row = (it) => {
    const k = KIND[it.kind] || KIND.finance;
    const days = Math.floor((Date.now() - new Date(it.created_at).getTime()) / 86400000);
    return el('div.approval-row', {}, [
      el('span.ic', { icon: k.icon, iconSize: 18 }),
      el('div.tx', {}, [
        el('b', { text: it.ref ? `${it.ref} — ${it.title}` : titleOf(it) }),
        el('span', { text: [it.requester, it.branch, it.step].filter(Boolean).join(' · ') })
      ]),
      chip(k.label, k.cls),
      /* ما تجاوز ثلاثة أيام يُصبَغ: التأخير حالةٌ لا تفصيل */
      chip(ageOf(it.created_at), days >= 3 ? 'danger' : ''),
      el('div.amount', { text: it.amount != null ? `${money(it.amount)} ر.س` : '—' }),
      el('div.row', { style: { gap: '7px', flex: '0 0 auto' } }, [
        el('button.btn.sm', { icon: 'check', iconSize: 16, text: 'اعتماد',
          onclick: () => decide(it, true) }),
        el('button.btn.sm.ghost', { icon: 'x', iconSize: 16, text: 'رفض',
          onclick: () => decide(it, false) }),
        el('button.btn.sm.ghost', { icon: 'arrow-left', iconSize: 16, title: 'فتح التفاصيل',
          'aria-label': 'فتح التفاصيل', onclick: () => navigate(it.url) })
      ])
    ]);
  };

  const paint = (d) => {
    const n = d.counts.total;
    mount(clear(body),
      el('div.approvals-head', {}, [
        el('div', {}, [
          el('h3', { text: 'ما ينتظر قرارك' }),
          el('p.hint', { text: 'مالية وإجازات في مكان واحد — لا شاشتين.' })
        ]),
        el('div', { style: { marginInlineStart: 'auto', textAlign: 'end' } }, [
          el('div.approvals-count', { text: AR_NUM(n) }),
          el('div.hint', { text: 'بانتظار قرارك' })
        ])
      ]),
      d.items.length
        ? card(null, el('div.approvals-list', {}, d.items.map(row)), { p0: true })
        : card(null, empty('inbox', 'صندوقك فارغ', 'لا شيء ينتظر قرارك الآن.'), { p0: true }),
      el('p.hint', { style: { textAlign: 'center' },
        text: 'كل قرار يُسجَّل في سجل التدقيق باسمك ووقته، ويُشعَر مُقدّم الطلب فوراً.' })
    );
  };

  wrap.append(body);
  await load();
  window.addEventListener('raqeem:poll', load, { once: true });
  return wrap;
}

/** ملاحظة الرفض إلزامية: من يُرَدّ طلبه يستحق أن يعرف لماذا */
function askNote() {
  return new Promise((resolve) => {
    const note = textarea({ placeholder: 'سبب الرفض — يظهر لمُقدّم الطلب' });
    let done = false;
    const m = modal({
      title: 'سبب الرفض', icon: 'x', size: 'narrow',
      body: note,
      footer: [
        el('button.btn.ghost', { text: 'إلغاء',
          onclick: () => { done = true; m.close(); resolve(null); } }),
        el('button.btn.danger', { text: 'تأكيد الرفض', onclick: () => {
          if (!note.value.trim()) return toast('اكتب سبب الرفض', 'warn');
          done = true; m.close(); resolve(note.value.trim());
        } })
      ],
      onClose: () => { if (!done) resolve(null); }
    });
    setTimeout(() => note.focus(), 60);
  });
}

/** عدّاد الصندوق — تقرؤه اللوحة والقائمة الجانبية دون إعادة جلب القائمة كاملة */
export async function approvalsCount() {
  try {
    const d = await api.get('/api/approvals', { silent: true });
    return d.counts.total;
  } catch { return 0; }
}
