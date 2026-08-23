import api from '../api.js';
import { state, can } from '../state.js';
import {
  el, clear, card, chip, empty, table, toast, modal, field, input, textarea, select,
  tabs, AR_NUM, pct, avatar, progressBar, confirmDialog, skeleton, qs
} from '../util.js';
import { fmtDate, todayISO } from '../hijri.js';

const TYPES = [
  { type: 'text', label: 'نص قصير', icon: 'pen-line' },
  { type: 'textarea', label: 'نص طويل', icon: 'file-text' },
  { type: 'number', label: 'رقم', icon: 'hash' },
  { type: 'date', label: 'تاريخ', icon: 'calendar-days' },
  { type: 'select', label: 'قائمة اختيار', icon: 'chevron-down' },
  { type: 'multiselect', label: 'اختيار متعدد', icon: 'list-checks' },
  { type: 'checkbox', label: 'مربع تأكيد', icon: 'square-check' },
  { type: 'rating', label: 'تقييم بالنجوم', icon: 'star' },
  { type: 'section', label: 'عنوان قسم', icon: 'minus' }
];

export async function render() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const forms = await api.get('/api/forms');
    clear(body).append(forms.length ? el('div.grid.g3', {}, forms.map(f => formCard(f, load)))
      : empty('file-pen-line', 'لا توجد نماذج', 'ابنِ نموذج تقييم أو استبانة بالسحب والإفلات دون برمجة.'));
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div', {}, [el('h3', { text: 'النماذج والتقييمات' }),
        el('div.hint', { text: 'صمّم نماذجك بالسحب والإفلات — تُحفظ بنيتها بصيغة JSON مرنة تسمح بعدد لا نهائي من النماذج.' })]),
      can('forms.manage') ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'نموذج جديد', onclick: () => builder(null, load) }) : null
    ])]),
    body
  ]);
}

function formCard(f, reload) {
  return el('div.card', {}, [el('div.card-body', {}, [
    el('div.row.between', {}, [
      el('h4', { text: f.title }),
      chip({ evaluation: 'تقييم', survey: 'استبانة', form: 'نموذج' }[f.type] || f.type, 'brand')
    ]),
    el('p', { text: f.description || '', style: { fontSize: '12.5px', color: 'var(--text-2)', minHeight: '20px', margin: '6px 0 10px' } }),
    el('div.row', { style: { fontSize: '11.5px', color: 'var(--text-3)' } }, [
      chip(`${AR_NUM(f.schema.fields.length)} حقل`),
      chip(`${AR_NUM(f.submissions_count)} إجابة`, f.submissions_count ? 'ok' : ''),
      f.is_active ? null : chip('معطّل', 'warn')
    ]),
    el('div.row', { style: { marginTop: '11px' } }, [
      can('forms.submit') && f.is_active ? el('button.btn.sm', { icon: 'pen-line', iconSize: 16, text: 'تعبئة', onclick: () => fill(f, reload) }) : null,
      can('forms.results') ? el('button.btn.sm.ghost', { icon: 'chart-column', iconSize: 16, text: 'النتائج', onclick: () => results(f) }) : null,
      can('forms.manage') ? el('button.btn.sm.ghost', { icon: 'pencil', iconSize: 16, title: 'تعديل', 'aria-label': 'تعديل', onclick: () => builder(f, reload) }) : null
    ])
  ])]);
}

