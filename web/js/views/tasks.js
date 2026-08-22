import api from '../api.js';
import { state, can, activeTerm, termIsArchived, currentTermObj } from '../state.js';
import {
  el, clear, card, chip, empty, table, progressBar, toast, modal, drawer, confirmDialog,
  field, input, textarea, select, T, avatar, AR_NUM, pct, debounce, timeAgo, qs
} from '../util.js';
import { fmtDate, todayISO, addDaysISO, daysBetween } from '../hijri.js';

const STATUSES = ['todo', 'in_progress', 'review', 'done', 'blocked'];
let view = localStorage.getItem('noor_tasks_view') || 'kanban';
let filters = {};
let cacheUsers = null, cacheCommittees = null;

async function users() { if (!cacheUsers) cacheUsers = await api.get('/api/org/users').catch(() => []); return cacheUsers; }
async function committees() { if (!cacheCommittees) cacheCommittees = await api.get('/api/tasks/committees').catch(() => []); return cacheCommittees; }

export async function render({ route, navigate }) {
  filters = { ...route.query };
  const locked = termIsArchived();
  const wrap = el('div.stack');

  if (locked) wrap.append(el('div.archived-bar', {}, [el('span', { text: '🔒' }),
    `الفصل «${currentTermObj()?.name}» مؤرشف — العرض للقراءة فقط.`]));

  const body = el('div');
  const toolbar = await buildToolbar(() => paint(body, navigate), navigate, locked);
  wrap.append(toolbar, body);
  await paint(body, navigate);

  if (route.query.id) setTimeout(() => openTask(Number(route.query.id), () => paint(body, navigate)), 60);
  return wrap;
}

async function buildToolbar(reload, navigate, locked) {
  const [us, cs] = await Promise.all([users(), committees()]);
  const search = input({ placeholder: '🔍 بحث في المهام...', value: filters.q || '', style: { maxWidth: '210px' } });
  search.addEventListener('input', debounce((e) => { filters.q = e.target.value; reload(); }, 340));

  const viewBtns = el('div.btn-group', {}, [
    ['kanban', '▦ كانبان'], ['table', '☰ جدول'], ['gantt', '📊 جانت']
  ].map(([k, label]) => el('button', {
    text: label, class: view === k ? 'active' : '',
    onclick: (e) => {
      view = k; localStorage.setItem('noor_tasks_view', k);
      [...e.target.parentNode.children].forEach(b => b.classList.remove('active'));
      e.target.classList.add('active'); reload();
    }
  })));

  return card(null, [el('div.row', {}, [
    viewBtns,
    search,
    select([{ value: '', label: 'كل اللجان' }, ...cs.map(c => ({ value: c.id, label: c.name }))],
      { value: filters.committee_id || '', style: { maxWidth: '160px' },
        onchange: (e) => { filters.committee_id = e.target.value; reload(); } }),
    select([{ value: '', label: 'كل المكلّفين' }, ...us.map(u => ({ value: u.id, label: u.name }))],
      { value: filters.assignee_id || '', style: { maxWidth: '170px' },
        onchange: (e) => { filters.assignee_id = e.target.value; reload(); } }),
    select([{ value: '', label: 'كل الأولويات' }, ...Object.entries(T.priority).map(([v, l]) => ({ value: v, label: l }))],
      { value: filters.priority || '', style: { maxWidth: '130px' },
        onchange: (e) => { filters.priority = e.target.value; reload(); } }),
    el('button.btn.sm.ghost', {
      text: filters.mine === '1' ? '✔ مهامي فقط' : 'مهامي فقط',
      onclick: (e) => { filters.mine = filters.mine === '1' ? '' : '1'; e.target.textContent = filters.mine ? '✔ مهامي فقط' : 'مهامي فقط'; reload(); }
    }),
    el('div', { style: { flex: '1' } }),
    can('templates.view') ? el('button.btn.sm.ghost', { text: '📚 مكتبة القوالب', onclick: () => openTemplates(reload) }) : null,
    can('tasks.create') && !locked ? el('button.btn.sm', { text: '＋ مهمة جديدة', onclick: () => openTaskForm(null, reload) }) : null
  ])]);
}

async function fetchTasks() {
  const q = { ...filters };
  if (activeTerm()) q.term_id = activeTerm();
  return api.get('/api/tasks' + api.qs(q));
}

