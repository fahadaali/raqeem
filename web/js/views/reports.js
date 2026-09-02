import api from '../api.js';
import { state, can } from '../state.js';
import {
  el, clear, mount, card, chip, empty, table, toast, field, input, select, picker, searchInput,
  userOptions, AR_NUM, counted, debounce, skeleton
} from '../util.js';
import { todayISO, addDaysISO } from '../hijri.js';

/**
 * شاشة التقارير — كتالوجٌ يُتصفَّح ثم تقريرٌ يُشغَّل ويُصدَّر.
 *
 * كانت التقارير شبكةً واحدة تطول كلّما أُضيف تقرير، فيبحث المستخدم عن تقرير
 * الحضور بين تقارير المهام والمالية بعينه. فصارت مصنَّفةً بوحداتها، وفوقها
 * حقلُ بحثٍ يحصرها بكلمة — والوحدة التي لا تطابق شيئاً تختفي بعنوانها.
 *
 * وأيقونةُ كل وحدة هي أيقونتُها في القائمة الجانبية نفسها، فالعينُ التي تعرف
 * «المهام» في الشريط تعرفها هنا بلا قراءة.
 */
const MODULE_ICON = {
  'المهام': 'clipboard-list',
  'الموارد البشرية': 'briefcase-business',
  'المالية': 'banknote',
  'التقييم': 'chart-line',
  'الدعم': 'headset',
  'الحوكمة': 'shield-check'
};

