import api from '../api.js';
import { state, can, termIsArchived } from '../state.js';
import {
  el, clear, mount, card, chip, empty, table, toast, modal, drawer, field, input, textarea, select,
  tabs, T, AR_NUM, pct, money, avatar, progressBar, confirmDialog, skeleton, timeAgo, qs
} from '../util.js';
import { fmtDate, fmtDateTime, todayISO } from '../hijri.js';
import { chatBox } from './tasks.js';

export async function render({ route }) {
  const items = [];
  if (can('finance.view', 'finance.request')) items.push({ label: 'الطلبات المالية', icon: 'file-text', build: requestsTab });
  if (can('invoices.view')) items.push({ label: 'الفواتير', icon: 'receipt', build: invoicesTab });
  if (can('budgets.view')) items.push({ label: 'الميزانيات', icon: 'chart-column', build: budgetsTab });
  if (can('workflows.view')) items.push({ label: 'مسارات الاعتماد', icon: 'workflow', build: workflowsTab });
  const t = tabs(items, (it) => { const n = el('div'); Promise.resolve(it.build()).then(x => n.replaceChildren(x)); return n; });
  if (route.query.id) setTimeout(() => openRequest(Number(route.query.id)), 200);
  if (route.query.new === '1') setTimeout(() => openRequestForm(null, () => location.reload()), 200);
  return t.node;
}

/* ═══════════ الطلبات المالية ودورة الاعتماد ═══════════ */
async function requestsTab() {
  const body = el('div');
  let filter = '';
  const load = async () => {
    clear(body).append(skeleton(5));
    const rows = await api.get('/api/finance/requests' + api.qs({ status: filter }));
    const pending = rows.filter(r => r.can_approve);
    mount(clear(body),
      pending.length ? card(`بانتظار اعتمادك (${AR_NUM(pending.length)})`,
        el('div.stack', { style: { gap: '8px' } }, pending.map(r => el('div.check-row', { onclick: () => openRequest(r.id, load) }, [
          el('span.ic', { icon: 'banknote', iconSize: 16 }),
          el('div.t', {}, [`${r.number} — ${r.title}`,
            el('small', { text: `${r.requester_name} · ${money(r.amount)} ر.س · ${r.current_step_name}` })]),
          chip('اعتمد الآن', 'gold')
        ])))) : null,
      card(null, table([
        { header: 'رقم الطلب', key: 'number' },
        { header: 'البيان', key: 'title' },
        { header: 'النوع', key: 'type', render: r => chip(T.financeType[r.type] || r.type) },
        { header: 'مقدّم الطلب', key: 'requester_name' },
        { header: 'المبلغ (ر.س)', key: 'amount', num: true, render: r => money(r.amount) },
        { header: 'المرحلة', key: 'step', render: r => r.current_step_name },
        { header: 'الحالة', key: 'status', render: r => chip(T.finance[r.status], T.financeChip[r.status]) },
        { header: 'التاريخ', key: 'created_at', render: r => fmtDate(r.created_at, state.calendar, 'short') }
      ], rows, { onRow: (r) => openRequest(r.id, load), emptyText: 'لا توجد طلبات مالية' }), { p0: true })
    );
  };
  const statusSel = select([{ value: '', label: 'كل الحالات' }, ...Object.entries(T.finance).map(([v, l]) => ({ value: v, label: l }))],
    { onchange: (e) => { filter = e.target.value; load(); } });
  await load();

  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div.row', {}, [el('h3', { text: 'الطلبات المالية' }), statusSel]),
      can('finance.request') && !termIsArchived()
        ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'طلب مالي جديد', onclick: () => openRequestForm(null, load) }) : null
    ])]),
    body
  ]);
}