async function paint(container, navigate) {
  clear(container).append(el('div.skeleton', { style: { height: '160px' } }));
  const tasks = await fetchTasks();
  clear(container);
  if (view === 'kanban') container.append(kanban(tasks, () => paint(container, navigate)));
  else if (view === 'gantt') container.append(await gantt(() => paint(container, navigate)));
  else container.append(tableView(tasks, () => paint(container, navigate)));
}

/* ═════════ لوحة كانبان بالسحب والإفلات ═════════ */
function kanban(tasks, reload) {
  const locked = termIsArchived();
  const board = el('div.kanban');
  for (const st of STATUSES) {
    const items = tasks.filter(t => t.status === st);
    const bodyEl = el('div.kcol-body', { dataset: { status: st } });
    const col = el('div.kcol', {}, [
      el('div.kcol-head', {}, [
        el('span', { text: { todo: '⚪', in_progress: '🔵', review: '🟡', done: '🟢', blocked: '🔴' }[st] }),
        T.taskStatus[st], el('span.n', { text: AR_NUM(items.length) })
      ]),
      bodyEl
    ]);

    for (const t of items) bodyEl.append(taskCard(t, reload, locked));

    if (!locked && can('tasks.update')) {
      bodyEl.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      bodyEl.addEventListener('dragleave', () => col.classList.remove('over'));
      bodyEl.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('over');
        const id = Number(e.dataTransfer.getData('text/plain'));
        const task = tasks.find(x => x.id === id);
        if (!task || task.status === st) return;
        try {
          await api.patch(`/api/tasks/${id}`, { status: st, progress: st === 'done' ? 100 : undefined });
          toast(`نُقلت «${task.title}» إلى ${T.taskStatus[st]}`, 'ok');
          reload();
        } catch { reload(); }
      });
    }
    board.append(col);
  }
  return tasks.length ? board : empty('📋', 'لا توجد مهام مطابقة', 'جرّب تغيير عوامل التصفية أو أنشئ مهمة جديدة.');
}

function taskCard(t, reload, locked) {
  const node = el('div.kcard', {
    draggable: !locked && can('tasks.update'),
    style: { borderInlineStartColor: t.committee_color || 'var(--brand)' },
    onclick: () => openTask(t.id, reload)
  }, [
    el('h5', { text: t.title }),
    el('div.meta', {}, [
      t.assignee_name ? avatar(t.assignee_name, 'sm') : null,
      t.assignee_name ? el('span', { text: t.assignee_name.split('—').pop().trim() }) : chip('غير مُسند', 'warn'),
    ]),
    el('div.meta', { style: { marginTop: '7px' } }, [
      chip(T.priority[t.priority], T.priorityChip[t.priority]),
      t.due_date ? chip((t.is_overdue ? '⏰ ' : '📅 ') + fmtDate(t.due_date, state.calendar, 'short'), t.is_overdue ? 'danger' : '') : null,
      t.comments_count ? chip(`💬 ${AR_NUM(t.comments_count)}`) : null,
      t.committee_name ? chip(t.committee_name, 'brand') : null
    ]),
    t.progress > 0 && t.progress < 100 ? el('div', { style: { marginTop: '8px' } }, [progressBar(t.progress)]) : null
  ]);
  node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(t.id)); node.classList.add('dragging'); });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
  return node;
}

