import api from '../api.js';
import { state, can, isRole } from '../state.js';
import {
  el, clear, card, chip, empty, table, toast, modal, field, input, textarea, select, picker, userOptions, tabs,
  T, AR_NUM, pct, money, avatar, clockOf, progressBar, confirmDialog, skeleton, qs
} from '../util.js';
import { geoMap, distanceM } from '../map.js';
import { fmtDate, todayISO, dayName, addDaysISO } from '../hijri.js';
import { schedulesTab, hoursText } from './workhours.js';

export async function render({ sub, navigate }) {
  if (sub === 'checkin') return checkinScreen();
  const items = [];
  if (can('hr.attendance.self')) items.push({ label: 'حضوري', icon: 'map-pin', build: () => checkinScreen() });
  if (can('hr.attendance.view')) items.push({ label: 'سجل الحضور', icon: 'calendar-range', build: attendanceTab });
  /* الجداول قبل الملفات: التأخّر والغياب في السجلّ قبلها لا يُفهمان بلا معرفة الدوام */
  if (can('hr.attendance.view')) items.push({ label: 'أوقات الدوام', icon: 'alarm-clock', build: schedulesTab });
  if (can('hr.employees.view')) items.push({ label: 'ملفات الموظفين', icon: 'users', build: employeesTab });
  items.push({ label: 'الإجازات', icon: 'tree-palm', build: leavesTab });
  if (can('hr.payroll.view')) items.push({ label: 'مسير الرواتب', icon: 'banknote', build: payrollTab });
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

    const status = el('div', { style: { fontSize: '13px', color: 'var(--text-2)', minHeight: '22px' } });

    /* رسالةُ تعذّر الموقع واحدة أينما جاء الطلب — من الزرّ الكبير أو من الخريطة */
    const geoErrText = (err) => (err?.code === 1
      ? 'رفضت إذن الموقع — فعّله من إعدادات المتصفح لتتمكن من التحضير'
      : 'تعذّر تحديد موقعك، تأكد من تفعيل خدمة الموقع (GPS)');

    /*
     * فروع الموظف كلُّها لا فرعٌ واحد: من عُيّن على فروعٍ عدّة يُحضِّر من أيّها وقف
     * فيه، فتُقاس المسافةُ إليها جميعاً ويُتَّخذ أقربُها — كما يفعل الخادم تماماً.
     */
    const spots = (d.branches?.length ? d.branches : (d.branch ? [d.branch] : []))
      .filter(b => b.lat != null && b.lng != null);
    const radiusOf = (b) => b.geofence_radius || d.geofence_radius || 50;

    /** أقرب فرعٍ إلى نقطة — ومعه مسافته ونطاقه وهل هو داخله */
    const nearestTo = (la, ln) => {
      if (!spots.length) return null;
      return spots
        .map(b => { const dist = distanceM(b.lat, b.lng, la, ln), r = radiusOf(b);
          return { b, dist, r, inside: dist <= r }; })
        .sort((x, y) => (x.dist - x.r) - (y.dist - y.r))[0];
    };

    /** أين أنا من فرعي؟ نصٌّ واحد يقرؤه المُحضِّر قبل أن يضغط */
    const awayText = (la, ln) => {
      if (d.remote_allowed) return 'تعمل عن بُعد — التحضير متاح من أي مكان';
      const n = nearestTo(la, ln);
      if (!n) return '';
      if (n.inside) return `أنت داخل نطاق ${n.b.name} — ${AR_NUM(n.dist)} م`;
      return spots.length > 1
        ? `أنت خارج نطاق فروعك. أقربها ${n.b.name} على بُعد ${AR_NUM(n.dist)} م (النطاق ${AR_NUM(n.r)} م)`
        : `أنت على بُعد ${AR_NUM(n.dist)} م — تقدّم إلى داخل النطاق (${AR_NUM(n.r)} م)`;
    };

    let shown = d.branch || spots[0] || null;
    /* شارتا الفرع ونطاقه تُبنيان معاً: نطاقُ فرعٍ آخر تحت اسم هذا الفرع كذبٌ صريح */
    const chipsRow = el('div.row', { style: { justifyContent: 'center', gap: '8px', marginTop: '9px' } });
    const paintChips = () => {
      clear(chipsRow).append(
        chip(d.remote_allowed ? 'عن بُعد — بلا نطاق' : (shown ? shown.name : 'لم يُحدد فرع'),
          d.remote_allowed ? 'info' : shown ? 'info' : 'warn',
          d.remote_allowed ? 'laptop' : 'landmark'),
        d.remote_allowed ? null
          : chip(`النطاق ${AR_NUM(shown ? radiusOf(shown) : d.geofence_radius)} م`, '', 'map-pin'),
        /* من له فروعٌ عدّة يعرف أنّ الخريطة تتبع أقربها لا فرعاً بعينه */
        !d.remote_allowed && spots.length > 1 ? chip(`${AR_NUM(spots.length)} فروع`, '', 'building-2') : null
      );
    };
    paintChips();

    /* الخريطة تتبع أقرب فرعٍ إلى المُحضِّر — لا الأول في قائمته */
    const focusNearest = (la, ln) => {
      const n = nearestTo(la, ln);
      if (!n || n.b.id === shown?.id) return;
      shown = n.b;
      mapBox.update({ lat: n.b.lat, lng: n.b.lng, radius: n.r });
      paintChips();
    };

    /*
     * خريطة تفاعلية لا صورةٌ ثابتة: المُحضِّر يسحبها ويكبّرها ويبدّل طبقتها
     * ويضغط «موقعي» فيرى مسجده ونطاقه وموضعَه منه. فإن رُفض تحضيره عرف السبب
     * بعينه — أهو خارج النطاق، أم أنّ إحداثيات الفرع نفسها خطأ.
     */
    const mapBox = geoMap({
      lat: shown?.lat, lng: shown?.lng, radius: shown ? radiusOf(shown) : (d.geofence_radius || 50), height: 250,
      onLocate: (pos, err) => {
        if (err) { status.textContent = geoErrText(err); return; }
        focusNearest(pos.lat, pos.lng);
        status.textContent = awayText(pos.lat, pos.lng);
      }
    });
    const mapWrap = el('div.checkin-map', {}, [mapBox, chipsRow]);

    /* الموقع يُعرَض قبل الضغط: من يرى نفسه خارج النطاق يتقدّم قبل أن يُرفَض */
    const locate = (opts = {}) => new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej,
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0, ...opts }));
    if (navigator.geolocation && spots.length) {
      locate({ maximumAge: 60000 }).then((pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        mapBox.update({ me: { lat: latitude, lng: longitude, accuracy } });
        focusNearest(latitude, longitude);
        status.textContent = awayText(latitude, longitude);
      }).catch(() => { /* لا إذن بعد — الخريطة تبقى على الفرع وحده */ });
    } else if (d.remote_allowed) {
      status.textContent = 'تعمل عن بُعد — التحضير متاح من أي مكان';
    }

    const btn = el('button.checkin-btn' + cls, { disabled: action === 'done' }, [
      el('span.ic', { icon: action === 'done' ? 'circle-check' : action === 'check_out' ? 'flag' : 'map-pin', iconSize: 24 }),
      el('span', { text: label }),
      el('small', { text: action === 'done' ? 'شكراً لجهودك' : 'اضغط للتسجيل' })
    ]);

    btn.onclick = async () => {
      if (!navigator.geolocation) return toast('جهازك لا يدعم تحديد الموقع', 'err');
      btn.disabled = true; btn.classList.add('busy');
      status.textContent = 'جارٍ تحديد موقعك...';
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        btn.classList.remove('busy');
        if (spots.length) {
          mapBox.update({ me: { lat: latitude, lng: longitude, accuracy } });
          focusNearest(latitude, longitude);
        }
        try {
          const res = await api.post('/api/hr/attendance/check', { lat: latitude, lng: longitude, accuracy });
          toast(res.message, 'ok', res.action === 'check_in' ? 'تم الحضور' : 'تم الانصراف');
          paint();
        } catch (err) {
          status.textContent = err.message;
          btn.disabled = false;
        }
      }, (err) => {
        btn.disabled = false; btn.classList.remove('busy');
        status.textContent = geoErrText(err);
        toast(status.textContent, 'err');
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    };

    clear(box).append(card(null, [
      el('div.checkin', {}, [
        el('div', {}, [
          el('h3', { text: dayName(d.date) }),
          el('div.hint', { text: fmtDate(d.date, state.calendar) })
        ]),
        btn, status, mapWrap,
        el('div.row', { style: { justifyContent: 'center' } }, [
          r?.check_in_at ? chip('الحضور: ' + clockOf(r.check_in_at), 'ok', 'log-out') : chip('لم تسجّل الحضور بعد', 'warn', 'hourglass'),
          r?.check_out_at ? chip('الانصراف: ' + clockOf(r.check_out_at), 'danger', 'flag') : null,
          r?.is_remote ? chip('عن بُعد', 'info', 'laptop') : null,
          r?.status === 'late'
            ? chip('مسجّل كتأخير' + (r.late_minutes ? ` ${AR_NUM(r.late_minutes)} دقيقة` : ''), 'warn') : null,
          d.day && !d.day.working ? chip('يوم راحة', 'info', 'tree-palm') : null,
          r?.minutes_worked ? chip(`${AR_NUM(Math.floor(r.minutes_worked / 60))}س ${AR_NUM(r.minutes_worked % 60)}د`, 'info', 'timer') : null
        ]),
        el('div.hint', { style: { maxWidth: '380px' }, text: [
          'اسحب الخريطة لتتنقّل، وكبّرها بزرّي + و−، وبدّل طبقتها من زرّ الطبقات، واضغط زرّ الهدف لترى موقعك.',
          d.remote_allowed
            ? 'ملفّك مضبوطٌ على العمل عن بُعد، فيُقبل تسجيلك من أي مكان بلا نطاق جغرافي.'
            : spots.length > 1
              ? `أنت معيَّنٌ على ${AR_NUM(spots.length)} فروع، ويُقبل تسجيلك داخل نطاق أيّها كنت — والخريطة تتبع أقربها إليك.`
              : `ويتحقق النظام من موقعك بمعادلة هافرساين، ويقبل التسجيل فقط داخل نطاق ${AR_NUM(shown ? radiusOf(shown) : d.geofence_radius)} متراً من إحداثيات الفرع.`,
          d.day && !d.day.working
            ? `و${d.day.day_name} يومُ راحةٍ في جدولك، فحضورك اليوم لا يُحسب تأخيراً.`
            : `دوام اليوم: ${d.workday.start} — ${d.workday.end} (${hoursText(d.day?.minutes ?? 0)})،`
              + ` وسماح التأخير ${AR_NUM(d.schedule?.grace_min ?? 15)} دقيقة.`
        ].join(' ') })
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
  const userSel = picker([{ value: '', label: 'كل المنسوبين' }, ...userOptions(users)],
    { placeholder: 'كل المنسوبين', ariaLabel: 'تصفية بالمنسوب', style: { maxWidth: '210px' } });
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
        { header: 'الفرع', key: 'branch_name',
          render: r => (r.is_remote ? chip('عن بُعد', 'info', 'laptop') : (r.branch_name || '—')) },
        { header: 'الحالة', key: 'status', render: r => chip(T.attendance[r.status], T.attendanceChip[r.status]) },
        { header: 'الحضور', key: 'in', render: r => clockOf(r.check_in_at) },
        { header: 'الانصراف', key: 'out', render: r => clockOf(r.check_out_at) },
        { header: 'التأخير', key: 'late', num: true,
          render: r => (r.late_minutes ? `${AR_NUM(r.late_minutes)} د` : '—') },
        { header: 'المسافة', key: 'dist', num: true,
          render: r => (r.is_remote ? '—' : (r.in_distance != null ? `${AR_NUM(r.in_distance)} م` : '—')) }
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
    { header: 'الفرع', key: 'branch_name',
      render: r => (r.remote_allowed ? chip('عن بُعد', 'info', 'laptop') : (r.branch_name || '—')) },
    ...(can('hr.payroll.view') ? [{ header: 'الراتب (ر.س)', key: 'basic_salary', num: true, render: r => money(r.basic_salary + r.allowances) }] : []),
    { header: '', key: 'a', render: r => el('button.btn.sm.ghost', { text: 'الملف الشامل', onclick: () => openEmployeeFile(r.user_id) }) }
  ], rows, { emptyText: 'لا توجد ملفات موظفين' }), { p0: true });
}

export async function openEmployeeFile(userId) {
  const m = modal({ title: 'ملف الموظف الشامل', body: skeleton(6), size: 'wide' });
  const paint = async () => {
    const d = await api.get(`/api/hr/employees/${userId}/file`);
    clear(m.body).append(fileBody(d, userId, paint));
  };
  await paint();
}

function fileBody(d, userId, reload) {
  const e = d.employee;
  const s = d.attendance_summary;
  const totalDays = s.present + s.late + s.absent + s.leave;
  const rate = totalDays ? Math.round((s.present + s.late) * 100 / totalDays) : 0;

  const body = el('div.stack', {}, [
    el('div.row', { style: { gap: '14px' } }, [
      avatar(e.name, 'lg'),
      el('div', { style: { flex: 1 } }, [
        el('h3', { text: e.name }),
        el('div.hint', { text: [e.job_title, e.department, e.branch_name].filter(Boolean).join(' · ') || '—' }),
        el('div.row', { style: { marginTop: '6px' } }, [
          chip(e.employee_no || '—'), chip(e.contract_type || ''), chip(e.role_name, 'brand'),
          e.remote_allowed ? chip('يعمل عن بُعد', 'info', 'laptop') : null,
          e.status && e.status !== 'active' ? chip('موقوف', 'danger') : null
        ])
      ]),
      can('hr.employees.manage')
        ? el('button.btn.sm', { icon: 'pencil', text: 'تعديل البيانات',
          onclick: () => editEmployee(e, reload) })
        : null
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
      infoRow('رقم الهوية / الإقامة', e.national_id || '—'),
      infoRow('مكان العمل', e.remote_allowed ? 'عن بُعد — يحضر من أي مكان' : 'من مقرّ الفرع'),
      ...(can('hr.payroll.view') ? [
        infoRow('الراتب الأساسي', money(e.basic_salary) + ' ر.س'),
        infoRow('البدلات', money(e.allowances) + ' ر.س'),
        infoRow('الآيبان', e.bank_iban || '—')
      ] : [])
    ])),
    d.schedule ? card('أوقات الدوام', el('div', {}, [
      el('div.row', {}, [
        chip(d.schedule.summary, 'brand', 'alarm-clock'),
        chip(hoursText(d.schedule.weekly_minutes) + ' أسبوعياً', 'info', 'timer'),
        chip(`سماح ${AR_NUM(d.schedule.grace_min)} دقيقة`, '', 'hourglass'),
        chip({ user: 'جدول خاصّ به', branch: 'موروث من فرعه', tenant: 'موروث من المجمّع',
          default: 'الجدول الافتراضي' }[d.schedule.source] || 'موروث', '', 'arrow-down')
      ]),
      can('hr.attendance.manage') || can('settings.manage')
        ? el('div.hint', { style: { marginTop: '9px' },
          text: 'يُضبط من تبويب «أوقات الدوام» — وعليه يُحسب تأخّره وغيابه في مسير الرواتب.' })
        : null
    ]), { icon: 'alarm-clock' }) : null,
    documentsCard(d.documents || [], userId, reload),
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
  return body;
}
/* ═══════════ تعديل بيانات الموظف ═══════════ */
/*
 * البيانات في جدولين — الوظيفة والعقد في `employees`، والاسم والبريد والجوال
 * والهوية في `users` — وكان تغييرُ اسمٍ وراتبٍ يقتضي شاشتين. فصارت نموذجاً
 * واحداً، والخادم يفرّقهما ويحرس كلّ مجموعةٍ بصلاحيتها.
 *
 * وما لا يملك المستخدم صلاحيته لا يُعرَض له أصلاً: عرضُ حقلٍ يُردّ عند الحفظ
 * إغراءٌ بلا طائل.
 */
async function editEmployee(e, reload) {
  const mayPay = can('hr.payroll.view');
  const mayUser = can('users.manage');
  /* تعذّرت قراءة الفروع — يُخفى الحقل ويبقى الفرع كما هو، لا يُفرَّغ */
  const branches = (await api.get('/api/org/branches').catch(() => []))
    .filter(b => b.is_active !== 0);

  const f = {
    name: input({ value: e.name || '' }),
    email: input({ type: 'email', value: e.email || '', dir: 'ltr' }),
    phone: input({ value: e.phone || '', dir: 'ltr', placeholder: '05…' }),
    national_id: input({ value: e.national_id || '', dir: 'ltr', placeholder: '١٠ أرقام' }),
    employee_no: input({ value: e.employee_no || '' }),
    job_title: input({ value: e.job_title || '' }),
    department: input({ value: e.department || '' }),
    contract_type: select(
      ['دوام كامل', 'دوام جزئي', 'متعاون', 'عقد مؤقت'].map(v => ({ value: v, label: v })),
      { value: e.contract_type || 'دوام كامل' }),
    hire_date: input({ type: 'date', value: e.hire_date || '' }),
    contract_end: input({ type: 'date', value: e.contract_end || '' }),
    basic_salary: input({ type: 'number', step: '0.01', min: '0', value: e.basic_salary ?? 0, dir: 'ltr' }),
    allowances: input({ type: 'number', step: '0.01', min: '0', value: e.allowances ?? 0, dir: 'ltr' }),
    bank_iban: input({ value: e.bank_iban || '', dir: 'ltr', placeholder: 'SA…' })
  };
  const branchSel = branches.length
    ? select(branches.map(b => ({ value: String(b.id), label: b.name })), { value: String(e.branch_id || '') })
    : null;
  const remote = input({ type: 'checkbox', checked: !!e.remote_allowed });
  const active = input({ type: 'checkbox', checked: (e.status || 'active') === 'active' });

  const m = modal({
    title: `تعديل ملف — ${e.name}`, icon: 'pencil', size: 'wide',
    body: el('div.stack', {}, [
      mayUser ? card('البيانات الشخصية', el('div.grid-2', {}, [
        field('الاسم', f.name), field('البريد الإلكتروني', f.email),
        field('الجوال', f.phone), field('رقم الهوية / الإقامة', f.national_id)
      ])) : el('p.hint', { text: 'تعديل الاسم والبريد والجوال والهوية يحتاج صلاحية إدارة المستخدمين.' }),

      card('الوظيفة والتعاقد', el('div.stack', {}, [
        el('div.grid-2', {}, [
          field('الرقم الوظيفي', f.employee_no), field('المسمى الوظيفي', f.job_title),
          field('القسم', f.department), field('نوع التعاقد', f.contract_type),
          field('تاريخ المباشرة', f.hire_date), field('نهاية العقد', f.contract_end),
          ...(branchSel ? [field('الفرع', branchSel)] : [])
        ]),
        el('label.row', { style: { gap: '8px' } }, [remote,
          el('span', { text: 'يعمل عن بُعد — يسجّل حضوره من أي مكان بلا نطاق جغرافي' })]),
        el('label.row', { style: { gap: '8px' } }, [active, el('span', { text: 'الملف نشط' })])
      ])),

      mayPay ? card('الراتب والحساب البنكي', el('div.grid-2', {}, [
        field('الراتب الأساسي (ر.س)', f.basic_salary),
        field('البدلات (ر.س)', f.allowances),
        field('الآيبان', f.bank_iban, { hint: 'يُستعمل في مسير الرواتب — تحقّق من صحته قبل الحفظ' })
      ])) : null
    ]),
    footer: [
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { icon: 'save', text: 'حفظ', onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await api.patch(`/api/hr/employees/${e.id}`, {
            ...(mayUser ? {
              name: f.name.value.trim(), email: f.email.value.trim(),
              phone: f.phone.value.trim(), national_id: f.national_id.value.trim()
            } : {}),
            ...(mayPay ? {
              basic_salary: Number(f.basic_salary.value) || 0,
              allowances: Number(f.allowances.value) || 0,
              bank_iban: f.bank_iban.value.trim()
            } : {}),
            employee_no: f.employee_no.value.trim(), job_title: f.job_title.value.trim(),
            department: f.department.value.trim(), contract_type: f.contract_type.value,
            hire_date: f.hire_date.value, contract_end: f.contract_end.value,
            remote_allowed: remote.checked, status: active.checked ? 'active' : 'inactive',
            ...(branchSel?.value ? { branch_id: Number(branchSel.value) } : {})
          });
          toast('حُفظت بيانات الموظف', 'ok');
          m.close(); await reload();
        } catch (err) { toast(err.message, 'warn'); ev.target.disabled = false; }
      } })
    ]
  });
}

