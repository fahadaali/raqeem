import api from '../api.js';
import { state, can, isRole } from '../state.js';
import {
  el, clear, card, chip, empty, table, toast, modal, field, input, textarea, select, tabs,
  T, AR_NUM, pct, money, avatar, clockOf, progressBar, confirmDialog, skeleton, qs
} from '../util.js';
import { fmtDate, todayISO, dayName, addDaysISO } from '../hijri.js';

export async function render({ sub, navigate }) {
  if (sub === 'checkin') return checkinScreen();
  const items = [];
  if (can('hr.attendance.self')) items.push({ label: '📍 حضوري', build: () => checkinScreen() });
  if (can('hr.attendance.view')) items.push({ label: '🗓 سجل الحضور', build: attendanceTab });
  if (can('hr.employees.view')) items.push({ label: '👥 ملفات الموظفين', build: employeesTab });
  items.push({ label: '🏖 الإجازات', build: leavesTab });
  if (can('hr.payroll.view')) items.push({ label: '💵 مسير الرواتب', build: payrollTab });
  const t = tabs(items, (it) => { const n = el('div'); Promise.resolve(it.build()).then(x => n.replaceChildren(x)); return n; });
  return t.node;
}

/* ═══════════ زر التحضير الذكي بالنطاق الجغرافي ═══════════ */
async function checkinScreen() {
  const wrap = el('div.stack');
  const box = el('div');
  wrap.append(box);

  const paint = async () => {
    clear(box).append(skeleton(4));
    const d = await api.get('/api/hr/attendance/today');
    const r = d.record;
    const action = d.next_action;
    const label = { check_in: 'تسجيل الحضور', check_out: 'تسجيل الانصراف', done: 'اكتمل اليوم' }[action];
    const cls = action === 'check_out' ? '.out' : action === 'done' ? '.done' : '';

    const mapBox = el('div.mini-map', {}, [
      el('div.fence', { style: { width: '132px', height: '132px' } }),
      el('div.br', { text: '🕌' }),
      el('div.lbl', { text: d.branch ? `${d.branch.name} · النطاق ${AR_NUM(d.geofence_radius)} م` : 'لم يُحدد فرع' })
    ]);
    const status = el('div', { style: { fontSize: '13px', color: 'var(--text-2)', minHeight: '22px' } });

    const btn = el('button.checkin-btn' + cls, { disabled: action === 'done' }, [
      el('span', { text: action === 'done' ? '✅' : action === 'check_out' ? '🏁' : '📍' }),
      el('span', { text: label }),
      el('small', { text: action === 'done' ? 'شكراً لجهودك' : 'اضغط للتسجيل' })
    ]);

    btn.onclick = async () => {
      if (!navigator.geolocation) return toast('جهازك لا يدعم تحديد الموقع', 'err');
      btn.disabled = true;
      status.textContent = '📡 جارٍ تحديد موقعك...';
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (d.branch?.lat) {
          const dx = (longitude - d.branch.lng) * 111000 * Math.cos(latitude * Math.PI / 180);
          const dy = (latitude - d.branch.lat) * 111000;
          const scale = 66 / Math.max(d.geofence_radius, 1);
          const me = mapBox.querySelector('.me') || el('div.me');
          me.style.left = `calc(50% + ${Math.max(-70, Math.min(70, dx * scale))}px)`;
          me.style.top = `calc(50% + ${Math.max(-70, Math.min(70, -dy * scale))}px)`;
          if (!me.parentNode) mapBox.append(me);
        }
        try {
          const res = await api.post('/api/hr/attendance/check', { lat: latitude, lng: longitude, accuracy });
          toast(res.message, 'ok', res.action === 'check_in' ? '✅ تم الحضور' : '🏁 تم الانصراف');
          paint();
        } catch (err) {
          status.textContent = err.message;
          btn.disabled = false;
        }
      }, (err) => {
        btn.disabled = false;
        status.textContent = err.code === 1
          ? '⛔ رفضت إذن الموقع — فعّله من إعدادات المتصفح لتتمكن من التحضير'
          : '⚠️ تعذّر تحديد موقعك، تأكد من تفعيل خدمة الموقع (GPS)';
        toast(status.textContent, 'err');
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    };

    clear(box).append(card(null, [
      el('div.checkin', {}, [
        el('div', {}, [
          el('h3', { text: dayName(d.date) }),
          el('div.hint', { text: fmtDate(d.date, state.calendar) })
        ]),
        btn, status, mapBox,
        el('div.row', { style: { justifyContent: 'center' } }, [
          r?.check_in_at ? chip('🟢 الحضور: ' + clockOf(r.check_in_at), 'ok') : chip('لم تسجّل الحضور بعد', 'warn'),
          r?.check_out_at ? chip('🔴 الانصراف: ' + clockOf(r.check_out_at), 'danger') : null,
          r?.status === 'late' ? chip('مسجّل كتأخير', 'warn') : null,
          r?.minutes_worked ? chip(`⏱ ${AR_NUM(Math.floor(r.minutes_worked / 60))}س ${AR_NUM(r.minutes_worked % 60)}د`, 'info') : null
        ]),
        el('div.hint', { style: { maxWidth: '380px' },
          text: `يتحقق النظام من موقعك بمعادلة هافرساين، ويقبل التسجيل فقط داخل نطاق ${AR_NUM(d.geofence_radius)} متراً من إحداثيات الفرع. دوام اليوم: ${d.workday.start} — ${d.workday.end}` })
      ])
    ]));

    const mine = await api.get('/api/hr/attendance' + api.qs({ user_id: state.session.user.id, limit: 14 })).catch(() => []);
    if (mine.length) box.append(card('سجلّي خلال الفترة الماضية', table([
      { header: 'التاريخ', key: 'date', render: r => fmtDate(r.date, state.calendar, 'short') },
      { header: 'اليوم', key: 'd', render: r => dayName(r.date) },
      { header: 'الحالة', key: 'status', render: r => chip(T.attendance[r.status], T.attendanceChip[r.status]) },
      { header: 'الحضور', key: 'in', render: r => clockOf(r.check_in_at) },
      { header: 'الانصراف', key: 'out', render: r => clockOf(r.check_out_at) },
      { header: 'الساعات', key: 'h', num: true, render: r => r.minutes_worked ? `${AR_NUM(Math.floor(r.minutes_worked / 60))}:${AR_NUM(r.minutes_worked % 60).padStart(2, '٠')}` : '—' }
    ], mine), { p0: true }));
  };
  await paint();
  return wrap;
}