/* ═════════ عرض الجدول (تعديل سريع كالإكسل) ═════════ */
function tableView(tasks, reload) {
  const locked = termIsArchived();
  const editable = !locked && can('tasks.update');
  return card(null, table([
    { header: 'المهمة', key: 'title', render: (t) => {
        const cell = el('div', { style: { minWidth: '180px' } }, [
          el('div', { text: t.title, style: { fontWeight: '600', cursor: editable ? 'text' : 'pointer' },
            contenteditable: editable ? 'true' : null,
            onblur: async (e) => {
              const v = e.target.textContent.trim();
              if (v && v !== t.title) { await api.patch(`/api/tasks/${t.id}`, { title: v }); toast('تم حفظ العنوان', 'ok'); t.title = v; }
              else e.target.textContent = t.title;
            },
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } } }),
          t.committee_name ? el('small', { text: t.committee_name, style: { color: 'var(--text-3)', fontSize: '11px' } }) : null
        ]);
        return cell;
      } },
    { header: 'المكلّف', key: 'assignee_name', render: (t) => t.assignee_name
        ? el('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [avatar(t.assignee_name, 'sm'), el('span', { text: t.assignee_name.split('—').pop().trim(), style: { fontSize: '12px' } })])
        : chip('غير مُسند', 'warn') },
    { header: 'الحالة', key: 'status', render: (t) => editable
        ? select(STATUSES.map(s => ({ value: s, label: T.taskStatus[s] })), {
            value: t.status, style: { minWidth: '118px', padding: '5px 8px', minHeight: '30px', fontSize: '12px' },
            onchange: async (e) => { await api.patch(`/api/tasks/${t.id}`, { status: e.target.value }); toast('تم تحديث الحالة', 'ok'); reload(); }
          })
        : chip(T.taskStatus[t.status], T.taskStatusChip[t.status]) },
    { header: 'الأولوية', key: 'priority', render: (t) => chip(T.priority[t.priority], T.priorityChip[t.priority]) },
    { header: 'الاستحقاق', key: 'due_date', render: (t) => t.due_date
        ? el('span', { text: fmtDate(t.due_date, state.calendar, 'short'), style: { color: t.is_overdue ? 'var(--danger)' : '', fontWeight: t.is_overdue ? '600' : '' } })
        : '—' },
    { header: 'الإنجاز', key: 'progress', render: (t) => el('div.row', { style: { gap: '7px', flexWrap: 'nowrap', minWidth: '110px' } }, [
        progressBar(t.progress, t.progress === 100 ? 'ok' : ''), el('span', { text: pct(t.progress), style: { fontSize: '11px' } })]) },
    { header: '', key: 'act', render: (t) => el('button.btn.sm.ghost', { text: 'تفاصيل', onclick: (e) => { e.stopPropagation(); openTask(t.id, reload); } }) }
  ], tasks, { cls: 'editable', emptyText: 'لا توجد مهام مطابقة' }), { p0: true });
}