/* ═══════════ وثائق الموظف ═══════════ */
/*
 * الملفّ يُرفع إلى `/api/files` كبقية مرفقات المنصة ثم يُربَط بصاحبه بنوعٍ واسم.
 * والتسمية هي الفائدة: «IMG_2481.jpg» لا يصلح عنواناً لصورة إقامة، ومن يفتح
 * الملفّ بعد سنة يبحث عن «إقامة ١٤٤٧» لا عن اسم الملف كما خرج من الهاتف.
 */
const DOC_ACCEPT = 'image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx';

/** حالة الوثيقة من تاريخ انتهائها — ما يُقرأ من الشاشة بلا فتحِ ملف */
function docExpiry(iso) {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
  if (days < 0) return { text: 'منتهية', kind: 'danger' };
  if (days === 0) return { text: 'تنتهي اليوم', kind: 'danger' };
  if (days <= 30) return { text: `تنتهي خلال ${AR_NUM(days)} يوماً`, kind: 'warn' };
  return { text: `سارية حتى ${fmtDate(iso, state.calendar, 'short')}`, kind: '' };
}

function documentsCard(docs, userId, reload) {
  const may = can('hr.employees.manage');
  const rows = docs.map(doc => {
    const exp = docExpiry(doc.expires_at);
    return el('div.docrow', {}, [
      el('span.ic', { icon: T.docIcon[doc.kind] || 'paperclip', iconSize: 'card' }),
      el('div', { style: { flex: 1, minWidth: 0 } }, [
        el('div', { text: doc.title || doc.original_name,
          style: { fontSize: '12.5px', fontWeight: '600' } }),
        el('div.row', { style: { gap: '6px', marginTop: '3px' } }, [
          chip(T.docKind[doc.kind] || 'أخرى'),
          exp ? chip(exp.text, exp.kind) : null,
          doc.note ? el('small', { text: doc.note, style: { color: 'var(--text-3)', fontSize: '11px' } }) : null
        ])
      ]),
      el('div.row', { style: { gap: '4px', flexWrap: 'nowrap' } }, [
        el('a.btn.sm.ghost', { icon: 'download', text: 'فتح', href: `/api/files/${doc.file_id}`,
          target: '_blank', rel: 'noopener' }),
        may ? el('button.btn.sm.ghost', { icon: 'pencil', 'aria-label': 'تعديل الوثيقة',
          onclick: () => docForm(userId, doc, reload) }) : null,
        may ? el('button.btn.sm.ghost.danger', { icon: 'trash-2', 'aria-label': 'حذف الوثيقة',
          onclick: async () => {
            if (!await confirmDialog(`حذف «${doc.title || doc.original_name}» من ملف الموظف؟`,
              { confirmText: 'حذف', danger: true })) return;
            try {
              await api.del(`/api/hr/employees/${userId}/documents/${doc.id}`);
              toast('حُذفت الوثيقة', 'ok'); await reload();
            } catch (err) { toast(err.message, 'warn'); }
          } }) : null
      ])
    ]);
  });

  const head = may ? el('button.btn.sm', { icon: 'upload', text: 'إرفاق وثيقة',
    onclick: () => pickAndUpload(userId, reload) }) : null;

  return card('الوثائق', el('div.stack', {}, [
    head ? el('div.row', { style: { justifyContent: 'flex-end' } }, [head]) : null,
    rows.length ? el('div.stack', { style: { gap: '6px' } }, rows)
      : empty('paperclip', 'لا وثائق مرفقة',
        may ? 'أرفق الهوية أو الإقامة والعقد والشهادات ليكتمل الملف' : 'لم تُرفَق وثائق بعد')
  ]));
}

