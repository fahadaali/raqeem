import api from '../api.js';
import { state } from '../state.js';
import { el, clear, card, chip, empty, table, toast, modal, select, AR_NUM, skeleton, qs } from '../util.js';
import { fmtDateTime } from '../hijri.js';

export async function render() {
  const types = await api.get('/api/imports/types');
  const wrap = el('div.stack');
  const history = el('div');

  const loadHistory = async () => {
    clear(history).append(skeleton(3));
    const rows = await api.get('/api/imports');
    clear(history).append(card('سجل عمليات الاستيراد', table([
      { header: 'النوع', key: 'type', render: r => types.find(t => t.key === r.type)?.label || r.type },
      { header: 'الملف', key: 'file_name' },
      { header: 'الصفوف', key: 'total_rows', num: true, render: r => AR_NUM(r.total_rows) },
      { header: 'ناجحة', key: 'ok_rows', num: true, render: r => chip(AR_NUM(r.ok_rows), 'ok') },
      { header: 'أخطاء', key: 'error_rows', num: true, render: r => r.error_rows ? chip(AR_NUM(r.error_rows), 'danger') : '—' },
      { header: 'الحالة', key: 'status', render: r => chip(
          { queued: 'في الانتظار', running: 'قيد المعالجة', done: 'مكتملة', failed: 'فشلت' }[r.status],
          { queued: 'warn', running: 'info', done: 'ok', failed: 'danger' }[r.status]) },
      { header: 'بواسطة', key: 'created_by_name' },
      { header: 'التاريخ', key: 'created_at', render: r => fmtDateTime(r.created_at, state.calendar) },
      { header: '', key: 'a', render: r => r.errors?.length
          ? el('button.btn.sm.ghost', { text: 'عرض الأخطاء', onclick: () => showErrors(r.errors) }) : '—' }
    ], rows, { emptyText: 'لم تُنفّذ أي عملية استيراد بعد' }), { p0: true }));
  };

  wrap.append(
    card(null, [el('div', {}, [el('h3', { text: 'استيراد البيانات الأولية' }),
      el('div.hint', { text: 'ارفع ملفات Excel أو CSV لإدخال بيانات الموظفين والفروع والعهد دفعة واحدة — مع فحص آلي وتقرير أخطاء مرئي قبل الاعتماد.' })])]),
    el('div.grid.g3', {}, types.map(t => el('div.card', {}, [el('div.card-body', {}, [
      el('h4', { text: t.label }),
      el('p', { text: t.description, style: { fontSize: '12.5px', color: 'var(--text-2)', margin: '6px 0 10px', minHeight: '38px' } }),
      el('div.row', {}, [
        el('button.btn.sm', { text: '📤 استيراد', onclick: () => wizard(t, loadHistory) }),
        el('a.btn.sm.ghost', { href: `/api/imports/template/${t.key}`, text: '⬇ قالب Excel', download: '' })
      ])
    ])]))),
    history
  );
  await loadHistory();
  return wrap;
}

function showErrors(errors) {
  modal({
    title: `تقرير الأخطاء (${AR_NUM(errors.length)})`, size: 'wide',
    body: table([
      { header: 'رقم الصف', key: 'row', num: true },
      { header: 'الحقل', key: 'field' },
      { header: 'القيمة', key: 'value' },
      { header: 'سبب الرفض', key: 'message' }
    ], errors)
  });
}

function wizard(type, reload) {
  let file = null, validation = null;
  const fileInput = el('input', { type: 'file', accept: '.xlsx,.csv,.tsv,text/csv', hidden: true });
  const drop = el('div.file-drop', { onclick: () => fileInput.click() }, [
    el('span.ic', { text: '📄' }),
    el('div', { text: 'اسحب ملف Excel أو CSV هنا، أو اضغط للاختيار' }),
    el('div.hint', { text: 'يجب أن تطابق ترويسة الملف أعمدة القالب' })
  ]);
  const info = el('div');
  const preview = el('div');
  const runBtn = el('button.btn', { text: 'تنفيذ الاستيراد', disabled: true });

  const handle = async (f) => {
    if (!f) return;
    file = f;
    clear(drop).append(el('span.ic', { text: '✅' }), el('div', { text: f.name }),
      el('div.hint', { text: `${(f.size / 1024).toFixed(1)} كيلوبايت — جارٍ الفحص...` }));
    const fd = new FormData(); fd.append('type', type.key); fd.append('file', f);
    try {
      validation = await api.post('/api/imports/validate', fd);
      renderValidation();
    } catch (e) { clear(info).append(el('div.archived-bar', {}, [el('span', { text: '⚠️' }), e.message])); }
  };

  function renderValidation() {
    const v = validation;
    runBtn.disabled = !v.valid_rows.length;
    clear(info).append(el('div.grid.g3', {}, [
      el('div.stat', {}, [el('div.label', { text: 'إجمالي الصفوف' }), el('div.value', { text: AR_NUM(v.total) })]),
      el('div.stat.ok', {}, [el('div.label', { text: 'صفوف صالحة' }), el('div.value', { text: AR_NUM(v.valid_rows.length) })]),
      el('div.stat.danger', {}, [el('div.label', { text: 'صفوف مرفوضة' }), el('div.value', { text: AR_NUM(v.errors.length) })])
    ]));
    clear(preview);
    if (v.errors.length) preview.append(card('❌ تقرير الأخطاء المرئي', table([
      { header: 'الصف', key: 'row', num: true },
      { header: 'الحقل', key: 'field' },
      { header: 'القيمة', key: 'value' },
      { header: 'سبب الرفض', key: 'message' }
    ], v.errors.slice(0, 60)), { p0: true, sub: 'صحّح هذه الصفوف في الملف وأعد رفعه — الصفوف الصالحة يمكن استيرادها الآن' }));
    if (v.preview?.length) preview.append(card('✅ معاينة الصفوف الصالحة', table(
      v.columns.map(c => ({ header: c.header, key: c.key })), v.preview), { p0: true }));
  }

  fileInput.addEventListener('change', (e) => handle(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); });

  runBtn.onclick = async () => {
    runBtn.disabled = true;
    const fd = new FormData(); fd.append('type', type.key); fd.append('file', file);
    try {
      const r = await api.post('/api/imports/run', fd);
      toast(`جارٍ استيراد ${AR_NUM(r.queued)} سجل في الخلفية${r.skipped ? ` (تم تخطي ${AR_NUM(r.skipped)})` : ''}`, 'ok', '📥 بدأ الاستيراد');
      m.close();
      setTimeout(reload, 3000);
      setTimeout(reload, 8000);
    } finally { runBtn.disabled = false; }
  };

  const m = modal({
    title: `استيراد: ${type.label}`, size: 'wide',
    body: el('div.stack', {}, [
      card('الأعمدة المطلوبة', el('div.row', {}, type.columns.map(c =>
        chip(c.header + (c.required ? ' *' : ''), c.required ? 'brand' : '')))
        , { sub: 'الحقول المعلّمة بنجمة إلزامية' }),
      drop, fileInput, info, preview
    ]),
    footer: [
      el('a.btn.ghost', { href: `/api/imports/template/${type.key}`, text: '⬇ تنزيل القالب', download: '' }),
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      runBtn
    ]
  });
}