/* ═════════ مخطط جانت مع الاعتماديات ═════════ */
async function gantt(reload) {
  const q = { ...filters };
  if (activeTerm()) q.term_id = activeTerm();
  const { items } = await api.get('/api/tasks/view/gantt' + api.qs(q));
  if (!items.length) return empty('📊', 'لا توجد مهام لها تواريخ', 'أضف تواريخ بداية ونهاية للمهام لعرضها على المخطط.');

  const starts = items.map(i => new Date(i.start).getTime());
  const ends = items.map(i => new Date(i.end).getTime());
  let min = new Date(Math.min(...starts)), max = new Date(Math.max(...ends));
  min = new Date(min.getTime() - 2 * 86400000); max = new Date(max.getTime() + 2 * 86400000);
  const total = Math.max(1, Math.round((max - min) / 86400000));
  const today = todayISO();

  const days = el('div.gantt-days');
  for (let i = 0; i < total; i++) {
    const d = new Date(min.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    days.append(el('div.gantt-day' + ([5, 6].includes(dow) ? '.we' : '') + (iso === today ? '.today' : ''),
      { text: String(d.getUTCDate()), title: fmtDate(iso, state.calendar) }));
  }

  const inner = el('div.gantt-inner', {}, [
    el('div.gantt-head', {}, [el('div.gantt-label', { text: 'المهمة' }), days])
  ]);

  const rowIndex = {};
  items.forEach((it, idx) => {
    rowIndex[it.id] = idx;
    const s = Math.max(0, Math.round((new Date(it.start) - min) / 86400000));
    const e = Math.max(s + 1, Math.round((new Date(it.end) - min) / 86400000) + 1);
    const left = (s / total) * 100, width = ((e - s) / total) * 100;
    inner.append(el('div.gantt-row', {}, [
      el('div.gantt-label', { text: it.title, title: it.title }),
      el('div.gantt-track', {}, [
        el('div.gantt-bar', {
          style: { insetInlineStart: left + '%', width: width + '%', background: it.color },
          title: `${it.title}\n${fmtDate(it.start, state.calendar, 'short')} ← ${fmtDate(it.end, state.calendar, 'short')}\nالإنجاز: ${it.progress}٪`,
          onclick: () => openTask(it.id, reload)
        }, [
          el('div.fill', { style: { width: it.progress + '%' } }),
          el('span', { text: `${it.title.slice(0, 26)}${it.title.length > 26 ? '…' : ''} · ${pct(it.progress)}` })
        ])
      ])
    ]));
  });

  const legend = el('div.row', { style: { marginTop: '10px', fontSize: '11.5px', color: 'var(--text-3)' } }, [
    el('span', { text: '💡 اسحب أفقياً لاستعراض المدة الزمنية · اضغط أي شريط لعرض تفاصيل المهمة' }),
    items.some(i => i.depends_on?.length) ? chip(`${AR_NUM(items.filter(i => i.depends_on?.length).length)} مهمة مرتبطة باعتماديات`, 'info') : null
  ]);
  return el('div', {}, [el('div.gantt', {}, [inner]), legend]);
}

/* ═════════ نافذة تفاصيل المهمة + المحادثة السياقية ═════════ */
export async function openTask(id, reload) {
  const t = await api.get(`/api/tasks/${id}`).catch(() => null);
  if (!t) return toast('المهمة غير موجودة', 'err');
  const locked = ['closed', 'archived'].includes(t.term_status) || t.is_locked;
  const body = el('div.stack');

  body.append(el('div', {}, [
    el('h3', { text: t.title, style: { marginBottom: '7px' } }),
    el('div.row', {}, [
      chip(T.taskStatus[t.status], T.taskStatusChip[t.status]),
      chip(T.priority[t.priority], T.priorityChip[t.priority]),
      t.due_date ? chip('📅 ' + fmtDate(t.due_date, state.calendar), t.is_overdue ? 'danger' : '') : null,
      locked ? chip('🔒 فصل مؤرشف', 'warn') : null
    ]),
    t.description ? el('p', { text: t.description, style: { color: 'var(--text-2)', fontSize: '13px', marginTop: '10px', whiteSpace: 'pre-wrap' } }) : null
  ]));

  if (!locked && can('tasks.update')) {
    const st = select(STATUSES.map(s => ({ value: s, label: T.taskStatus[s] })), { value: t.status });
    const pr = input({ type: 'range', min: 0, max: 100, step: 5, value: t.progress, style: { padding: '0' } });
    const prLabel = el('span', { text: pct(t.progress), style: { fontWeight: '700', minWidth: '42px' } });
    pr.addEventListener('input', () => { prLabel.textContent = pct(pr.value); });
    body.append(card('تحديث سريع', [
      field('الحالة', st),
      field('نسبة الإنجاز', el('div.row', { style: { flexWrap: 'nowrap' } }, [pr, prLabel])),
      el('button.btn.block', {
        text: 'حفظ التحديث',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.patch(`/api/tasks/${t.id}`, { status: st.value, progress: Number(pr.value) });
            toast('تم حفظ التحديث', 'ok'); reload?.();
          } finally { e.target.disabled = false; }
        }
      })
    ]));
  }

  if (can('chat.use')) body.append(card('💬 المحادثة السياقية', [await chatBox('task', t.id)], { sub: 'مقصورة على المرتبطين بهذه المهمة' }));

  const footer = [];
  if (!locked && can('tasks.update')) footer.push(el('button.btn.ghost', { text: '✏️ تعديل كامل', onclick: () => { d.close(); openTaskForm(t, reload); } }));
  if (!locked && can('tasks.delete')) footer.push(el('button.btn.danger', {
    text: '🗑 حذف', onclick: async () => {
      if (!await confirmDialog(`سيتم حذف المهمة «${t.title}» نهائياً.`, { danger: true, confirmText: 'حذف' })) return;
      await api.del(`/api/tasks/${t.id}`); toast('تم حذف المهمة', 'ok'); d.close(); reload?.();
    }
  }));

  const d = drawer({ title: 'تفاصيل المهمة', body, footer: footer.length ? footer : null });
  return d;
}

