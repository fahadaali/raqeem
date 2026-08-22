import api from '../api.js';
import { can, termIsArchived } from '../state.js';
import { el, card, chip, empty, toast, modal, field, input, textarea, select, progressBar, AR_NUM, avatar, confirmDialog } from '../util.js';
import { chatBox } from './tasks.js';

export async function render({ navigate }) {
  const wrap = el('div.stack');
  const body = el('div');
  const reload = async () => {
    const list = await api.get('/api/tasks/committees');
    const users = await api.get('/api/org/users').catch(() => []);
    body.replaceChildren(list.length ? grid(list, users, reload, navigate)
      : empty('🧑‍🤝‍🧑', 'لا توجد لجان في هذا الفصل', 'أنشئ لجاناً ووزّع عليها المهام لمتابعة الإنجاز.'));
  };

  wrap.append(card(null, [el('div.row.between', {}, [
    el('div', {}, [el('h3', { text: 'اللجان العاملة' }),
      el('div.hint', { text: 'كل لجنة ترتبط بفرع وفصل دراسي، وتُقاس بنسبة إنجاز مهامها.' })]),
    can('committees.manage') && !termIsArchived()
      ? el('button.btn.sm', { text: '＋ لجنة جديدة', onclick: () => openForm(null, reload) }) : null
  ])]), body);
  await reload();
  return wrap;
}

function grid(list, users, reload, navigate) {
  return el('div.grid.g3', {}, list.map(c => {
    const pct = c.tasks_count ? Math.round(c.tasks_done * 100 / c.tasks_count) : 0;
    return el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [
        el('div.row', { style: { gap: '8px', flexWrap: 'nowrap' } }, [
          el('span', { style: { width: '11px', height: '11px', borderRadius: '50%', background: c.color, flex: '0 0 auto' } }),
          el('h4', { text: c.name })
        ]),
        c.branch_name ? chip(c.branch_name) : null
      ]),
      el('p', { text: c.description || '', style: { fontSize: '12.5px', color: 'var(--text-2)', margin: '7px 0 11px', minHeight: '20px' } }),
      el('div.row', { style: { marginBottom: '9px' } }, [
        c.lead_name ? el('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [avatar(c.lead_name, 'sm'), el('span', { style: { fontSize: '12px' }, text: 'رئيس اللجنة: ' + c.lead_name.split('—').pop().trim() })]) : null
      ]),
      el('div.row', { style: { justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--text-2)' } }, [
        el('span', { text: `${AR_NUM(c.members_count)} عضو` }),
        el('span', { text: `${AR_NUM(c.tasks_done)} / ${AR_NUM(c.tasks_count)} مهمة` })
      ]),
      el('div', { style: { margin: '6px 0 12px' } }, [progressBar(pct, pct >= 70 ? 'ok' : pct >= 40 ? 'gold' : 'danger')]),
      el('div.row', {}, [
        el('button.btn.sm.ghost', { text: '📋 المهام', onclick: () => navigate(`/tasks?committee_id=${c.id}`) }),
        can('chat.use') ? el('button.btn.sm.ghost', { text: '💬 محادثة', onclick: () => openChat(c) }) : null,
        can('committees.manage') ? el('button.btn.sm.ghost', { text: '✏️', onclick: () => openForm(c, reload, users) }) : null
      ])
    ])]);
  }));
}

async function openChat(c) {
  const m = modal({ title: `محادثة لجنة: ${c.name}`, body: el('div', {}, [await chatBox('committee', c.id)]) });
}

async function openForm(c, reload, cachedUsers) {
  const users = cachedUsers || await api.get('/api/org/users').catch(() => []);
  const branches = (await api.get('/api/org/branches').catch(() => []));
  const name = input({ value: c?.name || '', required: true });
  const desc = textarea({ value: c?.description || '' });
  const branch = select([{ value: '', label: '— على مستوى المجمّع —' }, ...branches.map(b => ({ value: b.id, label: b.name }))], { value: c?.branch_id || '' });
  const lead = select([{ value: '', label: '— بدون رئيس —' }, ...users.map(u => ({ value: u.id, label: u.name }))], { value: c?.lead_user_id || '' });
  const color = input({ type: 'color', value: c?.color || '#0F5132', style: { height: '42px', padding: '4px' } });

  const memberIds = new Set((c?.members || []).map(m => m.user_id));
  const memberBox = el('div', { style: { maxHeight: '210px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '10px', padding: '7px' } },
    users.map(u => el('label.check-row', {}, [
      el('input', { type: 'checkbox', value: u.id, checked: memberIds.has(u.id) }),
      el('div.t', {}, [u.name, el('small', { text: u.role_name })])
    ])));

  const m = modal({
    title: c ? 'تعديل اللجنة' : 'لجنة جديدة',
    body: el('div', {}, [
      field('اسم اللجنة', name, { required: true }), field('الوصف', desc),
      el('div.grid.g2', {}, [field('الفرع', branch), field('رئيس اللجنة', lead)]),
      field('لون اللجنة', color),
      field('الأعضاء', memberBox)
    ]),
    footer: [
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ', onclick: async (e) => {
        if (!name.value.trim()) return toast('اسم اللجنة إلزامي', 'warn');
        e.target.disabled = true;
        const member_ids = [...memberBox.querySelectorAll('input:checked')].map(i => Number(i.value));
        const payload = { name: name.value.trim(), description: desc.value, branch_id: branch.value || null,
          lead_user_id: lead.value || null, color: color.value, member_ids };
        try {
          if (c) await api.patch(`/api/tasks/committees/${c.id}`, payload);
          else await api.post('/api/tasks/committees', payload);
          toast('تم الحفظ بنجاح', 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })
    ]
  });
}
