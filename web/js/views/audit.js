import api from '../api.js';
import { state } from '../state.js';
import { el, clear, mount, card, chip, empty, table, modal, field, input, searchInput, select, T, AR_NUM, avatar, skeleton, debounce } from '../util.js';
import { fmtDateTime, todayISO, addDaysISO } from '../hijri.js';

export async function render() {
  const users = await api.get('/api/org/users').catch(() => []);
  const body = el('div');
  const filters = { limit: 100, offset: 0 };

  const q = searchInput({ placeholder: 'بحث في السجل...' });
  q.field.addEventListener('input', debounce((e) => { filters.q = e.target.value; filters.offset = 0; load(); }, 340));
  const from = input({ type: 'date', value: addDaysISO(todayISO(), -30), onchange: (e) => { filters.from = e.target.value; load(); } });
  const to = input({ type: 'date', value: todayISO(), onchange: (e) => { filters.to = e.target.value; load(); } });
  const userSel = select([{ value: '', label: 'كل المستخدمين' }, ...users.map(u => ({ value: u.id, label: u.name }))],
    { onchange: (e) => { filters.user_id = e.target.value; load(); } });
  const actionSel = select([{ value: '', label: 'كل الإجراءات' }, ...Object.entries(T.audit).map(([v, l]) => ({ value: v, label: l }))],
    { onchange: (e) => { filters.action = e.target.value; load(); } });

  async function load() {
    clear(body).append(skeleton(6));
    filters.from = filters.from || from.value; filters.to = filters.to || to.value;
    const d = await api.get('/api/audit' + api.qs(filters));
    mount(clear(body),
      el('div.row', { style: { marginBottom: '12px' } }, [
        chip(`${AR_NUM(d.total)} عملية مسجّلة`, 'brand'),
        chip('سجل غير قابل للتعديل أو الحذف (Append-only)', 'warn', 'lock')
      ]),
      card(null, table([
        { header: 'التاريخ والوقت', key: 'created_at', render: r => fmtDateTime(r.created_at, state.calendar) },
        { header: 'المستخدم', key: 'user_name', render: r => el('div.row', { style: { gap: '7px', flexWrap: 'nowrap' } }, [
            avatar(r.user_name || 'النظام', 'sm'),
            el('div', {}, [el('div', { text: r.user_name || 'النظام', style: { fontSize: '12.5px' } }),
              el('small', { text: r.role_key || '', style: { fontSize: '10.5px', color: 'var(--text-3)' } })])]) },
        { header: 'الإجراء', key: 'action', render: r => chip(T.audit[r.action] || r.action,
            { create: 'ok', update: 'info', delete: 'danger', approve: 'ok', reject: 'danger', login: '', export: 'gold' }[r.action] || '') },
        { header: 'العنصر', key: 'entity' },
        { header: 'التفصيل', key: 'summary' },
        { header: 'العنوان', key: 'ip' },
        { header: '', key: 'a', render: r => (r.before || r.after)
            ? el('button.btn.sm.ghost', { text: 'التغييرات', onclick: (e) => { e.stopPropagation(); showDiff(r); } }) : '—' }
      ], d.items, { emptyText: 'لا توجد عمليات مطابقة' }), { p0: true }),
      d.total > filters.limit ? el('div.row', { style: { justifyContent: 'center', marginTop: '12px' } }, [
        /* في RTL: «السابق» يشير يميناً و«التالي» يساراً (دليل الهوية · البند ٨) */
        el('button.btn.sm.ghost', { icon: 'arrow-right', iconSize: 16, text: 'السابق', disabled: filters.offset === 0,
          onclick: () => { filters.offset = Math.max(0, filters.offset - filters.limit); load(); } }),
        chip(`${AR_NUM(filters.offset + 1)} — ${AR_NUM(Math.min(filters.offset + filters.limit, d.total))} من ${AR_NUM(d.total)}`),
        el('button.btn.sm.ghost', { icon: 'arrow-left', iconSize: 16, text: 'التالي', disabled: filters.offset + filters.limit >= d.total,
          onclick: () => { filters.offset += filters.limit; load(); } })
      ]) : null
    );
  }
  await load();

  return el('div.stack', {}, [
    card(null, [
      el('div', { style: { marginBottom: '11px' } }, [el('h3', { text: 'سجل النشاطات والتدقيق' }),
        el('div.hint', { text: 'يوضح من قام بماذا ومتى — يُسجَّل آلياً في جداول مقفلة لا يمكن التلاعب بها، امتثالاً لنظام حماية البيانات الشخصية (PDPL).' })]),
      el('div.row', {}, [q,
        el('label.field', { style: { margin: 0 } }, [el('span', { text: 'من' }), from]),
        el('label.field', { style: { margin: 0 } }, [el('span', { text: 'إلى' }), to]),
        el('label.field', { style: { margin: 0, minWidth: '160px' } }, [el('span', { text: 'المستخدم' }), userSel]),
        el('label.field', { style: { margin: 0, minWidth: '140px' } }, [el('span', { text: 'الإجراء' }), actionSel])
      ])
    ]),
    body
  ]);
}

function showDiff(r) {
  const rows = [];
  const keys = new Set([...Object.keys(r.before || {}), ...Object.keys(r.after || {})]);
  for (const k of keys) rows.push({ field: k, before: fmt(r.before?.[k]), after: fmt(r.after?.[k]) });
  modal({
    title: 'تفاصيل التغيير', size: 'narrow',
    body: el('div', {}, [
      el('div.hint', { style: { marginBottom: '11px' }, text: r.summary }),
      table([
        { header: 'الحقل', key: 'field' },
        { header: 'قبل', key: 'before' },
        { header: 'بعد', key: 'after', render: x => el('b', { text: x.after, style: { color: 'var(--brand)' } }) }
      ], rows, { emptyText: 'لا توجد تفاصيل' })
    ])
  });
}
const fmt = (v) => v === null || v === undefined ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