/* ═════════ صندوق المحادثة السياقية ═════════ */
export async function chatBox(contextType, contextId) {
  const list = el('div.chat-body');
  const box = el('div.chat', {}, [list]);
  const inp = input({ placeholder: 'اكتب رسالتك...', style: { border: 'none' } });
  const send = async () => {
    const v = inp.value.trim(); if (!v) return;
    inp.value = ''; inp.disabled = true;
    try {
      const m = await api.post(`/api/comms/conversations/${contextType}/${contextId}/messages`, { body: v });
      list.append(bubble(m)); list.scrollTop = list.scrollHeight;
    } catch { inp.value = v; }
    finally { inp.disabled = false; inp.focus(); }
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  box.append(el('div.chat-input', {}, [inp, el('button.btn.sm', { text: '➤', onclick: send })]));

  const bubble = (m) => el('div.msg' + (m.mine ? '.mine' : ''), {}, [
    m.mine ? null : el('div.who', { text: m.user_name }),
    el('div', { text: m.body, style: { whiteSpace: 'pre-wrap' } }),
    el('div.at', { text: timeAgo(m.created_at) })
  ]);

  try {
    const data = await api.get(`/api/comms/conversations/${contextType}/${contextId}/messages`);
    if (!data.messages.length) list.append(el('div.empty', { style: { padding: '26px' } }, [
      el('span.ic', { text: '💬' }), el('h4', { text: 'لا توجد رسائل بعد' }), el('p', { text: 'ابدأ المحادثة مع فريق العمل.' })]));
    for (const m of data.messages) list.append(bubble(m));
    setTimeout(() => { list.scrollTop = list.scrollHeight; }, 30);
    const seen = new Set(data.messages.map(m => m.id));
    const onMsg = (e) => {
      if (e.detail?.message && e.detail.conversationId === data.conversation.id) {
        seen.add(e.detail.message.id);
        list.append(bubble({ ...e.detail.message, mine: false }));
        list.scrollTop = list.scrollHeight;
      }
    };
    window.addEventListener('noor:chat', onMsg);

    /* في وضع الاستطلاع الدوري (بلا قناة دائمة) نجلب الجديد بأنفسنا */
    const onPoll = async () => {
      if (!box.isConnected) return window.removeEventListener('noor:poll', onPoll);
      try {
        const fresh = await api.get(`/api/comms/conversations/${contextType}/${contextId}/messages`, { silent: true });
        let added = false;
        for (const m of fresh.messages) if (!seen.has(m.id)) { seen.add(m.id); list.append(bubble(m)); added = true; }
        if (added) list.scrollTop = list.scrollHeight;
      } catch { /* دون اتصال */ }
    };
    window.addEventListener('noor:poll', onPoll);
  } catch (e) {
    clear(list).append(el('div.empty', { style: { padding: '22px' } }, [el('p', { text: e.message })]));
    box.querySelector('.chat-input')?.remove();
  }
  return box;
}

/* ═════════ نموذج إنشاء/تعديل مهمة ═════════ */
export async function openTaskForm(task, reload) {
  const [us, cs] = await Promise.all([users(), committees()]);
  const title = input({ value: task?.title || '', placeholder: 'عنوان المهمة', required: true });
  const desc = textarea({ value: task?.description || '', placeholder: 'وصف تفصيلي للمهمة والمطلوب إنجازه...' });
  const assignee = select([{ value: '', label: '— غير مُسند —' }, ...us.map(u => ({ value: u.id, label: `${u.name} (${u.role_name})` }))], { value: task?.assignee_id || '' });
  const committee = select([{ value: '', label: '— بدون لجنة —' }, ...cs.map(c => ({ value: c.id, label: c.name }))], { value: task?.committee_id || '' });
  const branch = select([{ value: '', label: '— الفرع الافتراضي —' }, ...(state.session.branches).map(b => ({ value: b.id, label: b.name }))], { value: task?.branch_id || '' });
  const priority = select(Object.entries(T.priority).map(([v, l]) => ({ value: v, label: l })), { value: task?.priority || 'medium' });
  const status = select(STATUSES.map(s => ({ value: s, label: T.taskStatus[s] })), { value: task?.status || 'todo' });
  const start = input({ type: 'date', value: task?.start_date || todayISO() });
  const due = input({ type: 'date', value: task?.due_date || addDaysISO(todayISO(), 7) });
  const weight = input({ type: 'number', min: 1, max: 10, value: task?.weight || 1 });

  const body = el('div', {}, [
    field('عنوان المهمة', title, { required: true }),
    field('الوصف', desc),
    el('div.grid.g2', {}, [field('المكلّف', assignee), field('اللجنة', committee)]),
    el('div.grid.g2', {}, [field('الفرع', branch), field('الأولوية', priority)]),
    el('div.grid.g2', {}, [field('تاريخ البداية', start), field('تاريخ الاستحقاق', due)]),
    el('div.grid.g2', {}, [field('الحالة', status), field('الوزن النسبي', weight, { hint: 'يؤثر على احتساب مؤشر الأداء' })])
  ]);

  const save = async (e) => {
    if (!title.value.trim()) return toast('عنوان المهمة إلزامي', 'warn');
    e.target.disabled = true;
    const payload = {
      title: title.value.trim(), description: desc.value, assignee_id: assignee.value || null,
      committee_id: committee.value || null, branch_id: branch.value || null,
      priority: priority.value, status: status.value, start_date: start.value || null,
      due_date: due.value || null, weight: Number(weight.value) || 1
    };
    try {
      if (task) await api.patch(`/api/tasks/${task.id}`, payload);
      else await api.post('/api/tasks', payload);
      toast(task ? 'تم تحديث المهمة' : 'تم إنشاء المهمة بنجاح', 'ok');
      m.close(); reload?.();
    } finally { e.target.disabled = false; }
  };

  const m = modal({
    title: task ? 'تعديل المهمة' : 'مهمة جديدة', body,
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
             el('button.btn', { text: task ? 'حفظ التعديلات' : 'إنشاء المهمة', onclick: save })]
  });
}

