import api from '../api.js';
import { state, can } from '../state.js';
import { el, clear, mount, card, chip, empty, table, toast, field, input, select, picker, userOptions, AR_NUM, skeleton, qs } from '../util.js';
import { todayISO, addDaysISO } from '../hijri.js';

export async function render() {
  const reports = await api.get('/api/reports');
  const users = await api.get('/api/org/users').catch(() => []);
  const payrolls = can('hr.payroll.view') ? await api.get('/api/hr/payroll').catch(() => []) : [];
  const wrap = el('div.stack');
  const result = el('div');
  let current = null;
  const filterInputs = {};

  const filterBox = el('div');
  const list = el('div.grid.g3', {}, reports.map(r => el('div.card', {
    style: { cursor: 'pointer', transition: '.15s' },
    onclick: () => selectReport(r)
  }, [el('div.card-body', {}, [
    el('div.row.between', {}, [el('h4', { text: r.label }), chip(r.module, 'brand')]),
    el('p', { text: r.description, style: { fontSize: '12.5px', color: 'var(--text-2)', margin: '7px 0 0' } })
  ])])));

  function buildFilter(f) {
    if (f.type === 'date') return input({ type: 'date', value: f.key === 'from' ? addDaysISO(todayISO(), -30) : todayISO() });
    if (f.type === 'branch') return select([{ value: '', label: 'كل الفروع' }, ...state.session.branches.map(b => ({ value: b.id, label: b.name }))]);
    if (f.type === 'term') return select([{ value: '', label: 'كل الفصول' }, ...state.session.terms.map(t => ({ value: t.id, label: t.name }))],
      { value: state.session.current_term?.id || '' });
    if (f.type === 'user') return picker([{ value: '', label: 'كل المستخدمين' }, ...userOptions(users)],
      { placeholder: 'كل المستخدمين', ariaLabel: 'تصفية بالمستخدم' });
    if (f.type === 'payroll') return select([{ value: '', label: 'آخر مسير' }, ...payrolls.map(p => ({ value: p.id, label: `${p.month}/${p.year} — ${p.branch_name || 'كل الفروع'}` }))]);
    if (f.type === 'select') return select([{ value: '', label: 'الكل' }, ...f.options], {});
    return input({});
  }

  function collect() {
    const out = {};
    for (const [k, ctrl] of Object.entries(filterInputs)) if (ctrl.value) out[k] = ctrl.value;
    return out;
  }

  async function run() {
    clear(result).append(skeleton(6));
    try {
      const d = await api.post(`/api/reports/${current.key}/run`, { filters: collect() });
      mount(clear(result),
        d.summary?.length ? el('div.grid.g4', { style: { marginBottom: '14px' } }, d.summary.map(s =>
          el('div.stat', {}, [el('div.label', { text: s.label }), el('div.value', { style: { fontSize: '19px' }, text: String(s.value) })]))) : null,
        d.applied_filters?.length ? el('div.row', { style: { marginBottom: '11px' } },
          d.applied_filters.map(f => chip(`${f.label}: ${f.value}`, 'info'))) : null,
        card(`${d.label} — ${AR_NUM(d.rows.length)} سجل`, table(
          d.columns.map(c => ({ header: c.header, key: c.key })),
          d.rows.slice(0, 300),
          { emptyText: 'لا توجد بيانات مطابقة لعوامل التصفية' }
        ), { p0: true, actions: d.rows.length > 300 ? chip(`يُعرض أول ٣٠٠ من ${AR_NUM(d.rows.length)} — التصدير يشمل الكل`, 'warn') : null })
      );
    } catch (e) { clear(result).append(empty('triangle-alert', 'تعذّر تشغيل التقرير', e.message)); }
  }

  function selectReport(r) {
    current = r;
    Object.keys(filterInputs).forEach(k => delete filterInputs[k]);
    const grid = el('div.grid.g4');
    for (const f of r.filters || []) {
      const ctrl = buildFilter(f);
      filterInputs[f.key] = ctrl;
      grid.append(field(f.label, ctrl));
    }
    clear(filterBox).append(card(null, [
      el('div.row.between', { style: { marginBottom: '11px' } }, [
        el('div', {}, [el('h3', { text: r.label }), el('div.hint', { text: r.description })]),
        el('button.btn.sm.ghost', { icon: 'undo-2', iconSize: 16, text: 'كل التقارير', onclick: () => { clear(filterBox); clear(result); current = null; list.hidden = false; } })
      ]),
      grid,
      el('div.row', { style: { marginTop: '9px' } }, [
        el('button.btn', { icon: 'play', iconSize: 16, text: 'تشغيل التقرير', onclick: run }),
        can('reports.export') ? el('button.btn.ghost', { icon: 'printer', iconSize: 16, text: 'طباعة / PDF رسمي', onclick: () =>
          api.openPrint(`/api/reports/${r.key}/export`, { format: 'pdf', filters: collect() }) }) : null,
        can('reports.export') ? el('button.btn.ghost', { icon: 'table', iconSize: 16, text: 'تصدير Excel', onclick: () =>
          api.download(`/api/reports/${r.key}/export`, { format: 'xlsx', filters: collect() }) }) : null,
        can('reports.export') ? el('button.btn.ghost', { icon: 'file-text', iconSize: 16, text: 'تصدير CSV', onclick: () =>
          api.download(`/api/reports/${r.key}/export`, { format: 'csv', filters: collect() }) }) : null
      ])
    ]));
    list.hidden = true;
    run();
  }

  wrap.append(
    card(null, [el('div', {}, [el('h3', { text: 'محرك التقارير والطباعة' }),
      el('div.hint', { text: 'اختر تقريراً، حدّد عوامل التصفية، ثم صدّره بصيغة Excel أو CSV أو مستند PDF رسمي مُروّس بشعار الجهة.' })])]),
    filterBox, list, result
  );
  return wrap;
}
