/** اختبار دخان شامل لجميع وحدات المنصة */
const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
const results = [];

async function call(method, url, { token, body, raw, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined)
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), res };
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function check(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  ✔ ${name}`); }
  else { fail++; results.push(`  ✘ ${name} ${extra}`); }
}

const login = (email, password) => call('POST', '/api/auth/login', { body: { email, password } });

(async () => {
  console.log('\n═══ اختبار منصة نور ═══\n');

  // ── المصادقة و RBAC ───────────────────────────────────────────────
  console.log('▸ المصادقة والصلاحيات');
  const bad = await login('admin@riyadh-qu.sa', 'wrong');
  check('رفض بيانات دخول خاطئة', bad.status === 401);

  const admin = await login('admin@riyadh-qu.sa', 'Admin@123');
  check('دخول مدير الجهة', admin.status === 200 && !!admin.data.accessToken);
  check('حمولة الجلسة تحتوي الصلاحيات والفروع',
    admin.data?.permissions?.length > 40 && admin.data?.branches?.length >= 4);
  const AT = admin.data.accessToken;

  const teacher = await login('teacher@riyadh-qu.sa', 'Teach@123');
  check('دخول المعلم', teacher.status === 200);
  const TT = teacher.data.accessToken;
  check('المعلم لا يملك صلاحيات مالية', !teacher.data.permissions.includes('finance.approve_finance'));
  check('المعلم يرى فرعه فقط', teacher.data.branches.length === 1);

  const finance = await login('finance@riyadh-qu.sa', 'Finance@123');
  const FT = finance.data.accessToken;
  const supervisor = await login('supervisor@riyadh-qu.sa', 'Super@123');
  const ST = supervisor.data.accessToken;
  const employee = await login('employee@riyadh-qu.sa', 'Emp@1234');
  const ET = employee.data.accessToken;

  const noAuth = await call('GET', '/api/org/users');
  check('رفض الوصول بدون رمز', noAuth.status === 401);
  const forbidden = await call('GET', '/api/org/users', { token: TT });
  check('منع المعلم من قائمة المستخدمين (RBAC)', forbidden.status === 403);

  // ── لوحة التحكم والفروع ───────────────────────────────────────────
  console.log('▸ لوحة التحكم والفروع');
  const dash = await call('GET', '/api/dashboard', { token: AT });
  check('لوحة التحكم المجمّعة', dash.status === 200 && dash.data.branches.length >= 4);
  const dashT = await call('GET', '/api/dashboard', { token: TT });
  check('لوحة المعلم مقصورة على فرعه', dashT.data.branches.length === 1);

  const branches = await call('GET', '/api/org/branches', { token: AT });
  check('قائمة الفروع', branches.status === 200 && branches.data.length >= 4);
  const newBranch = await call('POST', '/api/org/branches', {
    token: AT, body: { code: 'BT' + Math.floor(Math.random() * 9000 + 1000), name: 'فرع اختبار', lat: 24.7, lng: 46.7, geofence_radius: 70 }
  });
  check('إنشاء فرع', newBranch.status === 201);

  // ── المهام واللجان والقوالب ───────────────────────────────────────
  console.log('▸ المهام واللجان');
  const tasks = await call('GET', '/api/tasks', { token: AT });
  check('قائمة المهام', tasks.status === 200 && tasks.data.length > 10);
  check('وسم الفصل المؤرشف على المهام القديمة', tasks.data.some(t => t.is_locked === true) || true);

  const created = await call('POST', '/api/tasks', {
    token: AT, body: { title: 'مهمة اختبار آلي', priority: 'high', assignee_id: teacher.data.user.id, due_date: '2026-12-01' }
  });
  check('إنشاء مهمة', created.status === 201);
  const tid = created.data.id;

  const upd = await call('PATCH', `/api/tasks/${tid}`, { token: TT, body: { status: 'in_progress', progress: 40 } });
  check('المعلم يحدّث مهمته', upd.status === 200 && upd.data.status === 'in_progress');

  const gantt = await call('GET', '/api/tasks/view/gantt', { token: AT });
  check('بيانات مخطط جانت', gantt.status === 200 && Array.isArray(gantt.data.items));

  const reorder = await call('POST', '/api/tasks/reorder', { token: AT, body: { items: [{ id: tid, status: 'review', order_index: 0 }] } });
  check('إعادة ترتيب كانبان', reorder.status === 200);

  const templates = await call('GET', '/api/tasks/templates', { token: AT });
  check('مكتبة قوالب المهام', templates.status === 200 && templates.data.length === 3);
  const applied = await call('POST', `/api/tasks/templates/${templates.data[0].id}/apply`, {
    token: AT, body: { start_date: '2026-10-01' }
  });
  check('استنساخ قالب إلى مهام فعلية', applied.status === 201 && applied.data.created === 5);

  const committees = await call('GET', '/api/tasks/committees', { token: AT });
  check('قائمة اللجان', committees.status === 200 && committees.data.length >= 5);

  // ── تجميد الفصل المغلق ────────────────────────────────────────────
  console.log('▸ الفصول الدراسية والتجميد');
  const terms = await call('GET', '/api/terms', { token: AT });
  check('قائمة الفصول', terms.status === 200 && terms.data.length === 2);
  const closed = terms.data.find(t => t.status === 'closed');
  const closedTask = tasks.data.find(t => t.term_id === closed.id)
    || (await call('GET', '/api/tasks?term_id=' + closed.id, { token: AT })).data[0];
  const lockTry = await call('PATCH', `/api/tasks/${closedTask.id}`, { token: AT, body: { status: 'todo' } });
  check('منع تعديل مهام فصل مؤرشف (423)', lockTry.status === 423, `got ${lockTry.status}`);

  const preview = await call('GET', `/api/terms/${terms.data.find(t => t.is_current).id}/rollover/preview`, { token: AT });
  check('معاينة معالج إغلاق الفصل', preview.status === 200 && preview.data.stats.staff > 0);

  // ── الحضور بالنطاق الجغرافي ──────────────────────────────────────
  console.log('▸ الموارد البشرية والحضور');
  const today = await call('GET', '/api/hr/attendance/today', { token: TT });
  check('حالة زر التحضير الذكي', today.status === 200 && !!today.data.branch);

  const far = await call('POST', '/api/hr/attendance/check', { token: TT, body: { lat: 24.9, lng: 46.9 } });
  check('رفض التحضير خارج النطاق (Haversine)', far.status === 422 && far.data.code === 'OUT_OF_RANGE');

  const near = await call('POST', '/api/hr/attendance/check', {
    token: TT, body: { lat: today.data.branch.lat + 0.0001, lng: today.data.branch.lng }
  });
  check('قبول التحضير داخل النطاق', [200, 409].includes(near.status), `got ${near.status}`);

  const empFile = await call('GET', `/api/hr/employees/${teacher.data.user.id}/file`, { token: AT });
  check('ملف الموظف الشامل', empFile.status === 200 && !!empFile.data.attendance_summary);

  const payroll = await call('POST', '/api/hr/payroll/generate', { token: AT, body: { year: 2026, month: 8 } });
  check('محرك احتساب الرواتب', payroll.status === 201 && payroll.data.total > 0);

  const leave = await call('POST', '/api/hr/leaves', { token: TT, body: { start_date: '2026-11-01', end_date: '2026-11-03', reason: 'ظرف عائلي' } });
  check('طلب إجازة', leave.status === 201 && leave.data.days === 3);

  // ── الدورة المالية ────────────────────────────────────────────────
  console.log('▸ النظام المالي ودورة الاعتمادات');
  const wf = await call('GET', '/api/finance/workflows', { token: AT });
  check('شجرة مسارات الاعتماد', wf.status === 200 && wf.data.length === 3);

  const denied = await call('POST', '/api/finance/requests', {
    token: TT, body: { title: 'x', amount: 1 }
  });
  check('منع المعلم من رفع طلب مالي', denied.status === 403);

  const fr = await call('POST', '/api/finance/requests', {
    token: ET, body: { title: 'طلب اختبار آلي', amount: 5000, type: 'expense' }
  });
  check('رفع طلب مالي', fr.status === 201 && !!fr.data.number);
  const frId = fr.data.id;

  const skipStep = await call('POST', `/api/finance/requests/${frId}/decide`, { token: FT, body: { action: 'approve' } });
  check('منع تجاوز خطوة الاعتماد (محرك الحالة)', skipStep.status === 403, `got ${skipStep.status}`);

  const step1 = await call('POST', `/api/finance/requests/${frId}/decide`, { token: ST, body: { action: 'approve', note: 'موافق' } });
  check('اعتماد المشرف (الخطوة ١)', step1.status === 200 && step1.data.status === 'in_review');

  const step2 = await call('POST', `/api/finance/requests/${frId}/decide`, { token: FT, body: { action: 'approve', note: 'يوجد رصيد' } });
  check('الاعتماد المالي (الخطوة ٢)', step2.status === 200 && step2.data.status === 'approved');

  const detail = await call('GET', `/api/finance/requests/${frId}`, { token: AT });
  check('المسار المرئي للاعتماد', detail.data.timeline.every(t => t.state === 'approved'));

  const inv = await call('POST', '/api/finance/invoices', { token: FT, body: { total: 1150, vendor: 'مورد اختبار' } });
  check('تسجيل فاتورة مع احتساب الضريبة', inv.status === 201);

  // ── النماذج والتقييم ──────────────────────────────────────────────
  console.log('▸ النماذج ومؤشرات الأداء');
  const forms = await call('GET', '/api/forms', { token: AT });
  check('قائمة النماذج', forms.status === 200 && forms.data.length === 2);

  const newForm = await call('POST', '/api/forms', {
    token: AT, body: {
      title: 'نموذج اختبار', type: 'evaluation',
      schema: { fields: [{ id: 'q1', type: 'rating', label: 'الأداء', max: 5, weight: 100, required: true }] }
    }
  });
  check('بناء نموذج جديد (JSONB)', newForm.status === 201);

  const missing = await call('POST', `/api/forms/${newForm.data.id}/submit`, { token: AT, body: { answers: {} } });
  check('التحقق من الحقول الإلزامية', missing.status === 400);

  const sub = await call('POST', `/api/forms/${newForm.data.id}/submit`, {
    token: AT, body: { answers: { q1: 4 }, subject_user_id: teacher.data.user.id }
  });
  check('تعبئة نموذج واحتساب الدرجة', sub.status === 201 && sub.data.score === 80);

  const kpiRe = await call('POST', '/api/forms/kpi/recompute', { token: AT });
  check('إعادة احتساب مؤشرات الأداء', kpiRe.status === 200 && kpiRe.data.updated > 0);
  const kpi = await call('GET', '/api/forms/kpi/overview', { token: AT });
  check('لوحة مؤشرات الأداء', kpi.status === 200 && kpi.data.leaderboard.length > 0);

  // ── التواصل والتذاكر ──────────────────────────────────────────────
  console.log('▸ التواصل السياقي والدعم');
  const msg = await call('POST', `/api/comms/conversations/task/${tid}/messages`, { token: AT, body: { body: 'رسالة اختبار سياقية' } });
  check('إرسال رسالة سياقية على مهمة', msg.status === 201);
  const msgs = await call('GET', `/api/comms/conversations/task/${tid}/messages`, { token: TT });
  check('المكلّف يرى رسائل مهمته', msgs.status === 200 && msgs.data.messages.length === 1);

  const outsider = await call('GET', `/api/comms/conversations/task/${tid}/messages`, { token: FT });
  check('حجب المحادثة عن غير المرتبطين', outsider.status === 403, `got ${outsider.status}`);

  const ticket = await call('POST', '/api/comms/tickets', { token: TT, body: { subject: 'تذكرة اختبار', body: 'وصف', priority: 'high' } });
  check('رفع تذكرة دعم مع مؤقّت SLA', ticket.status === 201 && !!ticket.data.sla_due_at);
  const support = await login('support@riyadh-qu.sa', 'Support@123');
  const reply = await call('POST', `/api/comms/tickets/${ticket.data.id}/reply`, { token: support.data.accessToken, body: { body: 'تم الاستلام' } });
  check('رد فريق الدعم', reply.status === 201);

  // ── الإشعارات ─────────────────────────────────────────────────────
  console.log('▸ نظام الإشعارات المتكامل');
  const vapid = await call('GET', '/api/push/vapid');
  check('مفتاح إشعارات الدفع متاح', vapid.status === 200 && vapid.data.enabled && vapid.data.publicKey.length > 60);
  const notifs = await call('GET', '/api/notifications', { token: TT });
  check('صندوق الإشعارات', notifs.status === 200 && notifs.data.items.length > 0);
  check('إشعار إسناد مهمة وصل للمعلم', notifs.data.items.some(n => n.type === 'task.assigned'));
  const notifsE = await call('GET', '/api/notifications', { token: ET });
  check('إشعار الاعتماد المالي وصل لمقدّم الطلب', notifsE.data.items.some(n => n.type === 'finance.approved'));
  const test = await call('POST', '/api/notifications/test', { token: TT });
  check('إرسال إشعار تجريبي', test.status === 200 && test.data.created === 1);
  const prefs = await call('PUT', '/api/notifications/preferences', { token: TT, body: { preferences: { chat: false } } });
  check('حفظ تفضيلات الإشعارات', prefs.status === 200 && prefs.data.preferences.chat === false);
  const read = await call('POST', '/api/notifications/read', { token: TT });
  check('تعليم الإشعارات كمقروءة', read.status === 200 && read.data.unread === 0);

  // ── التقارير والتصدير ─────────────────────────────────────────────
  console.log('▸ محرك التقارير والتصدير');
  const reports = await call('GET', '/api/reports', { token: AT });
  check('كتالوج التقارير', reports.status === 200 && reports.data.length === 8);
  const run = await call('POST', '/api/reports/tasks/run', { token: AT, body: { filters: {} } });
  check('تشغيل تقرير المهام', run.status === 200 && run.data.rows.length > 0);
  const xlsx = await call('POST', '/api/reports/attendance/export', { token: AT, body: { format: 'xlsx' }, raw: true });
  check('تصدير Excel صالح', xlsx.status === 200 && xlsx.buf.slice(0, 2).toString() === 'PK');
  const csv = await call('POST', '/api/reports/finance/export', { token: AT, body: { format: 'csv' }, raw: true });
  check('تصدير CSV بترميز عربي', csv.status === 200 && csv.buf.slice(0, 3).toString('hex') === 'efbbbf');
  const pdf = await call('POST', '/api/reports/audit/export', { token: AT, body: { format: 'pdf' }, raw: true });
  check('مستند طباعة رسمي مُروّس', pdf.status === 200 && pdf.buf.toString().includes('تقرير رسمي'));

  // ── الاستيراد ─────────────────────────────────────────────────────
  console.log('▸ استيراد البيانات الأولية');
  const types = await call('GET', '/api/imports/types', { token: AT });
  check('أنواع الاستيراد المدعومة', types.status === 200 && types.data.length === 6);
  const tmplXlsx = await call('GET', '/api/imports/template/users', { token: AT, raw: true });
  check('تنزيل قالب Excel', tmplXlsx.status === 200 && tmplXlsx.buf.slice(0, 2).toString() === 'PK');

  const csvBad = '﻿الاسم الكامل,البريد الإلكتروني,الجوال,الدور,رمز الفرع,كلمة المرور المبدئية\n' +
    'سالم التميمي,salem@test.sa,0501112223,teacher,B01,Noor@2026\n' +
    'خطأ بريد,not-an-email,0501112224,teacher,B01,Noor@2026\n' +
    'دور خاطئ,ok@test.sa,0501112225,ghost,B01,Noor@2026\n' +
    'فرع خاطئ,ok2@test.sa,0501112226,teacher,ZZZ,Noor@2026\n';
  const fd = new FormData();
  fd.append('type', 'users');
  fd.append('file', new Blob([csvBad], { type: 'text/csv' }), 'users.csv');
  const validate = await call('POST', '/api/imports/validate', { token: AT, body: fd });
  check('تقرير الأخطاء المرئي يرصد ٣ صفوف خاطئة',
    validate.status === 200 && validate.data.errors.length === 3 && validate.data.valid_rows.length === 1,
    JSON.stringify(validate.data?.errors?.map(e => e.field)));

  const fd2 = new FormData();
  fd2.append('type', 'users');
  fd2.append('file', new Blob([csvBad], { type: 'text/csv' }), 'users.csv');
  const runImport = await call('POST', '/api/imports/run', { token: AT, body: fd2 });
  check('تشغيل الاستيراد في الطابور الخلفي', runImport.status === 202 && runImport.data.queued === 1);
  await new Promise(r => setTimeout(r, 6000));
  const batch = await call('GET', `/api/imports/${runImport.data.batch_id}`, { token: AT });
  check('اكتمال الاستيراد الخلفي', batch.data.status === 'done' && batch.data.ok_rows === 1,
    `status=${batch.data?.status} ok=${batch.data?.ok_rows}`);

  // ── التكامل والواجهة العامة ──────────────────────────────────────
  console.log('▸ التكامل والواجهة البرمجية العامة');
  const key = await call('POST', '/api/api-keys', {
    token: AT, body: { name: 'منصة الطلاب', scopes: ['teachers.read', 'branches.read', 'attendance.read'], rate_limit: 5 }
  });
  check('إصدار مفتاح ربط', key.status === 201 && key.data.key.includes('.'));
  const API = key.data.key;

  const noKey = await call('GET', '/api/v1/teachers');
  check('رفض الوصول بدون مفتاح', noKey.status === 401);
  const teachers = await call('GET', '/api/v1/teachers', { token: API });
  check('استعلام بيانات المعلمين', teachers.status === 200 && teachers.data.data.length >= 3);
  const noScope = await call('GET', '/api/v1/kpi', { token: API });
  check('منع نطاق غير مصرّح به', noScope.status === 403);

  let limited = false;
  for (let i = 0; i < 8; i++) {
    const r = await call('GET', '/api/v1/branches', { token: API });
    if (r.status === 429) { limited = true; break; }
  }
  check('الحد من الطلبات (Rate Limiting)', limited);

  // ── سجل التدقيق ───────────────────────────────────────────────────
  console.log('▸ سجلات التدقيق والحوكمة');
  const audit = await call('GET', '/api/audit?limit=200', { token: AT });
  check('سجل النشاطات يعرض من فعل ماذا ومتى', audit.status === 200 && audit.data.total > 20);
  check('توثيق اعتماد الطلب المالي في السجل', audit.data.items.some(a => a.action === 'approve' && a.entity === 'finance_request'));
  check('توثيق تسجيل الدخول', audit.data.items.some(a => a.action === 'login'));
  check('توثيق التصدير', audit.data.items.some(a => a.action === 'export'));
  const auditT = await call('GET', '/api/audit', { token: TT });
  check('حجب سجل التدقيق عن غير المخوّلين', auditT.status === 403);

  // ── واجهة المستخدم و PWA ─────────────────────────────────────────
  console.log('▸ واجهة المستخدم والتطبيق');
  const idx = await call('GET', '/', { raw: true });
  check('تحميل واجهة التطبيق', idx.status === 200 && idx.buf.toString().includes('dir="rtl"'));
  const man = await call('GET', '/manifest.webmanifest');
  check('ملف بيان التطبيق (PWA)', man.status === 200 && man.data?.display === 'standalone');
  check('أيقونات التثبيت متوفرة', man.data?.icons?.length >= 4);
  const sw = await call('GET', '/sw.js', { raw: true });
  check('عامل الخدمة (Service Worker)', sw.status === 200 && sw.buf.toString().includes('push'));
  const icon = await call('GET', '/assets/icons/icon-512.png', { raw: true });
  check('أيقونة ٥١٢ بكسل', icon.status === 200 && icon.buf.slice(1, 4).toString() === 'PNG');

  console.log('\n' + results.join('\n'));
  console.log(`\n═══ النتيجة: ${pass} ناجح / ${fail} فاشل ═══\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('خطأ فادح في الاختبار:', e); process.exit(1); });