/* ═════════ مكتبة قوالب المهام ═════════ */
async function openTemplates(reload) {
  const list = await api.get('/api/tasks/templates');
  const cs = await committees();
  const body = el('div.stack');
  if (!list.length) body.append(empty('📚', 'لا توجد قوالب', 'أنشئ قوالب جاهزة لتسريع إعداد مهام كل فصل.'));

  for (const tpl of list) {
    body.append(el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [
        el('div', {}, [
          el('h4', { text: tpl.name }),
          el('div', { style: { fontSize: '12px', color: 'var(--text-2)' }, text: tpl.description || '' })
        ]),
        chip(tpl.category || 'عام', 'brand')
      ]),
      el('div.stack', { style: { gap: '4px', marginTop: '10px' } }, tpl.items.slice(0, 5).map(it =>
        el('div', { style: { fontSize: '12px', color: 'var(--text-2)' }, text: `• ${it.title} (${it.duration_days || 3} أيام)` }))),
      tpl.items.length > 5 ? el('div.hint', { text: `+ ${AR_NUM(tpl.items.length - 5)} مهمة أخرى` }) : null,
      can('tasks.create') && !termIsArchived() ? el('div.row.end', { style: { marginTop: '11px' } }, [
        el('button.btn.sm', { text: `اعتماد القالب (${AR_NUM(tpl.items.length)} مهمة)`, onclick: () => applyTemplate(tpl, cs, m, reload) })
      ]) : null
    ])]));
  }
  const m = modal({ title: '📚 مكتبة قوالب المهام', body, size: 'wide' });
}

async function applyTemplate(tpl, cs, parent, reload) {
  const us = await users();
  const committee = select([{ value: '', label: '— بدون لجنة —' }, ...cs.map(c => ({ value: c.id, label: c.name }))]);
  const start = input({ type: 'date', value: todayISO() });
  const rows = tpl.items.map((it, i) => {
    const assignee = select([{ value: '', label: '— غير مُسند —' }, ...us.map(u => ({ value: u.id, label: u.name }))],
      { style: { minWidth: '150px', minHeight: '32px', padding: '4px 8px', fontSize: '12px' } });
    return { it, assignee, node: el('div.check-row', { style: { cursor: 'default' } }, [
      el('input', { type: 'checkbox', checked: true, dataset: { i } }),
      el('div.t', {}, [it.title, el('small', { text: `يبدأ بعد ${it.offset_days || 0} يوم · مدة ${it.duration_days || 3} أيام` })]),
      assignee
    ]) };
  });

  const body = el('div', {}, [
    el('p', { style: { marginTop: 0, fontSize: '13px', color: 'var(--text-2)' },
      text: `سيقوم النظام باستنساخ القالب إلى مهام فعلية في الفصل الحالي «${currentTermObj()?.name || ''}» — يمكنك تعديلها قبل الاعتماد.` }),
    el('div.grid.g2', {}, [field('اللجنة', committee), field('تاريخ بداية الخطة', start)]),
    el('h4', { style: { fontSize: '13px', margin: '12px 0 8px' }, text: 'المهام المشمولة وتوزيعها' }),
    ...rows.map(r => r.node)
  ]);

  const m2 = modal({
    title: `اعتماد القالب: ${tpl.name}`, body, size: 'wide',
    footer: [
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => m2.close() }),
      el('button.btn', { text: 'إنشاء المهام', onclick: async (e) => {
        e.target.disabled = true;
        const items = rows.filter(r => r.node.querySelector('input').checked)
          .map(r => ({ ...r.it, assignee_id: r.assignee.value || null }));
        if (!items.length) { e.target.disabled = false; return toast('اختر مهمة واحدة على الأقل', 'warn'); }
        try {
          const res = await api.post(`/api/tasks/templates/${tpl.id}/apply`, {
            committee_id: committee.value || null, start_date: start.value, items
          });
          toast(`تم إنشاء ${AR_NUM(res.created)} مهمة من القالب`, 'ok');
          m2.close(); parent.close(); reload?.();
        } finally { e.target.disabled = false; }
      } })
    ]
  });
}
