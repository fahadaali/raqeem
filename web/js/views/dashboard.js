import api from '../api.js';
import { state, can, currentTermObj, termIsArchived } from '../state.js';
import { el, card, stat, chip, empty, table, progressBar, AR_NUM, counted, pct, money, timeAgo, T, avatar } from '../util.js';
import { icon as luIcon } from '../icons.js';
import { fmtDate } from '../hijri.js';

export async function render({ navigate }) {
  const d = await api.get('/api/dashboard');
  /* صندوق الاعتمادات يُقرأ عدده هنا: ما ينتظر قراراً يسبق كل رقم على الشاشة.
     وسقوطه لا يُسقط اللوحة — من لا يعتمد شيئاً لا يرى السطر أصلاً. */
  const approvals = can('finance.view', 'finance.approve_supervisor', 'finance.approve_finance',
    'finance.manage', 'hr.leaves.approve')
    ? await api.get('/api/approvals', { silent: true }).catch(() => null)
    : null;
  /* بطاقة التجهيز: لمن يملك إعدادات الجهة وحده، وما دامت خطواتها ناقصة */
  const setup = can('settings.manage')
    ? await api.get('/api/setup', { silent: true }).catch(() => null)
    : null;
  const cal = state.calendar;
  const wrap = el('div.stack');
  const term = currentTermObj();

  if (termIsArchived()) {
    wrap.append(el('div.archived-bar', {}, [
      el('span.ic', { icon: 'lock', iconSize: 16 }),
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
        el('span', { style: { margin: '0 6px', opacity: '.5' }, text: '·' }),
        el('span', { text: fmtDate(new Date(), cal) })
      ])
    ]),
    term ? chip(`الفصل: ${term.name}`, term.status === 'open' ? 'brand' : 'warn') : null,
    can('hr.attendance.self') ? el('button.btn.gold', { icon: 'map-pin', iconSize: 16, text: 'تسجيل الحضور', onclick: () => navigate('/checkin') }) : null
  ])]));

  /*
   * تجهيز الجهة الجديدة — يسبق كل شيء ما دام ناقصاً.
   *
   * الجهة تُنشأ فتفتح على لوحةٍ كلُّها أصفار، فلا تدلّ على خطوةٍ تُبتدأ. وهذه
   * البطاقة تحلّ محلّها: خطواتها تُحتسب من البيانات نفسها لا من علامةٍ تُحفَظ،
   * فمن أضاف فرعاً من شاشة الفروع يجدها منجزةً هنا دون أن يعلّمها.
   */
  if (setup?.show) {
    const total = setup.steps.length;
    const done = total - setup.remaining;
    const DASH = 170;   /* محيط دائرة نصف قطرها ٢٧ */
    const left = setup.remaining;
    const leftAr = counted(left, { one: 'خطوة واحدة', two: 'خطوتان', few: 'خطوات', many: 'خطوة' });

    const dismiss = async (e) => {
      e.currentTarget.disabled = true;
      await api.post('/api/setup/dismiss', {}).catch(() => {});
      e.currentTarget.closest('.setup-card')?.remove();
    };

    wrap.append(el('div.card.setup-card', {}, [
      el('div.setup-head', {}, [
        el('div.setup-ring', {}, [
          el('div', { html:
            `<svg width="64" height="64" viewBox="0 0 64 64" style="transform:rotate(-90deg)">
               <circle cx="32" cy="32" r="27" fill="none" stroke="var(--border)" stroke-width="6"></circle>
               <circle cx="32" cy="32" r="27" fill="none" stroke="var(--primary)" stroke-width="6"
                 stroke-linecap="round" stroke-dasharray="${DASH}"
                 stroke-dashoffset="${DASH - (DASH * done) / total}"></circle>
             </svg>` }),
          el('span.setup-pct', { text: '٪' + AR_NUM(Math.round((done / total) * 100)) })
        ]),
        el('div', { style: { flex: '1', minWidth: '180px' } }, [
          el('h3', { text: 'لنجهّز مجمّعك' }),
          el('p.hint', { text: `بقيت ${leftAr} · تستغرق دقائق، وتوقف حيث شئت وتُكمل لاحقاً.` })
        ]),
        el('button.btn.sm.ghost', { text: 'أخفِ هذا', onclick: dismiss })
      ]),
      el('div.setup-steps', {}, setup.steps.map((st, i) => {
        /* الخطوة التالية وحدها تأخذ المشمشي — إجراءٌ رئيسي واحد في الشاشة */
        const isNext = !st.done && setup.steps.slice(0, i).every(x => x.done);
        return el('div.setup-step' + (st.done ? '.done' : '') + (isNext ? '.now' : ''), {}, [
          el('span.dot', st.done
            ? { icon: 'check', iconSize: 16 }
            : { text: AR_NUM(i + 1) }),
          el('div.tx', {}, [el('b', { text: st.title }), el('span', { text: st.why })]),
          st.done ? null : el('button.btn.sm' + (isNext ? '.gold' : '.ghost'),
            { text: st.cta, onclick: () => navigate(st.url) })
        ]);
      }))
    ]));
  }

  /*
   * ما يحتاج انتباهك — الإضافة الجوهرية.
   *
   * كانت اللوحة تفتح على ثمانية أرقام متساوية: تُقرأ ولا يُعمَل بها، ولا تقول
   * أيُّها يستدعي تصرّفاً اليوم. هذا الشريط يسبقها ويحمل ما ينتظر المستخدم
   * فعلاً، ولكلّ سطرٍ زرٌّ يقود إلى موضع الإجراء لا إلى شاشةٍ عامة.
   * ولا يُبنى إلا ممّا تعيده اللوحة أصلاً — لا استعلام جديد سوى عدّاد الاعتمادات.
   */
  const alerts = [];
  if (approvals?.counts.total) {
    alerts.push({
      icon: 'inbox', tone: 'warn',
      title: counted(approvals.counts.total, {
        one: 'طلب ينتظر قرارك',   two:  'طلبان ينتظران قرارك',
        few: 'طلبات تنتظر قرارك', many: 'طلباً ينتظر قرارك'
      }),
      sub: approvals.items[0]
        ? `أقدمها: ${approvals.items[0].title}`
        : '', cta: 'افتح الصندوق', primary: true, go: () => navigate('/approvals')
    });
  }
  if (d.overdue) {
    alerts.push({
      icon: 'alarm-clock', tone: 'danger',
      title: counted(d.overdue, {
        one: 'مهمة تجاوزت تاريخ استحقاقها',  two:  'مهمتان تجاوزتا تاريخ استحقاقها',
        few: 'مهام تجاوزت تاريخ استحقاقها', many: 'مهمة تجاوزت تاريخ استحقاقها'
      }),
      sub: 'تحتاج إعادة جدولة أو إغلاقاً', cta: 'راجعها',
      go: () => navigate('/tasks?overdue=1')
    });
  }
  if (d.tickets_sla_breached && can('tickets.view_all')) {
    alerts.push({
      icon: 'siren', tone: 'info',
      title: counted(d.tickets_sla_breached, {
        one: 'تذكرة تجاوزت مدة الاستجابة',  two:  'تذكرتان تجاوزتا مدة الاستجابة',
        few: 'تذاكر تجاوزت مدة الاستجابة', many: 'تذكرة تجاوزت مدة الاستجابة'
      }),
      sub: 'اتفاقية مستوى الخدمة', cta: 'افتحها', go: () => navigate('/tickets')
    });
  }

  const WASH = { danger: 'var(--clay)', warn: 'var(--mint-2)', info: 'var(--sky)' };
  const TONE = { danger: 'var(--error)', warn: 'var(--review-ink)', info: 'var(--info)' };

  wrap.append(el('section.focus', {}, [
    el('div.focus-row', {}, [
      el('span.ic', { icon: 'bell-ring', iconSize: 22 }),
      el('h3', { text: 'ما يحتاج انتباهك' })
    ]),
    alerts.length
      ? el('div.focus-grid', {}, alerts.map(a => el('div.alert-card', {}, [
          el('span.mark', { icon: a.icon, iconSize: 20,
            style: { background: WASH[a.tone], color: TONE[a.tone] } }),
          el('div.tx', {}, [el('b', { text: a.title }), a.sub ? el('span', { text: a.sub }) : null]),
          el('button.btn.sm' + (a.primary ? '.gold' : '.ghost'), { text: a.cta, onclick: a.go })
        ])))
      : el('div.alert-card.clear', {}, [
          el('span.mark', { icon: 'circle-check', iconSize: 20,
            style: { background: 'var(--surface)', color: 'var(--primary)' } }),
          el('div.tx', {}, [
            el('b', { text: 'لا شيء ينتظرك — كل شيء في موعده' }),
            el('span', { text: 'تصفّح مؤشراتك أدناه، أو راجع مهام الفصل.' })
          ])
        ])
  ]));

  // البطاقات الإحصائية
  const cards = el('div.grid.g4');
  cards.append(
    stat('مهامي المفتوحة', AR_NUM(d.my_open_tasks), { icon: 'clipboard-list', kind: 'brand', hint: 'مهام مسندة إليك ولم تكتمل', onclick: () => navigate('/tasks?mine=1') }),
    stat('إجمالي المهام', AR_NUM(d.tasks_total), {
      icon: 'folder-kanban', hint: `أُنجز منها ${AR_NUM(d.tasks?.done || 0)}`, onclick: () => navigate('/tasks')
    }),
    stat('مهام متأخرة', AR_NUM(d.overdue), { icon: 'alarm-clock', kind: d.overdue ? 'danger' : 'ok', hint: 'تجاوزت تاريخ الاستحقاق', onclick: () => navigate('/tasks?overdue=1') })
  );
  if (can('finance.view')) {
    const pending = (d.finance.pending?.count || 0) + (d.finance.in_review?.count || 0);
    cards.append(stat('طلبات بانتظار الاعتماد', AR_NUM(pending), {
      icon: 'banknote', kind: pending ? 'gold' : '', hint: money((d.finance.pending?.total || 0) + (d.finance.in_review?.total || 0)) + ' ر.س',
      onclick: () => navigate('/finance')
    }));
  }
  if (can('hr.attendance.view')) {
    const a = d.attendance_today || {};
    /* الغياب والتأخير يُذكران حين يقعان — و«٠ غياب» ليس خبراً يُقال.
       ولا سجلّ أصلاً ≠ حضورٌ مكتمل: الصفر هنا يعني أنّ اليوم لم يُرصد بعد. */
    const logged = (a.present || 0) + (a.late || 0) + (a.absent || 0);
    const gaps = [
      a.absent && counted(a.absent, { one: 'غائب واحد', two: 'غائبان', few: 'غائبين', many: 'غائباً' }),
      a.late   && counted(a.late,   { one: 'متأخر واحد', two: 'متأخران', few: 'متأخرين', many: 'متأخراً' })
    ].filter(Boolean);
    cards.append(stat('الحضور اليوم', logged ? AR_NUM((a.present || 0) + (a.late || 0)) : '—', {
      icon: 'user-check', kind: logged ? 'ok' : '',
      hint: !logged ? 'لم يُرصد حضور اليوم بعد'
        : gaps.length ? gaps.join(' · ') : 'حضورٌ مكتمل بلا غياب',
      onclick: () => navigate('/hr')
    }));
  }
  if (can('tickets.view_all')) {
    cards.append(stat('تذاكر مفتوحة', AR_NUM((d.tickets.open || 0) + (d.tickets.in_progress || 0)), {
      icon: 'headset', kind: d.tickets_sla_breached ? 'danger' : 'info',
      hint: d.tickets_sla_breached
        ? counted(d.tickets_sla_breached, { one: 'تذكرة تجاوزت المدة', two: 'تذكرتان تجاوزتا المدة', few: 'تذاكر تجاوزت المدة', many: 'تذكرة تجاوزت المدة' })
        : 'ضمن اتفاقية الخدمة',
      onclick: () => navigate('/tickets')
    }));
  }
  /*
   * العهد المفتوحة: مالٌ خرج ولم يُثبَت إنفاقه بعد.
   *
   * أخطرُ من طلبٍ ينتظر اعتماداً — ذاك لم يُصرَف، وهذا صُرِف ولا يُعرَف أين ذهب.
   * فيُعرَض عدده ومجموعه، وما رُفع بيانه ينتظر اعتماد إغلاقه.
   */
  if (can('finance.view') && d.custody?.open) {
    cards.append(stat('عهد مفتوحة', AR_NUM(d.custody.open), {
      icon: 'wallet-minimal', kind: d.custody.open ? 'gold' : '',
      hint: d.custody.awaiting
        ? `${money(d.custody.total)} ر.س · ${counted(d.custody.awaiting, {
            one: 'بيانٌ ينتظر الاعتماد', two: 'بيانان ينتظران الاعتماد',
            few: 'بيانات تنتظر الاعتماد', many: 'بياناً ينتظر الاعتماد' })}`
        : `${money(d.custody.total)} ر.س لم يُثبَت إنفاقها`,
      onclick: () => navigate('/finance')
    }));
  }
  if (can('budgets.view') && d.budgets?.total) {
    const used = Math.round(d.budgets.spent * 100 / d.budgets.total);
    cards.append(stat('استهلاك الميزانية', pct(used), {
      icon: 'database', kind: used > 85 ? 'danger' : 'ok',
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
            /* درجة العجلة نقطةٌ ملوّنة بأيقونة واحدة — اللون يحمل المعنى لا الشكل */
            el('span.ic.prio', { icon: 'circle', iconSize: 12, class: 'prio-' + t.priority }),
            el('div.t', {}, [t.title, el('small', { text: `${t.assignee_name || 'غير مُسند'} · يستحق ${fmtDate(t.due_date, cal, 'short')}` })]),
            chip(T.taskStatus[t.status], T.taskStatusChip[t.status])
          ])))
      : empty('circle-check', 'لا توجد مهام قادمة', 'كل المهام في موعدها.'))
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