export async function render() {
  const [reports, users, payrolls] = await Promise.all([
    api.get('/api/reports'),
    api.get('/api/org/users').catch(() => []),
    can('hr.payroll.view') ? api.get('/api/hr/payroll').catch(() => []) : Promise.resolve([])
  ]);

  const wrap = el('div.stack');
  const result = el('div');
  const filterBox = el('div');
  const catalog = el('div.stack');
  let current = null;
  const filterInputs = {};

  /* ═════════ الكتالوج ═════════ */
  const search = searchInput({ placeholder: 'بحث في التقارير — باسم التقرير أو وصفه أو وحدته...' });

  const paintCatalog = () => {
    const q = search.field.value.trim().toLowerCase();
    const hits = reports.filter(r => !q
      || `${r.label} ${r.description} ${r.module}`.toLowerCase().includes(q));
    clear(catalog);
    if (!hits.length) {
      catalog.append(empty('search', 'لا تقارير مطابقة', 'جرّب كلمةً أعمّ، أو امسح البحث لعرض الكتالوج كاملاً.'));
      return;
    }
    /* الترتيب ترتيبُ الخادم لا الأبجدية: التقارير مرتّبةٌ فيه بوحداتها أصلاً */
    const modules = [...new Set(hits.map(r => r.module))];
    for (const m of modules) {
      const inModule = hits.filter(r => r.module === m);
      catalog.append(el('div', {}, [
        el('h3.rep-group', { icon: MODULE_ICON[m] || 'folder-open', iconSize: 18 }, [
          m, el('span', { text: counted(inModule.length, { one: 'تقرير واحد', two: 'تقريران', few: 'تقارير', many: 'تقريراً' }) })
        ]),
        el('div.grid.g3', {}, inModule.map(r => el('button.rep-card', {
          onclick: () => selectReport(r)
        }, [
          el('div.row.between', {}, [
            el('h4', { text: r.label }),
            el('span.ic', { icon: 'arrow-left', iconSize: 16 })
          ]),
          el('p', { text: r.description })
        ])))
      ]));
    }
  };
  search.field.addEventListener('input', debounce(paintCatalog, 140));

  /* ═════════ لوحة التصفية ═════════ */
  function buildFilter(f) {
    if (f.type === 'date') return input({ type: 'date', value: f.key === 'from' ? addDaysISO(todayISO(), -30) : todayISO() });
    if (f.type === 'branch') return select([{ value: '', label: 'كل الفروع' }, ...state.session.branches.map(b => ({ value: b.id, label: b.name }))]);
    if (f.type === 'term') return select([{ value: '', label: 'كل الفصول' }, ...state.session.terms.map(t => ({ value: t.id, label: t.name }))],
      { value: state.session.current_term?.id || '' });
    if (f.type === 'user') return picker([{ value: '', label: 'كل المستخدمين' }, ...userOptions(users)],
      { placeholder: 'كل المستخدمين', ariaLabel: 'تصفية بالمستخدم' });
    if (f.type === 'payroll') return select([{ value: '', label: 'آخر مسير' }, ...payrolls.map(p => ({ value: p.id, label: `${p.month}/${p.year} — ${p.branch_name || 'كل الفروع'}` }))]);
    /*
     * `group` ليست تصفيةً تُترك فارغة بل اختيارٌ لا بدّ منه — مستوى التقرير
     * أو نطاقه. فلا يُسبَق بـ«الكل»، ويبدأ على قيمته الافتراضية.
     */
    if (f.type === 'group') return select(f.options, { value: f.default ?? f.options[0]?.value ?? '' });
    if (f.type === 'select') return select([{ value: '', label: 'الكل' }, ...f.options], {});
    return input({});
  }

  function collect() {
    const out = {};
    for (const [k, ctrl] of Object.entries(filterInputs)) if (ctrl.value) out[k] = ctrl.value;
    return out;
  }

  /* ═════════ التشغيل ═════════ */
  async function run() {
    clear(result).append(skeleton(6));
    try {
      const d = await api.post(`/api/reports/${current.key}/run`, { filters: collect() });
      mount(clear(result),
        d.summary?.length ? el('div.grid.g4', { style: { marginBottom: '14px' } }, d.summary.map(s =>
          el('div.stat', {}, [el('div.label', { text: s.label }), el('div.value', { style: { fontSize: '19px' }, text: String(s.value) })]))) : null,
        d.applied_filters?.length ? el('div.row', { style: { marginBottom: '11px' } },
          d.applied_filters.map(f => chip(`${f.label}: ${f.value}`, 'info'))) : null,
        card(`${d.label} — ${counted(d.rows.length, { one: 'سجل واحد', two: 'سجلان', few: 'سجلات', many: 'سجلاً' })}`, table(
          d.columns.map(c => ({ header: c.header, key: c.key })),
          d.rows.slice(0, 300),
          { emptyText: 'لا توجد بيانات مطابقة لعوامل التصفية' }
        ), { p0: true, actions: d.rows.length > 300 ? chip(`يُعرض أول ٣٠٠ من ${AR_NUM(d.rows.length)} — التصدير يشمل الكل`, 'warn') : null })
      );
    } catch (e) { clear(result).append(empty('triangle-alert', 'تعذّر تشغيل التقرير', e.message)); }
  }

  function backToCatalog() {
    clear(filterBox); clear(result); current = null;
    catalog.hidden = false; search.hidden = false;
  }

  function selectReport(r) {
    current = r;
    Object.keys(filterInputs).forEach(k => delete filterInputs[k]);
    const grid = el('div.grid.g4');
    for (const f of r.filters || []) {
      const ctrl = buildFilter(f);
      filterInputs[f.key] = ctrl;
      grid.append(field(f.label, ctrl));
      /* مستوى التقرير يُعاد تشغيله بمجرّد تبديله — فهو سؤالٌ لا تصفية */
      if (f.type === 'group') ctrl.addEventListener('change', () => { if (current === r) run(); });
    }
    clear(filterBox).append(card(null, [
      el('div.row.between', { style: { marginBottom: '11px' } }, [
        el('div', {}, [
          el('h3', { icon: MODULE_ICON[r.module] || 'chart-column', text: r.label }),
          el('div.hint', { text: r.description })
        ]),
        el('button.btn.sm.ghost', { icon: 'undo-2', iconSize: 16, text: 'كل التقارير', onclick: backToCatalog })
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
    catalog.hidden = true; search.hidden = true;
    run();
  }

  paintCatalog();
  wrap.append(
    card(null, [
      el('h3', { icon: 'chart-column', text: 'محرك التقارير والطباعة' }),
      el('div.hint', { style: { marginBottom: '11px' },
        text: `${counted(reports.length, { one: 'تقريرٌ واحد', two: 'تقريران', few: 'تقارير', many: 'تقريراً' })} جاهزة — `
          + 'اختر تقريراً، حدّد عوامل التصفية، ثم صدّره بصيغة Excel أو CSV أو مستند PDF رسمي مُروّس بشعار الجهة.' }),
      search
    ]),
    filterBox, catalog, result
  );
  return wrap;
}