export async function openRequest(id, reload) {
  const r = await api.get(`/api/finance/requests/${id}`).catch(() => null);
  if (!r) return toast('الطلب غير موجود', 'err');

  const timeline = el('div.flow', {}, r.timeline.map((s, i) => el('div.flow-step.' + s.state, {}, [
    el('div.flow-dot', s.state === 'approved' ? { icon: 'check', iconSize: 16 }
      : s.state === 'rejected' ? { icon: 'x', iconSize: 16 } : { text: AR_NUM(i + 1) }),
    el('div.n', { text: s.name }),
    el('div.w', { text: s.at ? fmtDate(s.at, state.calendar, 'short') : (s.state === 'current' ? 'بانتظار الإجراء' : 'لم تبدأ') }),
    s.by ? el('div.w', { style: { fontWeight: '600' }, text: s.by }) : null,
    s.note ? el('div.w', { style: { color: 'var(--text-2)' }, text: '«' + s.note + '»' }) : null
  ])));

  const body = el('div.stack', {}, [
    el('div', {}, [
      el('div.row.between', {}, [
        el('h3', { text: r.title }),
        chip(T.finance[r.status], T.financeChip[r.status])
      ]),
      el('div.hint', { text: `${r.number} · ${T.financeType[r.type]} · ${r.branch_name || ''} · ${fmtDateTime(r.created_at, state.calendar)}` }),
      el('div.row', { style: { marginTop: '10px' } }, [
        el('div.stat', { style: { flex: 1 } }, [el('div.label', { text: 'المبلغ المطلوب' }), el('div.value', { text: money(r.amount) + ' ر.س' })]),
        el('div.stat.info', { style: { flex: 1 } }, [el('div.label', { text: 'مقدّم الطلب' }), el('div.value', { style: { fontSize: '15px' }, text: r.requester_name })])
      ]),
      r.description ? el('p', { text: r.description, style: { fontSize: '13px', color: 'var(--text-2)', marginTop: '11px' } }) : null
    ]),
    card('مسار الاعتماد', timeline, { icon: 'workflow', sub: r.workflow_name || 'المسار الافتراضي' })
  ]);

  if (r.can_approve) {
    const note = textarea({ placeholder: 'ملاحظة الاعتماد أو سبب الرفض (اختياري)...' });
    body.append(card('إجراء الاعتماد', [
      note,
      el('div.row', { style: { marginTop: '10px' } }, [
        el('button.btn', { icon: 'check', iconSize: 16, text: 'اعتماد', style: { flex: 1 }, onclick: () => decide('approve') }),
        el('button.btn.danger', { icon: 'x', iconSize: 16, text: 'رفض', style: { flex: 1 }, onclick: () => decide('reject') })
      ])
    ], { sub: `أنت مخوّل بمرحلة: ${r.current_step_name}` }));

    async function decide(action) {
      if (action === 'reject' && !await confirmDialog('سيُرفض الطلب نهائياً ولن يكمل دورة الاعتماد.', { danger: true, confirmText: 'رفض الطلب' })) return;
      try {
        await api.post(`/api/finance/requests/${r.id}/decide`, { action, note: note.value });
        toast(action === 'approve' ? 'تم اعتماد الطلب' : 'تم رفض الطلب', action === 'approve' ? 'ok' : 'info');
        d.close(); reload?.();
      } catch {}
    }
  }

  if (r.invoices?.length) {
    body.append(card('الفواتير المرفقة', el('div.stack', { style: { gap: '8px' } }, r.invoices.map(i =>
      el('div.check-row', { style: { cursor: i.file_id ? 'pointer' : 'default' }, onclick: () => i.file_id && previewFile(i.file_id, i.original_name) }, [
        el('span.ic', { icon: 'receipt', iconSize: 16 }),
        el('div.t', {}, [`${i.number} — ${i.vendor || 'مورد'}`, el('small', { text: `${money(i.total)} ر.س · ${fmtDate(i.date, state.calendar, 'short')}` })]),
        i.file_id ? chip('معاينة', 'info') : null
      ])))));
  }

  if (can('chat.use')) body.append(card('المحادثة السياقية', [await chatBox('finance_request', r.id)], { icon: 'message-circle' }));

  const d = drawer({ title: 'تفاصيل الطلب المالي', body });
}

export function previewFile(fileId, name = '') {
  const url = `/api/files/${fileId}`;
  const isImg = /\.(png|jpe?g|webp|gif|heic)$/i.test(name);
  modal({
    title: 'معاينة المرفق: ' + name, size: 'wide',
    body: el('div', { style: { textAlign: 'center' } }, [
      isImg
        ? el('img', { src: url, alt: name, style: { maxWidth: '100%', borderRadius: '10px' } })
        : el('iframe', { src: url, style: { width: '100%', height: '68vh', border: '1px solid var(--border)', borderRadius: '10px' } }),
      el('div', { style: { marginTop: '12px' } }, [
        el('a.btn.sm.ghost', { href: url + '?download=1', download: name, icon: 'download', iconSize: 16, text: 'تنزيل الملف' })
      ])
    ])
  });
}

