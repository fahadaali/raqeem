import api from '../api.js';
import { state, can } from '../state.js';
import {
  el, clear, mount, card, chip, empty, table, toast, drawer, modal, field, input, textarea, select,
  T, AR_NUM, avatar, timeAgo, skeleton, qs
} from '../util.js';
import { fmtDateTime } from '../hijri.js';
import { chatBox } from './tasks.js';

const CATEGORIES = [
  { value: 'technical', label: 'مشكلة تقنية' }, { value: 'attendance', label: 'الحضور والانصراف' },
  { value: 'permissions', label: 'الصلاحيات' }, { value: 'finance', label: 'مالية' },
  { value: 'hr', label: 'موارد بشرية' }, { value: 'performance', label: 'أداء المنصة' },
  { value: 'general', label: 'استفسار عام' }
];

/* حالات التذكرة لدى مزوّد المنصة كما يكتبها الخادم */
const VENDOR_STATE = {
  open:     { label: '⏳ بانتظار رد المزوّد', kind: 'warn' },
  answered: { label: '💬 ردّ المزوّد والتذكرة مفتوحة', kind: 'ok' },
  closed:   { label: '✅ عالجها المزوّد وأغلقها', kind: 'ok' }
};

export async function render({ route }) {
  const body = el('div');
  let filter = '';
  const load = async () => {
    clear(body).append(skeleton(5));
    const rows = await api.get('/api/comms/tickets' + api.qs({ status: filter }));
    const breached = rows.filter(r => r.sla_breached || r.escalated);
    mount(clear(body),
      breached.length && can('tickets.view_all') ? card('⚠️ تذاكر تجاوزت اتفاقية مستوى الخدمة',
        el('div.stack', { style: { gap: '7px' } }, breached.map(t => el('div.check-row', {
          style: { borderColor: 'var(--danger)' }, onclick: () => openTicket(t.id, load)
        }, [
          el('span', { text: '🔴' }),
          el('div.t', {}, [`${t.number} — ${t.subject}`, el('small', { text: `${t.requester_name} · ${timeAgo(t.created_at)}` })]),
          chip('مُصعّدة', 'danger')
        ])))) : null,
      card(null, table([
        { header: 'رقم التذكرة', key: 'number' },
        { header: 'الموضوع', key: 'subject' },
        { header: 'التصنيف', key: 'category', render: r => CATEGORIES.find(c => c.value === r.category)?.label || r.category },
        { header: 'الأهمية', key: 'priority', render: r => chip(T.priority[r.priority], T.priorityChip[r.priority]) },
        { header: 'مُقدّم الطلب', key: 'requester_name' },
        { header: 'المسؤول', key: 'assignee_name', render: r => r.assignee_name || chip('غير مُسندة', 'warn') },
        { header: 'الحالة', key: 'status', render: r => chip(T.ticket[r.status], r.escalated ? 'danger' : T.ticketChip[r.status]) },
        { header: 'الردود', key: 'replies_count', num: true, render: r => AR_NUM(r.replies_count) },
        { header: 'منذ', key: 'created_at', render: r => timeAgo(r.created_at) }
      ], rows, { onRow: (r) => openTicket(r.id, load), emptyText: 'لا توجد تذاكر' }), { p0: true })
    );
  };
  const statusSel = select([{ value: '', label: 'كل الحالات' }, ...Object.entries(T.ticket).map(([v, l]) => ({ value: v, label: l }))],
    { onchange: (e) => { filter = e.target.value; load(); } });
  await load();
  if (route.query.id) setTimeout(() => openTicket(Number(route.query.id), load), 120);

  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div.row', {}, [el('h3', { text: 'مركز الدعم الفني' }), statusSel]),
      can('tickets.create') ? el('button.btn.sm', { text: '＋ تذكرة جديدة', onclick: () => openForm(load) }) : null
    ])]),
    body
  ]);
}