/* ═══════════ سجل الحضور الإداري ═══════════ */
async function attendanceTab() {
  const from = input({ type: 'date', value: addDaysISO(todayISO(), -30) });
  const to = input({ type: 'date', value: todayISO() });
  const users = await api.get('/api/org/users').catch(() => []);
  const userSel = select([{ value: '', label: 'كل المنسوبين' }, ...users.map(u => ({ value: u.id, label: u.name }))]);
  const statusSel = select([{ value: '', label: 'كل الحالات' }, ...Object.entries(T.attendance).map(([v, l]) => ({ value: v, label: l }))]);
  const body = el('div');

  const load = async () => {
    clear(body).append(skeleton(5));
    const rows = await api.get('/api/hr/attendance' + api.qs({ from: from.value, to: to.value, user_id: userSel.value, status: statusSel.value, limit: 800 }));
    const by = rows.reduce((s, r) => { s[r.status] = (s[r.status] || 0) + 1; return s; }, {});
    clear(body).append(
      el('div.grid.g4', { style: { marginBottom: '14px' } }, Object.entries(T.attendance).map(([k, l]) =>
        el('div.stat.' + ({ present: 'ok', late: 'gold', absent: 'danger', leave: 'info' }[k]), {}, [
          el('div.label', { text: l }), el('div.value', { text: AR_NUM(by[k] || 0) })]))),
      card(null, table([
        { header: 'التاريخ', key: 'date', render: r => fmtDate(r.date, state.calendar, 'short') },
        { header: 'الموظف', key: 'user_name', render: r => el('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [avatar(r.user_name, 'sm'), el('span', { text: r.user_name, style: { fontSize: '12.5px' } })]) },
        { header: 'الرقم الوظيفي', key: 'employee_no' },
        { header: 'الفرع', key: 'branch_name' },
        { header: 'الحالة', key: 'status', render: r => chip(T.attendance[r.status], T.attendanceChip[r.status]) },
        { header: 'الحضور', key: 'in', render: r => clockOf(r.check_in_at) },
        { header: 'الانصراف', key: 'out', render: r => clockOf(r.check_out_at) },
        { header: 'المسافة', key: 'dist', num: true, render: r => r.in_distance != null ? `${AR_NUM(r.in_distance)} م` : '—' }
      ], rows, { emptyText: 'لا توجد سجلات ضمن الفترة المحددة' }), { p0: true })
    );
  };
  [from, to, userSel, statusSel].forEach(i => i.addEventListener('change', load));
  await load();

  return el('div.stack', {}, [
    card(null, [el('div.row', {}, [
      el('label.field', { style: { margin: 0 } }, [el('span', { text: 'من' }), from]),
      el('label.field', { style: { margin: 0 } }, [el('span', { text: 'إلى' }), to]),
      el('label.field', { style: { margin: 0, minWidth: '160px' } }, [el('span', { text: 'الموظف' }), userSel]),
      el('label.field', { style: { margin: 0, minWidth: '130px' } }, [el('span', { text: 'الحالة' }), statusSel])
    ])]),
    body
  ]);
}

/* ═══════════ ملفات الموظفين ═══════════ */
async function employeesTab() {
  const rows = await api.get('/api/hr/employees');
  return card('ملفات الموظفين', table([
    { header: 'الرقم', key: 'employee_no' },
    { header: 'الموظف', key: 'name', render: r => el('div.row', { style: { gap: '7px', flexWrap: 'nowrap' } }, [avatar(r.name, 'sm'), el('div', {}, [el('div', { text: r.name, style: { fontSize: '12.5px', fontWeight: '600' } }), el('small', { text: r.email, style: { color: 'var(--text-3)', fontSize: '11px' } })])]) },
    { header: 'المسمى', key: 'job_title' },
    { header: 'القسم', key: 'department' },
    { header: 'الفرع', key: 'branch_name' },
    ...(can('hr.payroll.view') ? [{ header: 'الراتب (ر.س)', key: 'basic_salary', num: true, render: r => money(r.basic_salary + r.allowances) }] : []),
    { header: '', key: 'a', render: r => el('button.btn.sm.ghost', { text: 'الملف الشامل', onclick: () => openEmployeeFile(r.user_id) }) }
  ], rows, { emptyText: 'لا توجد ملفات موظفين' }), { p0: true });
}

export async function openEmployeeFile(userId) {
  const d = await api.get(`/api/hr/employees/${userId}/file`);
  const e = d.employee;
  const s = d.attendance_summary;
  const totalDays = s.present + s.late + s.absent + s.leave;
  const rate = totalDays ? Math.round((s.present + s.late) * 100 / totalDays) : 0;

  const body = el('div.stack', {}, [
    el('div.row', { style: { gap: '14px' } }, [
      avatar(e.name, 'lg'),
      el('div', { style: { flex: 1 } }, [
        el('h3', { text: e.name }),
        el('div.hint', { text: `${e.job_title || ''} · ${e.department || ''} · ${e.branch_name || ''}` }),
        el('div.row', { style: { marginTop: '6px' } }, [
          chip(e.employee_no || '—'), chip(e.contract_type || ''), chip(e.role_name, 'brand')
        ])
      ])
    ]),
    el('div.grid.g4', {}, [
      el('div.stat.ok', {}, [el('div.label', { text: 'نسبة الحضور' }), el('div.value', { text: pct(rate) }), el('div.hint', { text: `${AR_NUM(totalDays)} يوم عمل` })]),
      el('div.stat', {}, [el('div.label', { text: 'المهام المنجزة' }), el('div.value', { text: `${AR_NUM(d.tasks.done)}/${AR_NUM(d.tasks.total)}` })]),
      el('div.stat.gold', {}, [el('div.label', { text: 'متوسط التقييم' }), el('div.value', { text: d.evaluation.avg !== null ? pct(d.evaluation.avg) : '—' }), el('div.hint', { text: `${AR_NUM(d.evaluation.count)} تقييم` })]),
      el('div.stat.danger', {}, [el('div.label', { text: 'أيام الغياب' }), el('div.value', { text: AR_NUM(s.absent) }), el('div.hint', { text: `${AR_NUM(s.late)} تأخير` })])
    ]),
    card('بيانات التعاقد', el('div.grid.g2', {}, [
      infoRow('تاريخ المباشرة', fmtDate(e.hire_date, state.calendar)),
      infoRow('نهاية العقد', e.contract_end ? fmtDate(e.contract_end, state.calendar) : 'غير محدد'),
      infoRow('الجوال', e.phone || '—'),
      infoRow('البريد', e.email),
      ...(can('hr.payroll.view') ? [
        infoRow('الراتب الأساسي', money(e.basic_salary) + ' ر.س'),
        infoRow('البدلات', money(e.allowances) + ' ر.س'),
        infoRow('الآيبان', e.bank_iban || '—')
      ] : [])
    ])),
    d.leaves.length ? card('الإجازات', table([
      { header: 'من', key: 'start_date', render: r => fmtDate(r.start_date, state.calendar, 'short') },
      { header: 'إلى', key: 'end_date', render: r => fmtDate(r.end_date, state.calendar, 'short') },
      { header: 'الأيام', key: 'days', num: true },
      { header: 'الحالة', key: 'status', render: r => chip(T.leave[r.status], r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : 'warn') }
    ], d.leaves), { p0: true }) : null,
    can('hr.payroll.view') && d.payroll.length ? card('آخر الرواتب', table([
      { header: 'الشهر', key: 'm', render: r => `${AR_NUM(r.month)}/${AR_NUM(r.year)}` },
      { header: 'الأساسي', key: 'basic', num: true, render: r => money(r.basic) },
      { header: 'الاستقطاعات', key: 'ded', num: true, render: r => money(r.absence_deduction + r.late_deduction + r.advance_deduction) },
      { header: 'الصافي (ر.س)', key: 'net', num: true, render: r => el('b', { text: money(r.net) }) }
    ], d.payroll), { p0: true }) : null
  ]);
  modal({ title: 'ملف الموظف الشامل', body, size: 'wide' });
}
const infoRow = (label, value) => el('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' } }, [
  el('span', { style: { color: 'var(--text-3)', fontSize: '12px' }, text: label }),
  el('b', { style: { fontSize: '12.5px' }, text: String(value) })
]);