/** يختار ملفاً ويرفعه ثم يسأل عن نوعه واسمه */
function pickAndUpload(userId, reload) {
  const inp = el('input', { type: 'file', hidden: true, accept: DOC_ACCEPT });
  document.body.append(inp);
  inp.onchange = async () => {
    const file = inp.files?.[0];
    inp.remove();
    if (!file) return;
    const fd = new FormData();
    fd.append('files', file);
    fd.append('context', 'employee_docs');
    try {
      const res = await api.post('/api/files', fd);
      const up = (res.files || res)[0];
      if (!up) throw new Error('تعذّر رفع الملف');
      /* الرفع تمّ والربط لم يتمّ بعد — فالنموذج يفتح على الملف المرفوع */
      docForm(userId, { file_id: up.id, original_name: up.name, kind: 'other', title: '' }, reload);
    } catch (err) { toast(err.message || 'تعذّر رفع الملف', 'err'); }
  };
  inp.click();
}

/** نموذج الوثيقة — يُستعمل للإرفاق الجديد وللتعديل معاً */
function docForm(userId, doc, reload) {
  const isNew = !doc.id;
  const kind = select(Object.entries(T.docKind).map(([value, label]) => ({ value, label })),
    { value: doc.kind || 'other' });
  const title = input({ value: doc.title || doc.original_name || '', placeholder: 'مثال: إقامة ١٤٤٧' });
  const expires = input({ type: 'date', value: doc.expires_at || '' });
  const note = input({ value: doc.note || '', placeholder: 'اختياري' });

  const m = modal({
    title: isNew ? 'تسمية الوثيقة' : 'تعديل الوثيقة', icon: 'paperclip', size: 'narrow',
    body: el('div.stack', {}, [
      isNew ? el('p.hint', { text: `أُرفع الملف: ${doc.original_name}` }) : null,
      field('النوع', kind),
      field('التسمية', title, { hint: 'الاسم الذي تُعرَف به الوثيقة في الملف — لا اسم الملف على الجهاز' }),
      field('تاريخ الانتهاء', expires, { hint: 'اختياري — للهوية والإقامة والعقد. تظهر الوثيقة المنتهية في الملف.' }),
      field('ملاحظة', note)
    ]),
    footer: [
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { icon: 'save', text: isNew ? 'إرفاق' : 'حفظ', onclick: async (ev) => {
        ev.target.disabled = true;
        const payload = { kind: kind.value, title: title.value.trim(),
          expires_at: expires.value || null, note: note.value.trim() };
        try {
          if (isNew) await api.post(`/api/hr/employees/${userId}/documents`, { ...payload, file_id: doc.file_id });
          else await api.patch(`/api/hr/employees/${userId}/documents/${doc.id}`, payload);
          toast(isNew ? 'أُرفقت الوثيقة' : 'حُفظت الوثيقة', 'ok');
          m.close(); await reload();
        } catch (err) { toast(err.message, 'warn'); ev.target.disabled = false; }
      } })
    ]
  });
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
      can('hr.leaves.request') ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'طلب إجازة', onclick: () => openLeaveForm(load) }) : null
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
      can('hr.payroll.manage') ? el('button.btn.sm', { icon: 'settings', iconSize: 16, text: 'إنشاء مسير جديد', onclick: () => generatePayroll(load) }) : null
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
        { header: 'أيام العمل', key: 'exp', num: true,
          render: r => `${AR_NUM(r.details?.present ?? 0)}/${AR_NUM(r.details?.expected_days ?? 0)}` },
        { header: 'دقائق التأخير', key: 'lm', num: true, render: r => AR_NUM(r.details?.late_minutes || 0) },
        { header: 'خصم غياب', key: 'absence_deduction', num: true, render: r => money(r.absence_deduction) },
        { header: 'خصم تأخير', key: 'late_deduction', num: true, render: r => money(r.late_deduction) },
        { header: 'خصم سلف', key: 'advance_deduction', num: true, render: r => money(r.advance_deduction) },
        { header: 'الصافي (ر.س)', key: 'net', num: true, render: r => el('b', { text: money(r.net), style: { color: 'var(--brand)' } }) }
      ], items)
    ])
  });
}