async function openTicket(id, reload) {
  const t = await api.get(`/api/comms/tickets/${id}`).catch(() => null);
  if (!t) return toast('التذكرة غير موجودة', 'err');
  const isSupport = can('tickets.manage');
  const users = isSupport ? await api.get('/api/org/users').catch(() => []) : [];

  const replies = el('div.stack', { style: { gap: '9px' } }, t.replies.length ? t.replies.map(r =>
    el('div', { style: { background: r.is_internal ? 'var(--warn-bg)' : 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '11px', padding: '10px 13px' } }, [
      el('div.row.between', {}, [
        el('div.row', { style: { gap: '7px', flexWrap: 'nowrap' } }, [avatar(r.user_name, 'sm'), el('b', { text: r.user_name, style: { fontSize: '12.5px' } })]),
        el('span', { text: timeAgo(r.created_at), style: { fontSize: '10.5px', color: 'var(--text-3)' } })
      ]),
      r.is_internal ? chip('ملاحظة داخلية', 'warn') : null,
      el('p', { text: r.body, style: { margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' } })
    ])) : [el('div.hint', { text: 'لا توجد ردود بعد.' })]);

  const replyBox = textarea({ placeholder: 'اكتب ردك...' });
  const internal = el('input', { type: 'checkbox' });

  const body = el('div.stack', {}, [
    el('div', {}, [
      el('div.row.between', {}, [el('h3', { text: t.subject }), chip(T.ticket[t.status], t.escalated ? 'danger' : T.ticketChip[t.status])]),
      el('div.hint', { text: `${t.number} · ${fmtDateTime(t.created_at, state.calendar)}` }),
      el('div.row', { style: { marginTop: '8px' } }, [
        chip(T.priority[t.priority], T.priorityChip[t.priority]),
        chip(CATEGORIES.find(c => c.value === t.category)?.label || t.category),
        t.escalated ? chip('⚠️ مُصعّدة لتجاوز مدة الاستجابة', 'danger') : null,
        t.first_response_at ? chip('تم الرد خلال المدة', 'ok') : chip(`مدة الاستجابة: ${AR_NUM(t.sla_hours)} ساعة`, 'warn')
      ]),
      t.body ? el('p', { text: t.body, style: { marginTop: '11px', fontSize: '13px', color: 'var(--text-2)', whiteSpace: 'pre-wrap' } }) : null
    ]),
    t.vendor ? card('دعم مزوّد المنصة', el('div.stack', { style: { gap: '8px' } }, [
      el('div.row', {}, [
        chip(VENDOR_STATE[t.vendor.status]?.label || '⏳ بانتظار رد المزوّد',
          VENDOR_STATE[t.vendor.status]?.kind || 'warn'),
        chip(`صُعّدت ${timeAgo(t.vendor.escalated_at)}`)
      ]),
      t.vendor.reply ? el('div', { style: { background: 'var(--ok-bg)', border: '1px solid var(--border)', borderRadius: '11px', padding: '10px 13px' } }, [
        el('b', { text: 'رد فريق منصة رقيم', style: { fontSize: '12.5px' } }),
        el('p', { text: t.vendor.reply, style: { margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' } }),
        el('div.hint', { text: timeAgo(t.vendor.replied_at) })
      ]) : el('div.hint', { text: 'لم يصل رد من المزوّد بعد.' })
    ])) : null,
    card('الردود', replies)
  ]);

  if (isSupport) {
    const status = select(Object.entries(T.ticket).map(([v, l]) => ({ value: v, label: l })), { value: t.status });
    const assignee = select([{ value: '', label: '— غير مُسندة —' }, ...users.map(u => ({ value: u.id, label: u.name }))], { value: t.assignee_id || '' });
    const priority = select(Object.entries(T.priority).map(([v, l]) => ({ value: v, label: l })), { value: t.priority });
    body.append(card('إدارة التذكرة', [
      el('div.grid.g3', {}, [field('الحالة', status), field('المسؤول', assignee), field('الأهمية', priority)]),
      el('button.btn.block', { text: 'حفظ التغييرات', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.patch(`/api/comms/tickets/${t.id}`, { status: status.value, assignee_id: assignee.value || null, priority: priority.value });
          toast('تم تحديث التذكرة', 'ok'); d.close(); reload();
        } finally { e.target.disabled = false; }
      } }),
      t.vendor ? null : el('button.btn.ghost.block', {
        style: { marginTop: '8px' }, text: '⤴️ تصعيد إلى دعم مزوّد المنصة',
        onclick: async (e) => {
          if (!confirm('سيُرسَل نص التذكرة إلى فريق منصة رقيم لمعالجتها. متابعة؟')) return;
          e.target.disabled = true;
          try {
            await api.post(`/api/comms/tickets/${t.id}/escalate-vendor`, {});
            toast('تم تصعيد التذكرة إلى مزوّد المنصة', 'ok'); d.close(); openTicket(t.id, reload); reload();
          } finally { e.target.disabled = false; }
        }
      })
    ]));
  }

  body.append(card('إضافة رد', [
    replyBox,
    isSupport ? el('label.check-row', { style: { marginTop: '8px' } }, [internal, el('div.t', { text: 'ملاحظة داخلية (لا يراها مُقدّم التذكرة)' })]) : null,
    el('button.btn.block', { style: { marginTop: '9px' }, text: 'إرسال الرد', onclick: async (e) => {
      if (!replyBox.value.trim()) return toast('اكتب نص الرد', 'warn');
      e.target.disabled = true;
      try {
        await api.post(`/api/comms/tickets/${t.id}/reply`, { body: replyBox.value, is_internal: internal.checked });
        toast('تم إرسال الرد', 'ok'); d.close(); openTicket(t.id, reload); reload();
      } finally { e.target.disabled = false; }
    } })
  ]));

  const d = drawer({ title: 'تفاصيل التذكرة', body });
}

function openForm(reload) {
  const subject = input({ required: true, placeholder: 'اذكر المشكلة باختصار' });
  const bodyTxt = textarea({ placeholder: 'صف المشكلة بالتفصيل وخطوات تكرارها إن أمكن...' });
  const cat = select(CATEGORIES);
  const priority = select(Object.entries(T.priority).map(([v, l]) => ({ value: v, label: l })), { value: 'medium' });
  const m = modal({
    title: 'رفع تذكرة دعم فني',
    body: el('div', {}, [
      field('عنوان المشكلة', subject, { required: true }),
      el('div.grid.g2', {}, [field('نوع المشكلة', cat), field('الأهمية', priority)]),
      field('التفاصيل', bodyTxt),
      el('div.hint', { text: `سيتواصل معك فريق الدعم خلال ${AR_NUM(state.session.tenant.settings?.ticket_sla_hours || 24)} ساعة، وإلا صُعّدت تذكرتك آلياً للإدارة.` })
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'رفع التذكرة', onclick: async (e) => {
        if (!subject.value.trim()) return toast('عنوان المشكلة إلزامي', 'warn');
        e.target.disabled = true;
        try {
          const r = await api.post('/api/comms/tickets', { subject: subject.value, body: bodyTxt.value, category: cat.value, priority: priority.value });
          toast(`تم رفع التذكرة برقم ${r.number}`, 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}