/* ═══════════ الإجازات ═══════════ */
async function leavesTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const rows = await api.get('/api/hr/leaves');
    clear(body).append(card(null, table([
      { header: 'الموظف', key: 'user_name' },
      { header: 'النوع', key: 'type', render: r => ({ annual: 'سنوية', sick: 'مرضية', emergency: 'اضطرارية', unpaid: 'بدون راتب' }[r.type] || r.type) },
      { header: 'من', key: 'start_date', render: r => fmtDate(r.start_date, state.calendar, 'short') },
      { header: 'إلى', key: 'end_date', render: r => fmtDate(r.end_date, state.calendar, 'short') },
      { header: 'الأيام', key: 'days', num: true },
      { header: 'السبب', key: 'reason' },
      { header: 'الحالة', key: 'status', render: r => chip(T.leave[r.status], r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : 'warn') },
      { header: '', key: 'a', render: r => (can('hr.leaves.approve') && r.status === 'pending')
          ? el('div.row', { style: { flexWrap: 'nowrap', gap: '5px' } }, [
              el('button.btn.sm', { text: 'اعتماد', onclick: async () => { await api.post(`/api/hr/leaves/${r.id}/decide`, { action: 'approve' }); toast('تم الاعتماد', 'ok'); load(); } }),
              el('button.btn.sm.ghost', { text: 'رفض', onclick: async () => { await api.post(`/api/hr/leaves/${r.id}/decide`, { action: 'reject' }); toast('تم الرفض', 'info'); load(); } })
            ]) : '—' }
    ], rows, { emptyText: 'لا توجد طلبات إجازة' }), { p0: true }));
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('h3', { text: 'طلبات الإجازات' }),
      can('hr.leaves.request') ? el('button.btn.sm', { text: '＋ طلب إجازة', onclick: () => openLeaveForm(load) }) : null
    ])]),
    body
  ]);
}

