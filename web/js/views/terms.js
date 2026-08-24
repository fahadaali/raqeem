import api from '../api.js';
import { state, can } from '../state.js';
import {
  el, clear, card, chip, empty, table, toast, modal, field, input, select,
  AR_NUM, money, confirmDialog, qs, skeleton
} from '../util.js';
import { fmtDate, todayISO, addDaysISO } from '../hijri.js';

export async function render({ navigate }) {
  const wrap = el('div.stack');
  const body = el('div');
  const reload = async () => {
    clear(body).append(skeleton(4));
    const terms = await api.get('/api/terms');
    clear(body).append(list(terms, reload));
  };

  wrap.append(card(null, [el('div.row.between', {}, [
    el('div', {}, [el('h3', { text: 'الفصول الدراسية والفترات' }),
      el('div.hint', { text: 'كل سجل في المنصة مرتبط بفصل دراسي — وعند إغلاقه يصبح مؤرشفاً للقراءة فقط.' })]),
    can('terms.manage') ? el('button.btn.sm.ghost', { icon: 'plus', iconSize: 16, text: 'فصل جديد', onclick: () => openNewTerm(reload) }) : null
  ])]), body);
  await reload();
  return wrap;
}

function list(terms, reload) {
  return el('div.stack', {}, terms.map(t => {
    const isOpen = t.status === 'open';
    return el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [
        el('div', {}, [
          el('div.row', { style: { gap: '9px' } }, [
            el('h4', { text: t.name }),
            chip(t.is_current ? 'الفصل الحالي' : (isOpen ? 'مفتوح' : 'مؤرشف — للقراءة فقط'),
              t.is_current ? 'brand' : (isOpen ? 'ok' : 'warn'))
          ]),
          el('div.hint', { text: `${t.code} · من ${fmtDate(t.start_date, state.calendar)} إلى ${fmtDate(t.end_date, state.calendar)}` })
        ]),
        el('div.row', {}, [
          isOpen && can('terms.close')
            ? el('button.btn.sm.gold', { icon: 'refresh-cw', iconSize: 16, text: 'إغلاق وترحيل', onclick: () => rolloverWizard(t, reload) })
            : null,
          !isOpen && can('terms.manage')
            ? el('button.btn.sm.ghost', { icon: 'lock-open', iconSize: 16, text: 'إعادة فتح', onclick: async () => {
                if (!await confirmDialog(`ستُلغى حماية التجميد عن الفصل «${t.name}» ويصبح قابلاً للتعديل مجدداً.`,
                  { title: 'إعادة فتح فصل مؤرشف', confirmText: 'إعادة الفتح' })) return;
                await api.post(`/api/terms/${t.id}/reopen`, {}); toast('تمت إعادة فتح الفصل', 'ok'); reload();
              } })
            : null
        ])
      ]),
      el('div.grid.g4', { style: { marginTop: '13px' } }, [
        miniStat('المهام', AR_NUM(t.tasks_count)),
        miniStat('الطلبات المالية', AR_NUM(t.requests_count)),
        miniStat('سجلات الحضور', AR_NUM(t.attendance_count)),
        miniStat('الحالة', t.closed_at ? `أُغلق ${fmtDate(t.closed_at, state.calendar, 'short')}` : 'نشط')
      ])
    ])]);
  }));
}
const miniStat = (label, value) => el('div', { style: { background: 'var(--surface-2)', borderRadius: '10px', padding: '9px 12px' } }, [
  el('div', { style: { fontSize: '11px', color: 'var(--text-3)' }, text: label }),
  el('div', { style: { fontSize: '15px', fontWeight: '700' }, text: value })
]);