async function openRequestForm(req, reload) {
  const [budgets, workflows] = await Promise.all([
    api.get('/api/finance/budgets').catch(() => []),
    api.get('/api/finance/workflows').catch(() => [])
  ]);
  const title = input({ placeholder: 'بيان الطلب', required: true });
  const type = select(Object.entries(T.financeType).map(([v, l]) => ({ value: v, label: l })));
  const amount = input({ type: 'number', min: 0, step: '0.01', placeholder: '0.00', required: true });
  const desc = textarea({ placeholder: 'تفاصيل الطلب ومبرراته...' });
  const budget = select([{ value: '', label: '— بدون بند ميزانية —' }, ...budgets.map(b => ({ value: b.id, label: `${b.name} (متبقي ${money(b.remaining)})` }))]);
  const branch = select([{ value: '', label: '— الفرع الافتراضي —' }, ...state.session.branches.map(b => ({ value: b.id, label: b.name }))]);
  const wf = select([{ value: '', label: '— المسار التلقائي حسب النوع —' }, ...workflows.map(w => ({ value: w.id, label: `${w.name} (${w.steps.length} خطوة)` }))]);
  const preview = el('div', { style: { marginTop: '10px' } });

  const renderPreview = () => {
    const chosen = workflows.find(w => String(w.id) === wf.value) || workflows.find(w => w.doc_type === type.value) || null;
    clear(preview);
    if (chosen) preview.append(el('div.hint', { text: 'مسار الاعتماد المتوقع:' }),
      el('div.flow', {}, chosen.steps.map((s, i) => el('div.flow-step', {}, [
        el('div.flow-dot', { text: AR_NUM(i + 1) }), el('div.n', { text: s.name })]))));
  };
  type.addEventListener('change', renderPreview); wf.addEventListener('change', renderPreview);
  renderPreview();

  const fileInput = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
  const fileList = el('div.row', { style: { marginTop: '8px' } });
  const drop = el('div.file-drop', { onclick: () => fileInput.click() }, [
    el('span.ic', { icon: 'receipt', iconSize: 'card' }),
    el('div', { text: 'اسحب صور الفواتير هنا أو اضغط للاختيار' }),
    el('div.hint', { text: 'JPG · PNG · PDF — حتى ١٥ ميجابايت للملف' })
  ]);
  let uploaded = [];
  const handleFiles = async (files) => {
    if (!files.length) return;
    const fd = new FormData();
    fd.append('context', 'invoices');
    for (const f of files) fd.append('files', f);
    try {
      const res = await api.post('/api/files', fd);
      uploaded = uploaded.concat(res.files);
      clear(fileList).append(...uploaded.map(f => chip(f.name, 'ok', 'receipt')));
      toast(`تم رفع ${AR_NUM(res.files.length)} ملف`, 'ok');
    } catch {}
  };
  fileInput.addEventListener('change', (e) => handleFiles([...e.target.files]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });

  const m = modal({
    title: 'طلب مالي جديد',
    body: el('div', {}, [
      field('بيان الطلب', title, { required: true }),
      el('div.grid.g2', {}, [field('نوع الطلب', type), field('المبلغ (ر.س)', amount, { required: true })]),
      field('التفاصيل', desc),
      el('div.grid.g2', {}, [field('الفرع', branch), field('بند الميزانية', budget)]),
      field('مسار الاعتماد', wf), preview,
      field('مرفقات الفاتورة', el('div', {}, [drop, fileInput, fileList]))
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'رفع الطلب', onclick: async (e) => {
        if (!title.value.trim() || !amount.value) return toast('البيان والمبلغ إلزاميان', 'warn');
        e.target.disabled = true;
        try {
          const r = await api.post('/api/finance/requests', {
            title: title.value.trim(), type: type.value, amount: Number(amount.value),
            description: desc.value, budget_id: budget.value || null, branch_id: branch.value || null,
            workflow_id: wf.value || null
          });
          for (const f of uploaded) {
            await api.post('/api/finance/invoices', { request_id: r.id, total: Number(amount.value), file_id: f.id, date: todayISO() }).catch(() => {});
          }
          toast(`تم رفع الطلب برقم ${r.number}`, 'ok'); m.close(); reload?.();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ الفواتير ═══════════ */
async function invoicesTab() {
  const rows = await api.get('/api/finance/invoices');
  return card('سجل الفواتير', table([
    { header: 'رقم الفاتورة', key: 'number' },
    { header: 'المورد', key: 'vendor' },
    { header: 'الطلب المرتبط', key: 'request_number' },
    { header: 'الصافي', key: 'amount', num: true, render: r => money(r.amount) },
    { header: 'الضريبة', key: 'vat', num: true, render: r => money(r.vat) },
    { header: 'الإجمالي (ر.س)', key: 'total', num: true, render: r => el('b', { text: money(r.total) }) },
    { header: 'التاريخ', key: 'date', render: r => fmtDate(r.date, state.calendar, 'short') },
    { header: 'المرفق', key: 'f', render: r => r.file_id
        ? el('button.btn.sm.ghost', { icon: 'eye', iconSize: 16, text: 'معاينة', onclick: (e) => { e.stopPropagation(); previewFile(r.file_id, r.original_name); } })
        : '—' }
  ], rows, { emptyText: 'لا توجد فواتير مسجلة' }), { p0: true });
}

/* ═══════════ الميزانيات ═══════════ */
async function budgetsTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const rows = await api.get('/api/finance/budgets');
    clear(body).append(el('div.grid.g2', {}, rows.map(b => el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [el('h4', { text: b.name }), chip(b.category || 'عام', 'brand')]),
      el('div.hint', { text: b.branch_name || 'على مستوى المجمّع' }),
      el('div.row.between', { style: { marginTop: '12px', fontSize: '12.5px' } }, [
        el('span', { text: `المنصرف: ${money(b.spent)} ر.س` }),
        el('b', { text: `المتبقي: ${money(b.remaining)} ر.س`, style: { color: b.remaining < 0 ? 'var(--danger)' : 'var(--ok)' } })
      ]),
      el('div', { style: { margin: '7px 0' } }, [progressBar(b.usage_pct, b.usage_pct > 90 ? 'danger' : b.usage_pct > 70 ? 'gold' : 'ok')]),
      el('div.row.between', { style: { fontSize: '11.5px', color: 'var(--text-3)' } }, [
        el('span', { text: `المعتمد: ${money(b.amount)} ر.س` }), el('span', { text: `${pct(b.usage_pct)} مستهلك` })
      ])
    ])]))));
    if (!rows.length) clear(body).append(empty('chart-column', 'لا توجد ميزانيات', 'أنشئ بنود ميزانية لضبط المصروفات.'));
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [el('h3', { text: 'بنود الميزانية' }),
      can('budgets.manage') ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'بند جديد', onclick: () => openBudget(load) }) : null])]),
    body
  ]);
}