function openLeaveForm(reload) {
  const type = select([{ value: 'annual', label: 'سنوية' }, { value: 'sick', label: 'مرضية' }, { value: 'emergency', label: 'اضطرارية' }, { value: 'unpaid', label: 'بدون راتب' }]);
  const from = input({ type: 'date', value: todayISO() });
  const to = input({ type: 'date', value: addDaysISO(todayISO(), 2) });
  const reason = textarea({ placeholder: 'سبب الإجازة...' });
  const m = modal({
    title: 'طلب إجازة', size: 'narrow',
    body: el('div', {}, [field('نوع الإجازة', type), el('div.grid.g2', {}, [field('من', from), field('إلى', to)]), field('السبب', reason)]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'رفع الطلب', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api.post('/api/hr/leaves', { type: type.value, start_date: from.value, end_date: to.value, reason: reason.value });
          toast(`تم رفع طلب إجازة ${AR_NUM(r.days)} يوم`, 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ مسير الرواتب ═══════════ */
async function payrollTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const runs = await api.get('/api/hr/payroll');
    clear(body).append(card(null, table([
      { header: 'الفترة', key: 'p', render: r => `${AR_NUM(r.month)}/${AR_NUM(r.year)}` },
      { header: 'الفرع', key: 'branch_name', render: r => r.branch_name || 'كل الفروع' },
      { header: 'عدد الموظفين', key: 'items_count', num: true, render: r => AR_NUM(r.items_count) },
      { header: 'الإجمالي (ر.س)', key: 'total', num: true, render: r => money(r.total) },
      { header: 'الحالة', key: 'status', render: r => chip({ draft: 'مسودة', approved: 'معتمد', paid: 'مصروف' }[r.status], { draft: 'warn', approved: 'info', paid: 'ok' }[r.status]) },
      { header: '', key: 'a', render: r => el('div.row', { style: { flexWrap: 'nowrap', gap: '5px' } }, [
          el('button.btn.sm.ghost', { text: 'التفاصيل', onclick: () => openPayroll(r.id, load) }),
          can('hr.payroll.manage') && r.status !== 'paid'
            ? el('button.btn.sm', { text: r.status === 'draft' ? 'اعتماد' : 'صرف', onclick: async () => {
                await api.post(`/api/hr/payroll/${r.id}/approve`, { status: r.status === 'draft' ? 'approved' : 'paid' });
                toast('تم التحديث', 'ok'); load();
              } }) : null
        ]) }
    ], runs, { emptyText: 'لم يُنشأ أي مسير رواتب بعد' }), { p0: true }));
  };
  await load();

  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div', {}, [el('h3', { text: 'مسير الرواتب' }),
        el('div.hint', { text: 'يجمع المحرك بيانات الحضور والإجازات المعتمدة والسلف ويخصمها آلياً.' })]),
      can('hr.payroll.manage') ? el('button.btn.sm', { text: '⚙️ إنشاء مسير جديد', onclick: () => generatePayroll(load) }) : null
    ])]),
    body
  ]);
}