async function openNewTerm(reload) {
  const code = input({ placeholder: 'T-1447-1', required: true, dir: 'ltr' });
  const name = input({ placeholder: 'الفصل الأول ١٤٤٧هـ', required: true });
  const start = input({ type: 'date', value: todayISO() });
  const end = input({ type: 'date', value: addDaysISO(todayISO(), 120) });
  const cur = el('input', { type: 'checkbox' });
  const m = modal({
    title: 'فصل دراسي جديد',
    body: el('div', {}, [
      field('رمز الفصل', code, { required: true }), field('اسم الفصل', name, { required: true }),
      el('div.grid.g2', {}, [field('تاريخ البداية', start), field('تاريخ النهاية', end)]),
      el('label.check-row', {}, [cur, el('div.t', { text: 'جعله الفصل الحالي النشط' })])
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'إنشاء', onclick: async (e) => {
        if (!code.value || !name.value) return toast('الرمز والاسم إلزاميان', 'warn');
        e.target.disabled = true;
        try {
          await api.post('/api/terms', { code: code.value, name: name.value, start_date: start.value, end_date: end.value, make_current: cur.checked });
          toast('تم إنشاء الفصل', 'ok'); m.close(); reload(); location.reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ معالج إغلاق الفصل (Rollover Wizard) — البند ٣ ═══════════ */
async function rolloverWizard(term, reload) {
  const pv = await api.get(`/api/terms/${term.id}/rollover/preview`);
  let step = 0;
  const picked = { staff: new Set(pv.staff.map(s => s.id)), tasks: new Set(pv.open_tasks.map(t => t.id)),
    committees: new Set(pv.committees.map(c => c.id)), custody: true, budgets: true };
  const newTerm = {
    code: term.code.replace(/(\d+)$/, (n) => String(Number(n) + 1)),
    name: term.name.replace(/(الأول|الثاني|الثالث)/, (w) => ({ 'الأول': 'الثاني', 'الثاني': 'الثالث', 'الثالث': 'الأول' }[w] || w)),
    start_date: addDaysISO(term.end_date, 1), end_date: addDaysISO(term.end_date, 130)
  };

  const stepsBar = el('div.steps');
  const content = el('div');
  const backBtn = el('button.btn.ghost', { text: 'السابق' });
  const nextBtn = el('button.btn', { text: 'التالي' });
  backBtn.onclick = () => go(step - 1);

  const STEPS = [
    { title: '١. الموظفون المستمرون', build: () => pickList(pv.staff, picked.staff,
        s => [s.name, `${s.role_name}${s.branch_name ? ' · ' + s.branch_name : ''} · ${AR_NUM(s.tasks)} مهمة في الفصل`],
        'من هم الموظفون المستمرون في الفصل الجديد؟') },
    { title: '٢. المهام المُرحّلة', build: () => pickList(pv.open_tasks, picked.tasks,
        t => [t.title, `${t.committee_name || 'بدون لجنة'} · ${t.assignee_name || 'غير مُسند'} · إنجاز ${t.progress}٪`],
        'ما هي المهام غير المكتملة التي سترحّل للفصل الجديد؟') },
    { title: '٣. اللجان', build: () => pickList(pv.committees, picked.committees,
        c => [c.name, `${AR_NUM(c.members)} عضو · ${c.description || ''}`],
        'أي اللجان تستمر في الفصل الجديد بنفس تشكيلها؟') },
    { title: '٤. العهد والميزانيات', build: () => assetsStep() },
    { title: '٥. الفصل الجديد', build: () => newTermStep() }
  ];

  function pickList(items, set, fmt, question) {
    const box = el('div');
    box.append(el('p', { style: { marginTop: 0, fontSize: '13.5px', fontWeight: '600' }, text: question }));
    if (!items.length) return box.append(empty('inbox', 'لا توجد عناصر', '')) || box;
    box.append(el('div.row', { style: { marginBottom: '10px' } }, [
      el('button.btn.sm.ghost', { text: 'تحديد الكل', onclick: () => { items.forEach(i => set.add(i.id)); refresh(); } }),
      el('button.btn.sm.ghost', { text: 'إلغاء التحديد', onclick: () => { set.clear(); refresh(); } }),
      el('span.chip.brand', { text: `${AR_NUM(set.size)} من ${AR_NUM(items.length)} محدد` })
    ]));
    const list = el('div', { style: { maxHeight: '340px', overflowY: 'auto' } });
    const refresh = () => {
      clear(list);
      for (const it of items) {
        const [title, sub] = fmt(it);
        list.append(el('label.check-row', {}, [
          el('input', { type: 'checkbox', checked: set.has(it.id),
            onchange: (e) => { e.target.checked ? set.add(it.id) : set.delete(it.id); go(step); } }),
          el('div.t', {}, [title, el('small', { text: sub })])
        ]));
      }
    };
    refresh();
    box.append(list);
    return box;
  }

  function assetsStep() {
    return el('div', {}, [
      el('p', { style: { marginTop: 0, fontSize: '13.5px', fontWeight: '600' }, text: 'هل نرحّل العهد المالية وبنود الميزانية؟' }),
      el('label.check-row', {}, [
        el('input', { type: 'checkbox', checked: picked.custody, onchange: (e) => { picked.custody = e.target.checked; } }),
        el('div.t', {}, ['ترحيل العهد المالية القائمة',
          el('small', { text: `${AR_NUM(pv.custody.length)} عهدة بإجمالي ${money(pv.stats.custody_total)} ر.س` })])
      ]),
      el('label.check-row', {}, [
        el('input', { type: 'checkbox', checked: picked.budgets, onchange: (e) => { picked.budgets = e.target.checked; } }),
        el('div.t', {}, ['إنشاء بنود الميزانية نفسها برصيد جديد',
          /* بنود اللجان تُذكَر على حدة: تخصيصٌ يعبر مع البند، فيُرى قبل أن يُعبَر به */
          el('small', { text: `${AR_NUM(pv.budgets.length)} بند`
            + (pv.budgets.some(b => b.committee_id)
              ? ` (منها ${AR_NUM(pv.budgets.filter(b => b.committee_id).length)} للجان، تُرحَّل بلجانها)` : '')
            + ` · المتبقي حالياً ${money(pv.stats.budgets_remaining)} ر.س` })])
      ]),
      pv.custody.length ? card('العهد التي سترحّل', table([
        { header: 'رقم الطلب', key: 'number' }, { header: 'البيان', key: 'title' },
        { header: 'المسؤول', key: 'requester_name' },
        { header: 'المبلغ (ر.س)', key: 'amount', num: true, render: r => money(r.amount) }
      ], pv.custody), { p0: true }) : null
    ]);
  }

  function newTermStep() {
    const code = input({ value: newTerm.code, dir: 'ltr', oninput: (e) => { newTerm.code = e.target.value; } });
    const name = input({ value: newTerm.name, oninput: (e) => { newTerm.name = e.target.value; } });
    const s = input({ type: 'date', value: newTerm.start_date, onchange: (e) => { newTerm.start_date = e.target.value; } });
    const en = input({ type: 'date', value: newTerm.end_date, onchange: (e) => { newTerm.end_date = e.target.value; } });
    return el('div', {}, [
      el('div.archived-bar', { icon: 'triangle-alert', iconSize: 16 }, [
        `بعد التنفيذ سيُغلق الفصل «${term.name}» ويصبح مؤرشفاً للقراءة فقط — لا يمكن تعديل أي سجل يحمل رقمه.`]),
      field('رمز الفصل الجديد', code, { required: true }), field('اسم الفصل الجديد', name, { required: true }),
      el('div.grid.g2', {}, [field('تاريخ البداية', s), field('تاريخ النهاية', en)]),
      card('ملخّص الترحيل', el('div.grid.g4', {}, [
        miniStat('موظفون مستمرون', AR_NUM(picked.staff.size)),
        miniStat('مهام مُرحّلة', AR_NUM(picked.tasks.size)),
        miniStat('لجان', AR_NUM(picked.committees.size)),
        miniStat('عهد وميزانيات', `${picked.custody ? 'نعم' : 'لا'} / ${picked.budgets ? 'نعم' : 'لا'}`)
      ]))
    ]);
  }

  function go(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    clear(stepsBar).append(...STEPS.map((s, k) =>
      el('div.step' + (k === step ? '.active' : k < step ? '.done' : ''), { text: s.title })));
    clear(content).append(STEPS[step].build());
    backBtn.disabled = step === 0;
    nextBtn.textContent = step === STEPS.length - 1 ? 'تنفيذ الإغلاق والترحيل' : 'التالي';
    nextBtn.className = step === STEPS.length - 1 ? 'btn gold' : 'btn';
    nextBtn.onclick = step === STEPS.length - 1 ? execute : () => go(step + 1);
  }

  async function execute(e) {
    if (!newTerm.code || !newTerm.name) return toast('بيانات الفصل الجديد غير مكتملة', 'warn');
    if (!await confirmDialog(
      `سيُغلق الفصل «${term.name}» نهائياً ويُنشأ «${newTerm.name}» مع ترحيل ${picked.tasks.size} مهمة و${picked.committees.size} لجنة.`,
      { title: 'تأكيد إغلاق الفصل', confirmText: 'نعم، نفّذ الترحيل' })) return;
    e.target.disabled = true;
    try {
      const res = await api.post(`/api/terms/${term.id}/rollover`, {
        new_term: newTerm,
        staff_ids: [...picked.staff], task_ids: [...picked.tasks], committee_ids: [...picked.committees],
        carry_custody: picked.custody, carry_budgets: picked.budgets, close_source: true
      });
      toast(res.message, 'ok', 'جارٍ الترحيل');
      m.close();
      setTimeout(() => location.reload(), 2600);
    } finally { e.target.disabled = false; }
  }

  const m = modal({
    title: `معالج إغلاق الفصل: ${term.name}`, size: 'wide',
    body: el('div', {}, [stepsBar, content]),
    footer: [backBtn, nextBtn]
  });
  go(0);
}