function openBudget(reload) {
  const name = input({ required: true }); const cat = input({ value: 'تشغيل' });
  const amount = input({ type: 'number', min: 0, step: '0.01', required: true });
  const branch = select([{ value: '', label: '— على مستوى المجمّع —' }, ...state.session.branches.map(b => ({ value: b.id, label: b.name }))]);
  const m = modal({
    title: 'بند ميزانية جديد', size: 'narrow',
    body: el('div', {}, [field('اسم البند', name, { required: true }), field('التصنيف', cat),
      field('المبلغ المعتمد (ر.س)', amount, { required: true }), field('الفرع', branch)]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ', onclick: async (e) => {
        if (!name.value || !amount.value) return toast('الاسم والمبلغ إلزاميان', 'warn');
        e.target.disabled = true;
        try { await api.post('/api/finance/budgets', { name: name.value, category: cat.value, amount: Number(amount.value), branch_id: branch.value || null });
          toast('تم إنشاء البند', 'ok'); m.close(); reload(); } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ باني مسارات الاعتماد ═══════════ */
async function workflowsTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(3));
    const rows = await api.get('/api/finance/workflows');
    clear(body).append(el('div.stack', {}, rows.map(w => el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [
        el('div', {}, [el('h4', { text: w.name }), el('div.hint', { text: `نوع المستند: ${T.financeType[w.doc_type] || w.doc_type}` })]),
        el('div.row', {}, [
          chip(w.is_active ? 'مفعّل' : 'معطّل', w.is_active ? 'ok' : ''),
          can('workflows.manage') ? el('button.btn.sm.ghost', { icon: 'pencil', iconSize: 16, text: 'تعديل', onclick: () => openWorkflow(w, load) }) : null
        ])
      ]),
      el('div.flow', { style: { marginTop: '11px' } }, w.steps.map((s, i) => el('div.flow-step', {}, [
        el('div.flow-dot', { text: AR_NUM(i + 1) }), el('div.n', { text: s.name }),
        el('div.w', { text: `دور: ${s.role_key || '—'}` })])))
    ])]))));
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div', {}, [el('h3', { text: 'شجرة الاعتمادات' }),
        el('div.hint', { text: 'رتّب مراحل الاعتماد لكل نوع مستند — لا يمكن تجاوز أي خطوة إلا من صاحب الصلاحية.' })]),
      can('workflows.manage') ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'مسار جديد', onclick: () => openWorkflow(null, load) }) : null
    ])]),
    body
  ]);
}