function generatePayroll(reload) {
  const now = new Date();
  const year = input({ type: 'number', value: now.getFullYear(), min: 2020, max: 2100 });
  const month = select(Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `الشهر ${i + 1}` })), { value: now.getMonth() + 1 });
  const branch = select([{ value: '', label: 'كل الفروع المصرّح بها' }, ...state.session.branches.map(b => ({ value: b.id, label: b.name }))]);
  const m = modal({
    title: 'إنشاء مسير رواتب', size: 'narrow',
    body: el('div', {}, [
      el('p', { style: { marginTop: 0, fontSize: '12.5px', color: 'var(--text-2)' },
        text: 'سيحسب النظام: (الأساسي + البدلات) − خصم الغياب − خصم التأخير − أقساط السلف.' }),
      el('div.grid.g2', {}, [field('السنة', year), field('الشهر', month)]), field('الفرع', branch)
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'احتساب المسير', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api.post('/api/hr/payroll/generate', { year: Number(year.value), month: Number(month.value), branch_id: branch.value || null });
          toast(`تم احتساب ${AR_NUM(r.count)} موظف بإجمالي ${money(r.total)} ر.س`, 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

async function openPayroll(id, reload) {
  const { run, items } = await api.get(`/api/hr/payroll/${id}`);
  modal({
    title: `مسير رواتب ${run.month}/${run.year}`, size: 'wide',
    body: el('div.stack', {}, [
      el('div.grid.g4', {}, [
        el('div.stat', {}, [el('div.label', { text: 'عدد الموظفين' }), el('div.value', { text: AR_NUM(items.length) })]),
        el('div.stat.ok', {}, [el('div.label', { text: 'إجمالي الصافي' }), el('div.value', { text: money(run.total) }), el('div.hint', { text: 'ريال سعودي' })]),
        el('div.stat.danger', {}, [el('div.label', { text: 'إجمالي الخصومات' }), el('div.value', { text: money(items.reduce((s, i) => s + i.absence_deduction + i.late_deduction + i.advance_deduction, 0)) })]),
        el('div.stat.gold', {}, [el('div.label', { text: 'الحالة' }), el('div.value', { style: { fontSize: '17px' }, text: { draft: 'مسودة', approved: 'معتمد', paid: 'مصروف' }[run.status] })])
      ]),
      table([
        { header: 'الموظف', key: 'user_name' },
        { header: 'الرقم', key: 'employee_no' },
        { header: 'الأساسي', key: 'basic', num: true, render: r => money(r.basic) },
        { header: 'البدلات', key: 'allowances', num: true, render: r => money(r.allowances) },
        { header: 'خصم غياب', key: 'absence_deduction', num: true, render: r => money(r.absence_deduction) },
        { header: 'خصم تأخير', key: 'late_deduction', num: true, render: r => money(r.late_deduction) },
        { header: 'خصم سلف', key: 'advance_deduction', num: true, render: r => money(r.advance_deduction) },
        { header: 'الصافي (ر.س)', key: 'net', num: true, render: r => el('b', { text: money(r.net), style: { color: 'var(--brand)' } }) }
      ], items)
    ])
  });
}
