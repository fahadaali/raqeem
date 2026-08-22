import api from '../api.js';
import { state, can, currentTermObj, termIsArchived } from '../state.js';
import { el, card, stat, chip, empty, table, progressBar, AR_NUM, pct, money, timeAgo, T, avatar } from '../util.js';
import { fmtDate } from '../hijri.js';

export async function render({ navigate }) {
  const d = await api.get('/api/dashboard');
  const cal = state.calendar;
  const wrap = el('div.stack');
  const term = currentTermObj();

  if (termIsArchived()) {
    wrap.append(el('div.archived-bar', {}, [
      el('span', { text: '🔒' }),
      `أنت تستعرض الفصل «${term?.name}» وهو مؤرشف ومغلق للقراءة فقط — لا يمكن إجراء أي تعديل على بياناته.`
    ]));
  }

  // ترحيب
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'صباح الخير' : hour < 17 ? 'مساء الخير' : 'مساء الخير';
  wrap.append(el('div.card', {}, [el('div.card-body', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } }, [
    avatar(state.session.user.name, 'lg'),
    el('div', { style: { flex: '1', minWidth: '190px' } }, [
      el('h3', { text: `${greet}، ${state.session.user.name.split('—').pop().trim()}` }),
      el('div', { style: { color: 'var(--text-2)', fontSize: '12.5px' } }, [
        el('span', { text: state.session.user.role.name }),
        el('span', { style: { margin: '0 6px', opacity: '.5' }, text: '•' }),
        el('span', { text: fmtDate(new Date(), cal) })
      ])
    ]),
    term ? chip(`الفصل: ${term.name}`, term.status === 'open' ? 'brand' : 'warn') : null,
    can('hr.attendance.self') ? el('button.btn.gold', { text: '📍 تسجيل الحضور', onclick: () => navigate('/checkin') }) : null
  ])]));

  // البطاقات الإحصائية
  const cards = el('div.grid.g4');
  cards.append(
    stat('مهامي المفتوحة', AR_NUM(d.my_open_tasks), { icon: '📋', kind: 'brand', hint: 'مهام مسندة إليك ولم تكتمل', onclick: () => navigate('/tasks?mine=1') }),
    stat('إجمالي المهام', AR_NUM(d.tasks_total), {
      icon: '🗂️', hint: `${AR_NUM(d.tasks?.done || 0)} مكتملة`, onclick: () => navigate('/tasks')
    }),
    stat('مهام متأخرة', AR_NUM(d.overdue), { icon: '⏰', kind: d.overdue ? 'danger' : 'ok', hint: 'تجاوزت تاريخ الاستحقاق', onclick: () => navigate('/tasks?overdue=1') })
  );
  if (can('finance.view')) {
    const pending = (d.finance.pending?.count || 0) + (d.finance.in_review?.count || 0);
    cards.append(stat('طلبات بانتظار الاعتماد', AR_NUM(pending), {
      icon: '💰', kind: pending ? 'gold' : '', hint: money((d.finance.pending?.total || 0) + (d.finance.in_review?.total || 0)) + ' ر.س',
      onclick: () => navigate('/finance')
    }));
  }
  if (can('hr.attendance.view')) {
    const a = d.attendance_today || {};
    cards.append(stat('الحضور اليوم', AR_NUM((a.present || 0) + (a.late || 0)), {
      icon: '🕌', kind: 'ok', hint: `${AR_NUM(a.absent || 0)} غياب · ${AR_NUM(a.late || 0)} تأخير`, onclick: () => navigate('/hr')
    }));
  }
  if (can('tickets.view_all')) {
    cards.append(stat('تذاكر مفتوحة', AR_NUM((d.tickets.open || 0) + (d.tickets.in_progress || 0)), {
      icon: '🎧', kind: d.tickets_sla_breached ? 'danger' : 'info',
      hint: d.tickets_sla_breached ? `${AR_NUM(d.tickets_sla_breached)} تجاوزت مدة الخدمة` : 'ضمن اتفاقية الخدمة',
      onclick: () => navigate('/tickets')
    }));
  }
  if (can('budgets.view') && d.budgets?.total) {
    const used = Math.round(d.budgets.spent * 100 / d.budgets.total);
    cards.append(stat('استهلاك الميزانية', pct(used), {
      icon: '📊', kind: used > 85 ? 'danger' : 'ok',
      hint: `${money(d.budgets.spent)} من ${money(d.budgets.total)} ر.س`, onclick: () => navigate('/finance')
    }));
  }
  wrap.append(cards);

  // توزيع حالات المهام
  const statusOrder = ['todo', 'in_progress', 'review', 'done', 'blocked'];
  const maxVal = Math.max(1, ...statusOrder.map(s => d.tasks[s] || 0));
  wrap.append(el('div.grid.g2', {}, [
    card('توزيع حالات المهام', [
      el('div.bars', {}, statusOrder.map(s => el('div.bar-col', {}, [
        el('div.bar', {
          style: { height: Math.round(((d.tasks[s] || 0) / maxVal) * 100) + '%',
            background: { todo: 'var(--text-3)', in_progress: 'var(--info)', review: 'var(--warn)', done: 'var(--ok)', blocked: 'var(--danger)' }[s] }
        }, [el('span', { text: AR_NUM(d.tasks[s] || 0) })]),
        el('div.lb', { text: T.taskStatus[s] })
      ])))
    ], { sub: term?.name || '' }),

    card('المهام القادمة', d.upcoming_tasks.length
      ? el('div.stack', { style: { gap: '8px' } }, d.upcoming_tasks.map(t =>
          el('div.check-row', { onclick: () => navigate(`/tasks?id=${t.id}`) }, [
            el('span', { text: { urgent: '🔴', high: '🟠', medium: '🔵', low: '⚪' }[t.priority] }),
            el('div.t', {}, [t.title, el('small', { text: `${t.assignee_name || 'غير مُسند'} · يستحق ${fmtDate(t.due_date, cal, 'short')}` })]),
            chip(T.taskStatus[t.status], T.taskStatusChip[t.status])
          ])))
      : empty('✅', 'لا توجد مهام قادمة', 'كل المهام في موعدها.'))
  ]));

  // مقارنة الفروع (لوحة القيادة العليا)
  if (d.branches.length > 1) {
    wrap.append(card('أداء الفروع — لوحة مجمّعة', table([
      { header: 'الفرع', key: 'name' },
      { header: 'المنسوبون', key: 'staff', num: true, render: r => AR_NUM(r.staff) },
      { header: 'المهام', key: 'tasks', num: true, render: r => AR_NUM(r.tasks) },
      { header: 'نسبة الإنجاز', key: 'pct', render: r => {
          const p = r.tasks ? Math.round(r.tasks_done * 100 / r.tasks) : 0;
          return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '120px' } }, [
            progressBar(p, p >= 70 ? 'ok' : p >= 40 ? 'gold' : 'danger'),
            el('span', { style: { fontSize: '11.5px', minWidth: '36px' }, text: pct(p) })
          ]);
        } },
      ...(can('finance.view') ? [{ header: 'المعتمد مالياً (ر.س)', key: 'spent', num: true, render: r => money(r.spent) }] : [])
    ], d.branches, { emptyText: 'لا توجد فروع' }), { p0: true }));
  }

  // آخر النشاطات
  if (can('audit.view') && d.recent_activity.length) {
    wrap.append(card('آخر النشاطات على المنصة',
      el('div.stack', { style: { gap: '7px' } }, d.recent_activity.map(a =>
        el('div.check-row', { style: { cursor: 'default' } }, [
          chip(T.audit[a.action] || a.action, { create: 'ok', update: 'info', delete: 'danger', approve: 'ok', reject: 'danger', login: '', export: 'gold' }[a.action] || ''),
          el('div.t', {}, [a.summary, el('small', { text: `${a.user_name} · ${timeAgo(a.created_at)}` })])
        ]))),
      { actions: el('button.btn.sm.ghost', { text: 'السجل الكامل', onclick: () => navigate('/audit') }) }));
  }

  return wrap;
}