/* ═══════════ منشئ النماذج المرئي (Drag & Drop) ═══════════ */
function builder(form, reload) {
  let fields = form ? JSON.parse(JSON.stringify(form.schema.fields)) : [];
  let selected = null;

  const title = input({ value: form?.title || '', placeholder: 'عنوان النموذج', required: true });
  const desc = input({ value: form?.description || '', placeholder: 'وصف مختصر' });
  const type = select([{ value: 'evaluation', label: 'تقييم' }, { value: 'survey', label: 'استبانة' }, { value: 'form', label: 'نموذج عام' }], { value: form?.type || 'evaluation' });

  const palette = el('div.palette', {}, TYPES.map(t => {
    const item = el('div.palette-item', { draggable: true, onclick: () => addField(t.type) }, [
      el('span', { text: t.icon }), el('span', { text: t.label })
    ]);
    item.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'new:' + t.type));
    return item;
  }));

  const canvas = el('div.canvas');
  const props = el('div.card', {}, [el('div.card-body#props', {}, [el('div.hint', { text: 'اختر حقلاً لتعديل خصائصه' })])]);

  const uid = () => 'f' + Math.random().toString(36).slice(2, 8);
  function addField(t, index) {
    const f = { id: uid(), type: t, label: TYPES.find(x => x.type === t).label, required: false };
    if (['select', 'multiselect'].includes(t)) f.options = ['الخيار الأول', 'الخيار الثاني'];
    if (t === 'rating') { f.max = 5; f.weight = 10; }
    if (index === undefined) fields.push(f); else fields.splice(index, 0, f);
    selected = f.id; paint();
  }

  function paint() {
    clear(canvas);
    if (!fields.length) canvas.append(el('div.empty', {}, [el('span.ic', { icon: 'mouse-pointer-click', iconSize: 'card' }),
      el('h4', { text: 'اسحب الحقول هنا' }), el('p', { text: 'أو اضغط على أي نوع حقل من القائمة لإضافته.' })]));
    fields.forEach((f, i) => {
      const node = el('div.fld' + (selected === f.id ? '.sel' : ''), {
        draggable: true, dataset: { i }, onclick: () => { selected = f.id; paint(); }
      }, [
        el('button.del', { icon: 'x', iconSize: 16, 'aria-label': 'حذف الحقل', onclick: (e) => { e.stopPropagation(); fields.splice(i, 1); selected = null; paint(); } }),
        el('div.t', {}, [
          el('span.ic', { icon: TYPES.find(t => t.type === f.type)?.icon || 'pen-line', iconSize: 16 }),
          f.label, f.required ? el('span', { text: ' *', style: { color: 'var(--danger)' } }) : null
        ]),
        el('div.m', { text: `${TYPES.find(t => t.type === f.type)?.label}${f.weight ? ` · وزن ${f.weight}` : ''}${f.options ? ` · ${f.options.length} خيارات` : ''}` })
      ]);
      node.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'move:' + i));
      node.addEventListener('dragover', (e) => e.preventDefault());
      node.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        const data = e.dataTransfer.getData('text/plain');
        if (data.startsWith('new:')) addField(data.slice(4), i);
        else { const from = Number(data.slice(5)); const [m] = fields.splice(from, 1); fields.splice(i, 0, m); paint(); }
      });
      canvas.append(node);
    });
    paintProps();
  }

  canvas.addEventListener('dragover', (e) => { e.preventDefault(); canvas.classList.add('over'); });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('over'));
  canvas.addEventListener('drop', (e) => {
    e.preventDefault(); canvas.classList.remove('over');
    const data = e.dataTransfer.getData('text/plain');
    if (data.startsWith('new:')) addField(data.slice(4));
  });

  function paintProps() {
    const holder = qs('#props', props);
    clear(holder);
    const f = fields.find(x => x.id === selected);
    if (!f) return holder.append(el('div.hint', { text: 'اختر حقلاً لتعديل خصائصه' }));
    const lab = input({ value: f.label, oninput: (e) => { f.label = e.target.value; paint(); } });
    holder.append(el('h4', { style: { fontSize: '13px', marginBottom: '10px' }, text: 'خصائص الحقل' }), field('العنوان', lab));
    if (f.type !== 'section') {
      const req = el('input', { type: 'checkbox', checked: f.required, onchange: (e) => { f.required = e.target.checked; paint(); } });
      holder.append(el('label.check-row', {}, [req, el('div.t', { text: 'حقل إلزامي' })]));
      const w = input({ type: 'number', min: 0, max: 100, value: f.weight || 0, oninput: (e) => { f.weight = Number(e.target.value); paint(); } });
      holder.append(field('الوزن في التقييم', w, { hint: 'صفر يعني أن الحقل لا يدخل في احتساب الدرجة' }));
    }
    if (f.type === 'rating') {
      const mx = input({ type: 'number', min: 2, max: 10, value: f.max || 5, oninput: (e) => { f.max = Number(e.target.value); } });
      holder.append(field('عدد النجوم', mx));
    }
    if (['select', 'multiselect'].includes(f.type)) {
      const opts = textarea({ value: (f.options || []).join('\n'), oninput: (e) => { f.options = e.target.value.split('\n').filter(Boolean); paint(); } });
      holder.append(field('الخيارات (سطر لكل خيار)', opts));
    }
  }

  paint();
  const m = modal({
    title: form ? 'تعديل النموذج' : 'منشئ النماذج المرئي', size: 'wide',
    body: el('div', {}, [
      el('div.grid.g3', {}, [field('عنوان النموذج', title, { required: true }), field('الوصف', desc), field('النوع', type)]),
      el('div.builder', {}, [
        el('div', {}, [el('h4', { style: { fontSize: '12px', marginBottom: '8px', color: 'var(--text-3)' }, text: 'الحقول المتاحة' }), palette]),
        el('div', {}, [el('h4', { style: { fontSize: '12px', marginBottom: '8px', color: 'var(--text-3)' }, text: 'مساحة التصميم' }), canvas]),
        props
      ])
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ النموذج', onclick: async (e) => {
        if (!title.value.trim()) return toast('عنوان النموذج إلزامي', 'warn');
        if (!fields.length) return toast('أضف حقلاً واحداً على الأقل', 'warn');
        e.target.disabled = true;
        const payload = { title: title.value.trim(), description: desc.value, type: type.value, schema: { fields } };
        try {
          if (form) await api.patch(`/api/forms/${form.id}`, payload);
          else await api.post('/api/forms', payload);
          toast('تم حفظ النموذج', 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ تعبئة النموذج ═══════════ */
async function fill(form, reload) {
  const users = await api.get('/api/org/users').catch(() => []);
  const answers = {};
  const body = el('div');
  const subject = form.type === 'evaluation'
    ? select([{ value: '', label: '— اختر الشخص المُقيَّم —' }, ...users.map(u => ({ value: u.id, label: `${u.name} (${u.role_name})` }))])
    : null;
  if (subject) body.append(field('الشخص المُقيَّم', subject, { required: true }));

  for (const f of form.schema.fields) {
    if (f.type === 'section') { body.append(el('h4', { text: f.label, style: { margin: '16px 0 8px', fontSize: '14px', color: 'var(--brand)' } })); continue; }
    let ctrl;
    if (f.type === 'textarea') ctrl = textarea({ oninput: (e) => { answers[f.id] = e.target.value; } });
    else if (f.type === 'select') ctrl = select([{ value: '', label: '— اختر —' }, ...(f.options || []).map(o => ({ value: o, label: o }))], { onchange: (e) => { answers[f.id] = e.target.value; } });
    else if (f.type === 'multiselect') {
      ctrl = el('div', {}, (f.options || []).map(o => el('label.check-row', {}, [
        el('input', { type: 'checkbox', value: o, onchange: () => {
          answers[f.id] = [...ctrl.querySelectorAll('input:checked')].map(i => i.value);
        } }), el('div.t', { text: o })])));
    }
    else if (f.type === 'checkbox') {
      ctrl = el('label.check-row', {}, [el('input', { type: 'checkbox', onchange: (e) => { answers[f.id] = e.target.checked; } }), el('div.t', { text: 'نعم' })]);
    }
    else if (f.type === 'rating') {
      const stars = el('div.row', { style: { gap: '5px' } });
      for (let i = 1; i <= (f.max || 5); i++) {
        stars.append(el('button.star-btn', {
          type: 'button', icon: 'star', iconSize: 26, dataset: { v: i },
          'aria-label': `تقييم ${i}`,
          onclick: () => {
            answers[f.id] = i;
            /* النجمة الممتلئة = نفس أيقونة لوسايد بتعبئة `currentColor` */
            [...stars.children].forEach((b, k) => b.classList.toggle('filled', k < i));
          }
        }));
      }
      ctrl = stars;
    }
    else ctrl = input({ type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text', oninput: (e) => { answers[f.id] = e.target.value; } });
    body.append(field(f.label, ctrl, { required: f.required, hint: f.weight ? `الوزن في التقييم: ${f.weight}` : '' }));
  }

  const m = modal({
    title: form.title, body, size: 'wide',
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'إرسال', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api.post(`/api/forms/${form.id}/submit`, { answers, subject_user_id: subject?.value || null });
          toast(r.score !== null ? `تم الإرسال — النتيجة ${r.score} من ${r.max_score}` : 'تم إرسال النموذج بنجاح', 'ok');
          m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ نتائج النموذج ═══════════ */
async function results(form) {
  const { submissions, form: f } = await api.get(`/api/forms/${form.id}/submissions`);
  const scored = submissions.filter(s => s.score !== null);
  const avg = scored.length ? (scored.reduce((a, s) => a + (s.score / s.max_score) * 100, 0) / scored.length) : null;

  modal({
    title: `نتائج: ${form.title}`, size: 'wide',
    body: el('div.stack', {}, [
      el('div.grid.g3', {}, [
        el('div.stat', {}, [el('div.label', { text: 'عدد الإجابات' }), el('div.value', { text: AR_NUM(submissions.length) })]),
        el('div.stat.gold', {}, [el('div.label', { text: 'متوسط النتيجة' }), el('div.value', { text: avg !== null ? pct(avg) : '—' })]),
        el('div.stat.ok', {}, [el('div.label', { text: 'أعلى نتيجة' }), el('div.value', { text: scored.length ? pct(Math.max(...scored.map(s => Math.round(s.score / s.max_score * 100)))) : '—' })])
      ]),
      table([
        { header: 'المُقيَّم', key: 'subject_name', render: r => r.subject_name || '—' },
        { header: 'المُقيِّم', key: 'submitted_by_name' },
        { header: 'الفرع', key: 'branch_name' },
        { header: 'التاريخ', key: 'submitted_at', render: r => fmtDate(r.submitted_at, state.calendar, 'short') },
        { header: 'النتيجة', key: 'score', render: r => r.score === null ? '—'
            : el('div.row', { style: { gap: '8px', flexWrap: 'nowrap', minWidth: '120px' } }, [
                progressBar(Math.round(r.score / r.max_score * 100), r.score / r.max_score >= 0.7 ? 'ok' : 'gold'),
                el('b', { text: `${r.score}/${r.max_score}`, style: { fontSize: '11.5px' } })]) },
        { header: '', key: 'a', render: r => el('button.btn.sm.ghost', { text: 'عرض', onclick: () => showAnswers(f, r) }) }
      ], submissions, { emptyText: 'لا توجد إجابات بعد' })
    ])
  });
}

function showAnswers(form, sub) {
  modal({
    title: 'تفاصيل الإجابة', size: 'narrow',
    body: el('div.stack', { style: { gap: '4px' } }, form.schema.fields.filter(f => f.type !== 'section').map(f => {
      let v = sub.answers[f.id];
      if (Array.isArray(v)) v = v.join('، ');
      if (typeof v === 'boolean') v = v ? 'نعم' : 'لا';
      if (f.type === 'rating' && v) v = `${AR_NUM(v)} / ${AR_NUM(f.max || 5)}`;
      return el('div', { style: { padding: '7px 0', borderBottom: '1px solid var(--border)' } }, [
        el('div', { style: { fontSize: '11.5px', color: 'var(--text-3)' }, text: f.label }),
        el('div', { style: { fontSize: '13px', fontWeight: '600' }, text: v ?? '—' })
      ]);
    }))
  });
}