const STEP_ROLES = [
  { value: 'supervisor', label: 'المشرف', permission: 'finance.approve_supervisor' },
  { value: 'finance', label: 'المالية', permission: 'finance.approve_finance' },
  { value: 'branch_manager', label: 'مدير الفرع', permission: 'finance.approve_supervisor' },
  { value: 'owner', label: 'مدير الجهة', permission: 'finance.manage' }
];

function openWorkflow(w, reload) {
  const name = input({ value: w?.name || '', required: true });
  const docType = select(Object.entries(T.financeType).map(([v, l]) => ({ value: v, label: l })), { value: w?.doc_type || 'expense' });
  let steps = (w?.steps || [{ name: 'اعتماد المشرف', role_key: 'supervisor', permission: 'finance.approve_supervisor' }]).map(s => ({ ...s }));
  const stepsBox = el('div');

  const paint = () => {
    clear(stepsBox);
    steps.forEach((s, i) => {
      const nm = input({ value: s.name, style: { minHeight: '34px', padding: '5px 10px' }, oninput: (e) => { s.name = e.target.value; } });
      const rl = select(STEP_ROLES, { value: s.role_key, style: { minHeight: '34px', padding: '5px 10px' },
        onchange: (e) => { s.role_key = e.target.value; s.permission = STEP_ROLES.find(r => r.value === e.target.value).permission; } });
      stepsBox.append(el('div.check-row', { style: { cursor: 'default', gap: '7px' } }, [
        el('div.avatar.sm', { text: AR_NUM(i + 1) }),
        el('div', { style: { flex: '2' } }, [nm]),
        el('div', { style: { flex: '1' } }, [rl]),
        el('button.btn.sm.ghost', { icon: 'arrow-up', iconSize: 16, title: 'أعلى', 'aria-label': 'أعلى', disabled: i === 0, onclick: () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; paint(); } }),
        el('button.btn.sm.ghost', { icon: 'x', iconSize: 16, title: 'حذف', 'aria-label': 'حذف', onclick: () => { steps.splice(i, 1); paint(); } })
      ]));
    });
    stepsBox.append(el('button.btn.sm.ghost', {
      icon: 'plus', iconSize: 16, text: 'إضافة مرحلة', style: { marginTop: '7px' },
      onclick: () => { steps.push({ name: 'مرحلة جديدة', role_key: 'finance', permission: 'finance.approve_finance' }); paint(); }
    }));
  };
  paint();

  const m = modal({
    title: w ? 'تعديل مسار الاعتماد' : 'مسار اعتماد جديد',
    body: el('div', {}, [
      field('اسم المسار', name, { required: true }), field('نوع المستند', docType),
      el('h4', { style: { fontSize: '13px', margin: '14px 0 8px' }, text: 'مراحل الاعتماد بالترتيب' }),
      stepsBox
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ المسار', onclick: async (e) => {
        if (!name.value.trim() || !steps.length) return toast('اسم المسار وخطوة واحدة على الأقل إلزاميان', 'warn');
        e.target.disabled = true;
        const payload = { name: name.value.trim(), doc_type: docType.value, steps };
        try {
          if (w) await api.patch(`/api/finance/workflows/${w.id}`, payload);
          else await api.post('/api/finance/workflows', payload);
          toast('تم حفظ المسار', 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}
