/**
 * تدقيق وظيفي عميق — يتحقق من سلوك كل بند في وثيقة المتطلبات فعلياً
 * لا يكتفي برموز الاستجابة بل يتحقق من صحة الحسابات والقيود والعزل.
 * يعمل على أي بيئة تشغيل (Node أو Cloudflare Workers) عبر متغير BASE.
 */
const BASE = process.env.BASE || 'http://localhost:3000';

/* عدد الصلاحيات يُقرأ من الكتالوج لا يُكتَب رقماً: كل صلاحيةٍ تُضاف كانت
   تُسقط ثلاثة فحوصٍ صحيحة وتُوهم بانكسارٍ ليس فيها. */
const ALL_PERMS = (await import('../server/core/permissions.js')).PERMISSIONS.length;

const only = process.env.ONLY || '';
let pass = 0, fail = 0;
const lines = [];
const S = {};

async function call(method, url, { token, body, raw, headers = {}, expect429 = false } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: isForm ? body : (body !== undefined ? JSON.stringify(body) : undefined)
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), res };
  let data = null; try { data = await res.json(); } catch {}
  /*
   * حدّ الطلبات مشترك بين كل الفحوص، فتجاوزه يُسقط عشرات الفحوص التالية بأخطاء
   * مضلّلة. نوقف التدقيق فوراً برسالة صريحة بدل أن نترك المدقّق يطارد وهماً.
   */
  if (res.status === 429 && data?.error?.code === 'RATE_LIMITED' && !expect429) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  ✘ توقّف التدقيق: تجاوز حدّ الطلبات على الخادم');
    console.log(`    المسار: ${method} ${url}`);
    console.log('    شغّل التدقيق على نسخة جديدة أو انتظر انقضاء النافذة (دقيقة)،');
    console.log('    أو ارفع الحد مؤقتاً:  RATE_LIMIT_MAX=5000 npm start');
    console.log(`${'═'.repeat(60)}\n`);
    process.exit(2);
  }
  return { status: res.status, data, res };
}
const login = (email, password) => call('POST', '/api/auth/login', { body: { email, password } });
/* لوحة المنصة لها هويّتها ومسار دخولها المستقلّان */
const adminLogin = (email = 'admin@raqeem.sa', password = 'Admin@123', totp) =>
  call('POST', '/api/admin/auth/login', { body: { email, password, ...(totp ? { totp } : {}) } });

function ok(name, cond, detail = '') {
  if (cond) { pass++; lines.push(`  ✔ ${name}`); }
  else { fail++; lines.push(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
  return !!cond;
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `المتوقع ${JSON.stringify(expected)} والفعلي ${JSON.stringify(actual)}`);
const near = (name, actual, expected, tol = 0.51) =>
  ok(name, Math.abs(Number(actual) - Number(expected)) <= tol, `المتوقع ≈${expected} والفعلي ${actual}`);

const sections = [];
const section = (title, fn) => sections.push({ title, fn });

/* ═════════ ١. المصادقة والصلاحيات (RBAC) ═════════ */
section('١. المصادقة والصلاحيات (RBAC)', async () => {
  ok('رفض بيانات دخول خاطئة', (await login('admin@riyadh-qu.sa', 'nope')).status === 401);
  ok('رفض حساب غير موجود', (await login('ghost@x.sa', 'x')).status === 401);

  const roles = ['admin@riyadh-qu.sa:Admin@123:owner', 'branch1@riyadh-qu.sa:Branch@123:branch_manager',
    'supervisor@riyadh-qu.sa:Super@123:supervisor', 'finance@riyadh-qu.sa:Finance@123:finance',
    'hr@riyadh-qu.sa:Hr@123456:hr', 'committee@riyadh-qu.sa:Lead@123:committee_lead',
    'teacher@riyadh-qu.sa:Teach@123:teacher', 'employee@riyadh-qu.sa:Emp@1234:employee',
    'support@riyadh-qu.sa:Support@123:support', 'auditor@riyadh-qu.sa:Audit@123:auditor'];
  for (const spec of roles) {
    const [email, pw, roleKey] = spec.split(':');
    const r = await login(email, pw);
    S[roleKey] = r.data?.accessToken;
    S['u_' + roleKey] = r.data?.user;
    S['s_' + roleKey] = r.data;
    ok(`دخول الدور «${roleKey}»`, r.status === 200 && r.data.user.role.key === roleKey, `status ${r.status}`);
  }

  /*
   * العدد يُقرأ من الكتالوج لا يُكتَب رقماً.
   *
   * كان `=== 60` في ثلاثة مواضع، فكلُّ صلاحيةٍ تُضاف تُسقط ثلاثة فحوصٍ صحيحة
   * وتُوهم بانكسارٍ ليس فيها. والمقصد «يملك كلَّ ما في الكتالوج» لا «ستّون».
   */
  ok('الجلسة تحمل كتالوج الصلاحيات', S.s_owner.permissions.length >= 60);
  ok('مدير الجهة يملك كل الصلاحيات', S.s_owner.permissions.length === ALL_PERMS,
    `${S.s_owner.permissions.length} من ${ALL_PERMS}`);
  ok('المعلم لا يرى صلاحيات مالية', !S.s_teacher.permissions.some(p => p.startsWith('finance.')));
  ok('المحاسب لا يرى نتائج تقييم المعلمين', !S.s_finance.permissions.includes('forms.results'));
  ok('المدقق للاطلاع فقط (لا صلاحيات إنشاء)',
    !S.s_auditor.permissions.some(p => ['tasks.create', 'users.manage', 'finance.request'].includes(p)));

  ok('رفض الوصول بدون رمز', (await call('GET', '/api/org/users')).status === 401);
  ok('رفض رمز مُلفّق', (await call('GET', '/api/org/users', { token: 'aaa.bbb.ccc' })).status === 401);
  const tampered = S.teacher.split('.').slice(0, 2).join('.') + '.XXXX';
  ok('رفض رمز مُعدَّل التوقيع', (await call('GET', '/api/org/users', { token: tampered })).status === 401);
  ok('منع المعلم من قائمة المستخدمين', (await call('GET', '/api/org/users', { token: S.teacher })).status === 403);
  ok('منع المعلم من سجل التدقيق', (await call('GET', '/api/audit', { token: S.teacher })).status === 403);
  ok('منع المعلم من إعدادات الجهة', (await call('PATCH', '/api/org/tenant', { token: S.teacher, body: { name: 'x' } })).status === 403);

  const refreshed = await call('POST', '/api/auth/refresh', { body: { refreshToken: S.s_owner.refreshToken } });
  ok('تجديد الجلسة برمز التحديث', refreshed.status === 200 && !!refreshed.data.accessToken);
  ok('رفض رمز تحديث مُلفّق', (await call('POST', '/api/auth/refresh', { body: { refreshToken: 'x.y' } })).status === 401);
});

/* ═════════ ٢. العزل متعدد المستأجرين والفروع ═════════ */
section('٢. العزل (Multi-Tenant) والفروع', async () => {
  const b = await call('GET', '/api/org/branches', { token: S.owner });
  S.branches = b.data;
  ok('مدير الجهة يرى كل فروعها', b.data.length >= 4);
  ok('المعلم يرى فرعه فقط', S.s_teacher.branches.length === 1);
  ok('مدير الفرع يرى فروعه المصرّحة', S.s_branch_manager.branches.length === 2);

  const t3 = S.branches.find(x => x.code === 'B03');
  const cross = await call('GET', `/api/tasks?branch_id=${t3.id}`, { token: S.teacher });
  ok('فلترة الفرع تمنع تسريب بيانات فرع غير مصرّح', (cross.data || []).every(t => t.branch_id !== t3.id));

  const alien = await call('PATCH', `/api/org/branches/${t3.id}`, { token: S.teacher, body: { name: 'x' } });
  ok('منع تعديل فرع غير مصرّح', alien.status === 403);

  const ghost = await call('GET', '/api/tasks/999999', { token: S.owner });
  ok('سجل غير موجود يُعامل كـ 404', ghost.status === 404);

  const dash = await call('GET', '/api/dashboard', { token: S.teacher });
  ok('لوحة المعلم محصورة بفرعه', dash.data.branches.length === 1);

  const scoped = await call('GET', '/api/dashboard', { token: S.owner, headers: { 'x-branch-id': String(t3.id) } });
  ok('مبدّل الفروع يغيّر نطاق اللوحة', scoped.status === 200);
});

/* ═════════ ٣. الفصول الدراسية والتجميد ═════════ */
section('٣. الفصول والتجميد (Immutability)', async () => {
  const terms = (await call('GET', '/api/terms', { token: S.owner })).data;
  S.terms = terms;
  const closed = terms.find(t => t.status === 'closed');
  const current = terms.find(t => t.is_current);
  ok('يوجد فصل حالي وفصل مؤرشف', !!closed && !!current);

  const archivedTasks = (await call('GET', `/api/tasks?term_id=${closed.id}`, { token: S.owner })).data;
  ok('مهام الفصل المؤرشف موسومة بالقفل', archivedTasks.length > 0 && archivedTasks.every(t => t.is_locked));

  const tid = archivedTasks[0].id;
  const upd = await call('PATCH', `/api/tasks/${tid}`, { token: S.owner, body: { title: 'محاولة تعديل' } });
  ok('منع تعديل مهمة في فصل مؤرشف (423)', upd.status === 423 && upd.data.error.code === 'TERM_CLOSED');
  const del = await call('DELETE', `/api/tasks/${tid}`, { token: S.owner });
  ok('منع حذف مهمة في فصل مؤرشف', del.status === 423);
  const still = (await call('GET', `/api/tasks/${tid}`, { token: S.owner })).data;
  ok('العنوان لم يتغير فعلياً بعد المحاولة', still.title === archivedTasks[0].title);

  const editTerm = await call('PATCH', `/api/terms/${closed.id}`, { token: S.owner, body: { name: 'x' } });
  ok('منع تعديل بيانات الفصل المؤرشف', editTerm.status === 423);

  const preview = await call('GET', `/api/terms/${current.id}/rollover/preview`, { token: S.owner });
  ok('معاينة الترحيل تُرجع الموظفين والمهام واللجان',
    preview.data.staff.length > 0 && preview.data.committees.length > 0 && Array.isArray(preview.data.open_tasks));
  ok('معاينة الترحيل تحصر العهد والميزانيات',
    typeof preview.data.stats.custody_total === 'number' && typeof preview.data.stats.budgets_remaining === 'number');
  ok('منع المعلم من معالج الإغلاق', (await call('GET', `/api/terms/${current.id}/rollover/preview`, { token: S.teacher })).status === 403);
});

/* ═════════ ٤. اللجان والمهام والقوالب ═════════ */
section('٤. اللجان والمهام والقوالب', async () => {
  const created = await call('POST', '/api/tasks', {
    token: S.owner, body: { title: 'مهمة تدقيق', priority: 'urgent', assignee_id: S.u_teacher.id,
      due_date: '2026-12-31', start_date: '2026-12-01', weight: 3 }
  });
  ok('إنشاء مهمة', created.status === 201);
  S.taskId = created.data.id;

  const one = (await call('GET', `/api/tasks/${S.taskId}`, { token: S.owner })).data;
  eq('الأولوية محفوظة', one.priority, 'urgent');
  eq('الوزن النسبي محفوظ', one.weight, 3);
  eq('حالة البداية', one.status, 'todo');

  const mine = (await call('GET', '/api/tasks?mine=1', { token: S.teacher })).data;
  ok('المعلم يرى المهمة المسندة إليه', mine.some(t => t.id === S.taskId));

  const upd = await call('PATCH', `/api/tasks/${S.taskId}`, { token: S.teacher, body: { status: 'done' } });
  eq('إتمام المهمة يضبط الإنجاز على ١٠٠٪', upd.data.progress, 100);
  ok('إتمام المهمة يسجّل وقت الإكمال', !!upd.data.completed_at);

  const reassign = await call('PATCH', `/api/tasks/${S.taskId}`, { token: S.teacher, body: { assignee_id: S.u_employee.id } });
  ok('منع المعلم من إعادة الإسناد (لا يملك tasks.assign)', reassign.status === 403);

  const overdue = (await call('GET', '/api/tasks?overdue=1', { token: S.owner })).data;
  ok('فلتر المتأخرة يُرجع مهاماً تجاوزت الاستحقاق فقط',
    overdue.every(t => t.status !== 'done' && t.due_date < new Date().toISOString().slice(0, 10)));

  const gantt = (await call('GET', '/api/tasks/view/gantt', { token: S.owner })).data;
  ok('مخطط جانت يُرجع عناصر بتواريخ', gantt.items.length > 0 && gantt.items.every(i => i.start && i.end));
  ok('مخطط جانت يحمل الاعتماديات', gantt.items.some(i => Array.isArray(i.depends_on)));

  const reorder = await call('POST', '/api/tasks/reorder', {
    token: S.owner, body: { items: [{ id: S.taskId, status: 'review', order_index: 0 }] } });
  ok('إعادة ترتيب كانبان', reorder.status === 200);
  eq('الحالة تغيّرت بالسحب والإفلات', (await call('GET', `/api/tasks/${S.taskId}`, { token: S.owner })).data.status, 'review');

  const tpls = (await call('GET', '/api/tasks/templates', { token: S.owner })).data;
  ok('مكتبة القوالب متاحة', tpls.length >= 3 && tpls[0].items.length > 0);
  const tpl = tpls[0];
  const applied = await call('POST', `/api/tasks/templates/${tpl.id}/apply`, {
    token: S.owner, body: { start_date: '2026-11-01', assignee_map: { [tpl.items[0].title]: S.u_teacher.id } } });
  eq('استنساخ القالب ينشئ كل عناصره', applied.data.created, tpl.items.length);
  const cloned = (await call('GET', '/api/tasks', { token: S.owner })).data.filter(t => t.title === tpl.items[0].title);
  ok('المهام المستنسخة تحمل تواريخ محسوبة', cloned.length > 0 && !!cloned[0].start_date && !!cloned[0].due_date);
  ok('المهام المستنسخة أُسندت حسب الخريطة', cloned.some(t => t.assignee_id === S.u_teacher.id));

  const coms = (await call('GET', '/api/tasks/committees', { token: S.owner })).data;
  ok('اللجان تُرجع الأعضاء وعدّاد المهام',
    coms.length >= 5 && coms.every(c => Array.isArray(c.members)) && coms.some(c => c.tasks_count > 0));
});

/* ═════════ ٥. الحضور والنطاق الجغرافي والرواتب ═════════ */
section('٥. الحضور الجغرافي والرواتب', async () => {
  const today = (await call('GET', '/api/hr/attendance/today', { token: S.employee })).data;
  ok('حالة التحضير تُرجع الفرع والنطاق', !!today.branch && today.geofence_radius > 0);
  ok('حالة التحضير تُرجع دوام اليوم', !!today.workday?.start);

  const far = await call('POST', '/api/hr/attendance/check', { token: S.employee, body: { lat: 25.5, lng: 47.5 } });
  ok('رفض التحضير خارج النطاق', far.status === 422 && far.data.code === 'OUT_OF_RANGE');
  ok('الرد يوضح المسافة والنطاق', far.data.distance > far.data.radius);

  const near1 = await call('POST', '/api/hr/attendance/check', {
    token: S.employee, body: { lat: today.branch.lat + 0.0003, lng: today.branch.lng } });
  ok('قبول التحضير داخل النطاق', [200, 409].includes(near1.status), `status ${near1.status}`);
  if (near1.status === 200) {
    ok('التحضير يحسب المسافة بمعادلة هافرساين',
      near1.data.distance >= 20 && near1.data.distance <= 60, `distance ${near1.data.distance}`);
    const out = await call('POST', '/api/hr/attendance/check', {
      token: S.employee, body: { lat: today.branch.lat, lng: today.branch.lng } });
    ok('تسجيل الانصراف بعد الحضور', out.status === 200 && out.data.action === 'check_out');
    const third = await call('POST', '/api/hr/attendance/check', {
      token: S.employee, body: { lat: today.branch.lat, lng: today.branch.lng } });
    ok('منع تكرار التحضير بعد اكتمال اليوم', third.status === 409);
  }
  ok('رفض التحضير دون إحداثيات',
    (await call('POST', '/api/hr/attendance/check', { token: S.employee, body: {} })).status === 400);

  const file = (await call('GET', `/api/hr/employees/${S.u_teacher.id}/file`, { token: S.hr })).data;
  ok('ملف الموظف يجمع الحضور والإجازات والمهام والتقييم',
    !!file.employee && !!file.attendance_summary && !!file.tasks && 'evaluation' in file);
  ok('الموظف يرى ملفه الشخصي',
    (await call('GET', `/api/hr/employees/${S.u_teacher.id}/file`, { token: S.teacher })).status === 200);
  ok('منع الموظف من ملفات الآخرين',
    (await call('GET', `/api/hr/employees/${S.u_finance.id}/file`, { token: S.teacher })).status === 403);

  const emp = (await call('GET', '/api/hr/employees', { token: S.hr })).data;
  const target = emp.find(e => e.user_id === S.u_teacher.id);
  const now = new Date();
  const gen = await call('POST', '/api/hr/payroll/generate', {
    token: S.hr, body: { year: now.getFullYear(), month: now.getMonth() + 1 } });
  ok('إنشاء مسير رواتب', gen.status === 201 && gen.data.count > 0);
  const run = (await call('GET', `/api/hr/payroll/${gen.data.runId}`, { token: S.hr })).data;
  const item = run.items.find(i => i.user_id === S.u_teacher.id);
  ok('المسير يشمل كل موظف نشط', run.items.length === gen.data.count);
  eq('الراتب الأساسي مطابق لملف الموظف', item.basic, target.basic_salary);
  eq('البدلات مطابقة', item.allowances, target.allowances);
  near('الصافي = (أساسي + بدلات) − الخصومات',
    item.net, item.basic + item.allowances - item.absence_deduction - item.late_deduction - item.advance_deduction, 0.02);
  near('إجمالي المسير = مجموع الصافي', run.run.total, run.items.reduce((s, i) => s + i.net, 0), 0.05);
  ok('تفاصيل الاحتساب تُرجع أيام الحضور والغياب',
    item.details && 'present' in item.details && 'absent' in item.details);
  ok('خصم الغياب متسق مع أيام الغياب',
    (item.details.absent === 0) === (item.absence_deduction === 0));

  eq('اعتماد المسير',
    (await call('POST', `/api/hr/payroll/${gen.data.runId}/approve`, { token: S.hr, body: { status: 'approved' } })).data.status, 'approved');
  ok('منع المعلم من إنشاء مسير رواتب',
    (await call('POST', '/api/hr/payroll/generate', { token: S.teacher, body: {} })).status === 403);

  const leave = await call('POST', '/api/hr/leaves', {
    token: S.teacher, body: { start_date: '2027-01-05', end_date: '2027-01-09', reason: 'تدقيق' } });
  eq('احتساب أيام الإجازة شامل الطرفين', leave.data.days, 5);
  ok('اعتماد الإجازة',
    (await call('POST', `/api/hr/leaves/${leave.data.id}/decide`, { token: S.hr, body: { action: 'approve' } })).status === 200);
  ok('منع المعلم من اعتماد الإجازات',
    (await call('POST', `/api/hr/leaves/${leave.data.id}/decide`, { token: S.teacher, body: { action: 'approve' } })).status === 403);
});

/* ═════════ ٦. الدورة المالية ومحرك الحالة ═════════ */
section('٦. الدورة المالية ومحرك الحالة', async () => {
  const wfs = (await call('GET', '/api/finance/workflows', { token: S.owner })).data;
  ok('مسارات الاعتماد معرّفة بخطواتها', wfs.length >= 3 && wfs.every(w => w.steps.length >= 2));
  ok('يوجد مسار ثلاثي المراحل للمشتريات الكبرى', wfs.some(w => w.steps.length === 3));

  const budgets = (await call('GET', '/api/finance/budgets', { token: S.finance })).data;
  const budget = budgets[0];
  const spentBefore = budget.spent;

  const req = await call('POST', '/api/finance/requests', {
    token: S.employee, body: { title: 'طلب تدقيق آلي', amount: 7500, type: 'expense', budget_id: budget.id } });
  ok('رفع طلب مالي', req.status === 201 && /^FR-/.test(req.data.number));
  S.reqId = req.data.id;

  const detail = () => call('GET', `/api/finance/requests/${S.reqId}`, { token: S.owner }).then(r => r.data);
  let d = await detail();
  ok('تفاصيل الطلب تُرجع اسم مقدّمه', d.requester_name === S.u_employee.name);
  eq('المسار الابتدائي عند الخطوة صفر', d.current_step, 0);
  eq('حالة البداية', d.status, 'pending');
  eq('المرحلة الأولى معروضة كحالية', d.timeline[0].state, 'current');

  ok('منع المالية من تجاوز مرحلة المشرف',
    (await call('POST', `/api/finance/requests/${S.reqId}/decide`, { token: S.finance, body: { action: 'approve' } })).status === 403);
  ok('منع المعلم من الاعتماد إطلاقاً',
    (await call('POST', `/api/finance/requests/${S.reqId}/decide`, { token: S.teacher, body: { action: 'approve' } })).status === 403);

  const s1 = await call('POST', `/api/finance/requests/${S.reqId}/decide`, {
    token: S.supervisor, body: { action: 'approve', note: 'مطابق للخطة' } });
  eq('بعد اعتماد المشرف: قيد الاعتماد', s1.data.status, 'in_review');
  d = await detail();
  eq('المرحلة الأولى صارت معتمدة', d.timeline[0].state, 'approved');
  ok('السجل يحفظ اسم المعتمد', d.timeline[0].by === S.u_supervisor.name);
  ok('السجل يحفظ ملاحظة الاعتماد', d.timeline[0].note === 'مطابق للخطة');
  eq('المرحلة الثانية أصبحت الحالية', d.timeline[1].state, 'current');
  ok('منع المشرف من اعتماد المرحلة المالية',
    (await call('POST', `/api/finance/requests/${S.reqId}/decide`, { token: S.supervisor, body: { action: 'approve' } })).status === 403);

  const s2 = await call('POST', `/api/finance/requests/${S.reqId}/decide`, {
    token: S.finance, body: { action: 'approve', note: 'يوجد رصيد' } });
  eq('بعد الاعتماد المالي: معتمد نهائياً', s2.data.status, 'approved');
  const budgetAfter = (await call('GET', '/api/finance/budgets', { token: S.finance })).data.find(b => b.id === budget.id);
  near('الاعتماد النهائي يخصم من الميزانية', budgetAfter.spent, spentBefore + 7500, 0.01);
  ok('منع إجراء جديد على طلب مُغلق',
    (await call('POST', `/api/finance/requests/${S.reqId}/decide`, { token: S.finance, body: { action: 'approve' } })).status === 409);

  const req2 = await call('POST', '/api/finance/requests', { token: S.employee, body: { title: 'طلب للرفض', amount: 900 } });
  eq('الرفض يُغلق الطلب فوراً',
    (await call('POST', `/api/finance/requests/${req2.data.id}/decide`, { token: S.supervisor, body: { action: 'reject', note: 'غير مبرر' } })).data.status, 'rejected');

  const req3 = await call('POST', '/api/finance/requests', { token: S.employee, body: { title: 'قابل للتعديل', amount: 100 } });
  ok('تعديل طلب قبل بدء الاعتماد',
    (await call('PATCH', `/api/finance/requests/${req3.data.id}`, { token: S.employee, body: { amount: 250 } })).status === 200);
  await call('POST', `/api/finance/requests/${req3.data.id}/decide`, { token: S.supervisor, body: { action: 'approve' } });
  ok('منع تعديل طلب بدأت دورته',
    (await call('PATCH', `/api/finance/requests/${req3.data.id}`, { token: S.employee, body: { amount: 999 } })).status === 409);

  const inv = await call('POST', '/api/finance/invoices', {
    token: S.finance, body: { total: 1150, vendor: 'مورد التدقيق', request_id: S.reqId } });
  const created = (await call('GET', `/api/finance/invoices?request_id=${S.reqId}`, { token: S.finance })).data
    .find(i => i.id === inv.data.id);
  near('احتساب الصافي من الإجمالي بنسبة ١٥٪', created.amount, 1000, 0.02);
  near('احتساب الضريبة', created.vat, 150, 0.02);
  near('الصافي + الضريبة = الإجمالي', created.amount + created.vat, created.total, 0.02);

  const wf = await call('POST', '/api/finance/workflows', {
    token: S.owner, body: { name: 'مسار تدقيق', doc_type: 'expense',
      steps: [{ name: 'المرحلة أ', role_key: 'supervisor', permission: 'finance.approve_supervisor' },
              { name: 'المرحلة ب', role_key: 'finance', permission: 'finance.approve_finance' },
              { name: 'المرحلة ج', role_key: 'owner', permission: 'finance.manage' }] } });
  ok('بناء مسار اعتماد جديد', wf.status === 201);
  const req4 = await call('POST', '/api/finance/requests', {
    token: S.employee, body: { title: 'طلب ثلاثي المراحل', amount: 40000, workflow_id: wf.data.id } });
  eq('الطلب يتبع المسار المخصص بثلاث مراحل',
    (await call('GET', `/api/finance/requests/${req4.data.id}`, { token: S.owner })).data.timeline.length, 3);
  await call('POST', `/api/finance/requests/${req4.data.id}/decide`, { token: S.supervisor, body: { action: 'approve' } });
  await call('POST', `/api/finance/requests/${req4.data.id}/decide`, { token: S.finance, body: { action: 'approve' } });
  eq('لا يزال قيد الاعتماد قبل المرحلة الثالثة',
    (await call('GET', `/api/finance/requests/${req4.data.id}`, { token: S.owner })).data.status, 'in_review');
  eq('اكتمال المراحل الثلاث',
    (await call('POST', `/api/finance/requests/${req4.data.id}/decide`, { token: S.owner, body: { action: 'approve' } })).data.status, 'approved');
});

/* ═════════ ٧. النماذج والتقييم والمؤشرات ═════════ */
section('٧. النماذج والتقييم ومؤشرات الأداء', async () => {
  ok('رفض نموذج بلا حقول',
    (await call('POST', '/api/forms', { token: S.owner, body: { title: 'بلا حقول', schema: { fields: [] } } })).status === 400);
  ok('رفض نوع حقل غير مدعوم',
    (await call('POST', '/api/forms', { token: S.owner, body: { title: 'x', schema: { fields: [{ id: 'a', label: 'x', type: 'unknown' }] } } })).status === 400);
  ok('رفض قائمة اختيار بلا خيارات',
    (await call('POST', '/api/forms', { token: S.owner, body: { title: 'x', schema: { fields: [{ id: 'a', label: 'x', type: 'select' }] } } })).status === 400);

  const form = await call('POST', '/api/forms', {
    token: S.owner, body: { title: 'نموذج تدقيق', type: 'evaluation', schema: { fields: [
      { id: 'r1', type: 'rating', label: 'الانضباط', max: 5, weight: 40, required: true },
      { id: 'r2', type: 'rating', label: 'الجودة', max: 5, weight: 40, required: true },
      { id: 'c1', type: 'checkbox', label: 'أنهى التدريب', weight: 20 },
      { id: 't1', type: 'textarea', label: 'ملاحظات' }
    ] } } });
  ok('بناء نموذج بحقول موزونة', form.status === 201);
  S.formId = form.data.id;

  ok('رفض التعبئة بحقل إلزامي ناقص',
    (await call('POST', `/api/forms/${S.formId}/submit`, { token: S.supervisor, body: { answers: { r1: 5 } } })).status === 400);

  const full = await call('POST', `/api/forms/${S.formId}/submit`, {
    token: S.supervisor, body: { subject_user_id: S.u_teacher.id, answers: { r1: 5, r2: 5, c1: true, t1: 'ممتاز' } } });
  eq('الدرجة الكاملة = مجموع الأوزان', full.data.score, 100);
  eq('الحد الأقصى = مجموع الأوزان', full.data.max_score, 100);

  const half = await call('POST', `/api/forms/${S.formId}/submit`, {
    token: S.supervisor, body: { subject_user_id: S.u_employee.id, answers: { r1: 3, r2: 4, c1: false } } });
  near('احتساب موزون صحيح (٣/٥×٤٠ + ٤/٥×٤٠ + ٠)', half.data.score, 56, 0.11);

  const subs = (await call('GET', `/api/forms/${S.formId}/submissions`, { token: S.owner })).data;
  eq('النتائج تُرجع الإجابتين', subs.submissions.length, 2);
  ok('الإجابات محفوظة كاملة', subs.submissions.every(s => Object.keys(s.answers).length >= 3));
  ok('منع المعلم من الاطلاع على النتائج',
    (await call('GET', `/api/forms/${S.formId}/submissions`, { token: S.teacher })).status === 403);

  const re = await call('POST', '/api/forms/kpi/recompute', { token: S.owner });
  ok('إعادة احتساب المؤشرات', re.status === 200 && re.data.updated > 0);
  const kpi = (await call('GET', '/api/forms/kpi/overview', { token: S.owner })).data;
  const row = kpi.leaderboard.find(k => k.user_id === S.u_teacher.id);
  ok('مؤشر المعلم محسوب', !!row);
  ok('نسبة الإنجاز بين ٠ و١٠٠', row.completion_rate >= 0 && row.completion_rate <= 100);
  ok('نسبة الحضور بين ٠ و١٠٠', row.attendance_rate >= 0 && row.attendance_rate <= 100);
  near('المؤشر العام = ٥٠٪ إنجاز + ٣٠٪ حضور + ٢٠٪ تقييم − خصم التأخير',
    row.score, Math.max(0, row.completion_rate * 0.5 + row.attendance_rate * 0.3 + row.eval_avg * 0.2 - Math.min(15, row.tasks_overdue * 3)), 0.15);
  ok('لوحة المؤشرات تشمل اللجان', kpi.leaderboard.some(k => k.committee_id));
  ok('المعلم يرى مؤشره فقط',
    (await call('GET', '/api/forms/kpi/overview', { token: S.teacher })).data.leaderboard.every(k => k.user_id === S.u_teacher.id));
});

/* ═════════ ٨. التواصل السياقي والتذاكر ═════════ */
section('٨. التواصل السياقي ومركز التذاكر', async () => {
  ok('إرسال رسالة سياقية على مهمة',
    (await call('POST', `/api/comms/conversations/task/${S.taskId}/messages`, { token: S.owner, body: { body: 'رسالة تدقيق' } })).status === 201);
  ok('رفض رسالة فارغة',
    (await call('POST', `/api/comms/conversations/task/${S.taskId}/messages`, { token: S.owner, body: { body: '   ' } })).status === 400);
  ok('رفض سياق غير مدعوم',
    (await call('GET', `/api/comms/conversations/unknown/${S.taskId}/messages`, { token: S.owner })).status === 400);

  const msgs = (await call('GET', `/api/comms/conversations/task/${S.taskId}/messages`, { token: S.teacher })).data;
  ok('المكلّف يرى رسائل مهمته', msgs.messages.length >= 1);
  ok('علامة ملكية الرسالة صحيحة', msgs.messages.every(m => typeof m.mine === 'boolean'));
  ok('حجب المحادثة عن غير المرتبطين',
    (await call('GET', `/api/comms/conversations/task/${S.taskId}/messages`, { token: S.finance })).status === 403);

  const list = (await call('GET', '/api/comms/conversations', { token: S.owner })).data;
  ok('قائمة المحادثات تُرجع آخر رسالة وعدّاد غير المقروء', list.length > 0 && list.every(c => 'unread' in c));

  const tk = await call('POST', '/api/comms/tickets', {
    token: S.teacher, body: { subject: 'تذكرة تدقيق', body: 'وصف المشكلة', category: 'technical', priority: 'high' } });
  ok('رفع تذكرة', tk.status === 201 && /^TK-/.test(tk.data.number));
  ok('التذكرة تحمل موعد اتفاقية الخدمة', !!tk.data.sla_due_at);
  const dueIn = (new Date(tk.data.sla_due_at) - Date.now()) / 3600000;
  ok('مدة الاستجابة ٢٤ ساعة كما في الإعدادات', dueIn > 23 && dueIn <= 24.2, `${dueIn.toFixed(1)}h`);

  const own = (await call('GET', '/api/comms/tickets', { token: S.teacher })).data;
  ok('مُقدّم التذكرة يرى تذاكره فقط', own.every(t => t.requester_id === S.u_teacher.id));
  const all = (await call('GET', '/api/comms/tickets', { token: S.support })).data;
  ok('الدعم يرى جميع التذاكر', all.length > own.length);

  ok('رد فريق الدعم',
    (await call('POST', `/api/comms/tickets/${tk.data.id}/reply`, { token: S.support, body: { body: 'تم الاستلام' } })).status === 201);
  const after = (await call('GET', `/api/comms/tickets/${tk.data.id}`, { token: S.support })).data;
  ok('الرد يسجّل زمن أول استجابة', !!after.first_response_at);
  eq('الرد ينقل التذكرة لقيد المعالجة', after.status, 'in_progress');
  ok('الرد يُسند التذكرة تلقائياً', after.assignee_id === S.u_support.id);

  await call('POST', `/api/comms/tickets/${tk.data.id}/reply`, { token: S.support, body: { body: 'ملاحظة داخلية', is_internal: true } });
  ok('الملاحظات الداخلية محجوبة عن مُقدّم التذكرة',
    !(await call('GET', `/api/comms/tickets/${tk.data.id}`, { token: S.teacher })).data.replies.some(r => r.is_internal));
  ok('الدعم يرى الملاحظات الداخلية',
    (await call('GET', `/api/comms/tickets/${tk.data.id}`, { token: S.support })).data.replies.some(r => r.is_internal));
  ok('منع المعلم من تغيير حالة التذكرة',
    (await call('PATCH', `/api/comms/tickets/${tk.data.id}`, { token: S.teacher, body: { status: 'closed' } })).status === 403);
  eq('الدعم يغلق التذكرة',
    (await call('PATCH', `/api/comms/tickets/${tk.data.id}`, { token: S.support, body: { status: 'resolved' } })).data.status, 'resolved');
});

/* ═════════ ٩. التكامل والواجهة العامة ═════════ */
section('٩. التكامل والواجهة البرمجية العامة', async () => {
  const scopes = (await call('GET', '/api/api-keys/scopes', { token: S.owner })).data;
  ok('كتالوج النطاقات متاح', scopes.length >= 6);
  ok('رفض مفتاح بلا نطاقات',
    (await call('POST', '/api/api-keys', { token: S.owner, body: { name: 'x', scopes: [] } })).status === 400);

  const key = await call('POST', '/api/api-keys', {
    token: S.owner, body: { name: 'منصة الطلاب — تدقيق', scopes: ['teachers.read', 'branches.read', 'attendance.read'], rate_limit: 6 } });
  ok('إصدار مفتاح ربط', key.status === 201 && key.data.key.includes('.'));
  const API = key.data.key;
  const listed = (await call('GET', '/api/api-keys', { token: S.owner })).data.find(k => k.id === key.data.id);
  ok('المفتاح السرّي لا يُخزَّن ولا يُعاد عرضه', !JSON.stringify(listed).includes(API.split('.')[1]));

  ok('رفض الوصول بدون مفتاح', (await call('GET', '/api/v1/teachers')).status === 401);
  ok('رفض مفتاح خاطئ', (await call('GET', '/api/v1/teachers', { token: 'raqeem_rq_zzz.bad' })).status === 401);

  const idx = await call('GET', '/api/v1/', { token: API });
  ok('صفحة التوثيق تُرجع النطاقات والجهة', idx.status === 200 && idx.data.tenant.code === 'RQ');

  const teachers = await call('GET', '/api/v1/teachers', { token: API });
  ok('استعلام المعلمين يعمل', teachers.status === 200 && teachers.data.data.length >= 3);
  ok('نتائج الواجهة العامة لا تسرّب كلمات المرور', !JSON.stringify(teachers.data).includes('password'));
  ok('بيانات معلم محدد مع ملخص الحضور',
    (await call('GET', `/api/v1/teachers/${teachers.data.data[0].id}`, { token: API })).data.data.attendance !== null);
  ok('منع نطاق غير مصرّح به', (await call('GET', '/api/v1/kpi', { token: API })).status === 403);

  let limited = false, headerSeen = false;
  for (let i = 0; i < 10; i++) {
    const r = await call('GET', '/api/v1/branches', { token: API, expect429: true });
    if (r.res.headers.get('x-ratelimit-limit') === '6') headerSeen = true;
    if (r.status === 429) { limited = true; break; }
  }
  ok('الحد من الطلبات يُطبَّق بحسب سقف المفتاح', limited);
  ok('رؤوس الحد من الطلبات معلنة', headerSeen);

  await call('DELETE', `/api/api-keys/${key.data.id}`, { token: S.owner });
  ok('إبطال المفتاح يوقفه فوراً', (await call('GET', '/api/v1/teachers', { token: API })).status === 401);
});

/* ═════════ ١١. التقويم المزدوج والتوطين ═════════ */
section('١١. التقويم المزدوج والتوطين', async () => {
  eq('حفظ تفضيل التقويم',
    (await call('PATCH', '/api/auth/me', { token: S.owner, body: { calendar_pref: 'gregorian' } })).data.user.calendar_pref, 'gregorian');
  await call('PATCH', '/api/auth/me', { token: S.owner, body: { calendar_pref: 'hijri' } });
  ok('رفض تفضيل تقويم غير معروف',
    (await call('PATCH', '/api/auth/me', { token: S.owner, body: { calendar_pref: 'julian' } })).data.user.calendar_pref === 'hijri');

  const t = (await call('GET', '/api/tasks', { token: S.owner })).data[0];
  ok('الطوابع الزمنية مخزّنة UTC بصيغة ISO', /Z$/.test(t.created_at) && !Number.isNaN(Date.parse(t.created_at)));
  const html = (await call('POST', '/api/reports/audit/export', { token: S.owner, body: { format: 'pdf' }, raw: true })).buf.toString();
  ok('المستند الرسمي يعرض التقويمين معاً', /[٠-٩]\s*هـ/.test(html) && /[٠-٩]\s*م\s*</.test(html));
  ok('المستند بالاتجاه من اليمين لليسار', html.includes('dir="rtl"'));
});

/* ═════════ ١٢. الاستيراد ═════════ */
section('١٢. استيراد البيانات الأولية', async () => {
  const types = (await call('GET', '/api/imports/types', { token: S.owner })).data;
  eq('ستة أنواع استيراد مدعومة', types.length, 6);
  ok('كل نوع يعلن أعمدته الإلزامية', types.every(t => t.columns.some(c => c.required)));

  for (const t of types) {
    const tmpl = await call('GET', `/api/imports/template/${t.key}`, { token: S.owner, raw: true });
    if (!ok(`قالب Excel صالح للنوع «${t.key}»`, tmpl.status === 200 && tmpl.buf.slice(0, 2).toString() === 'PK')) break;
  }

  const hdr = 'الاسم الكامل,البريد الإلكتروني,الجوال,الدور,رمز الفرع,كلمة المرور المبدئية';
  const stamp = Date.now();
  const csv = '﻿' + hdr + '\n' +
    `سالم التميمي,salem.${stamp}@test.sa,0501112223,teacher,B01,Raqeem@2026\n` +
    'بريد خاطئ,not-an-email,0501112224,teacher,B01,Raqeem@2026\n' +
    `دور مجهول,ok1.${stamp}@test.sa,0501112225,ghost,B01,Raqeem@2026\n` +
    `فرع مجهول,ok2.${stamp}@test.sa,0501112226,teacher,ZZZ,Raqeem@2026\n` +
    `مكرر,salem.${stamp}@test.sa,0501112227,teacher,B01,Raqeem@2026\n` +
    `كلمة قصيرة,ok3.${stamp}@test.sa,0501112228,teacher,B01,123\n` +
    ',,0501112229,teacher,B01,Raqeem@2026\n';
  const mk = () => { const fd = new FormData(); fd.append('type', 'users');
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'users.csv'); return fd; };

  const v = await call('POST', '/api/imports/validate', { token: S.owner, body: mk() });
  eq('عدد الصفوف الكلي', v.data.total, 7);
  eq('صف واحد صالح فقط', v.data.valid_rows.length, 1);
  eq('ستة صفوف مرفوضة', new Set(v.data.errors.map(e => e.row)).size, 6);
  ok('الصف الذي يخالف شرطين يُبلَّغ عنهما معاً', v.data.errors.length === 7);
  const fields = v.data.errors.map(e => e.field);
  ok('رصد البريد غير الصحيح والمكرر', fields.filter(f => f === 'email').length >= 2);
  ok('رصد الدور المجهول', fields.includes('role_key'));
  ok('رصد الفرع المجهول', fields.includes('branch_code'));
  ok('رصد كلمة المرور القصيرة', fields.includes('password'));
  ok('رصد الحقل الإلزامي الفارغ', fields.includes('name'));
  ok('كل خطأ يحدد رقم صفه', v.data.errors.every(e => Number(e.row) >= 2));

  const missingHdr = new FormData();
  missingHdr.append('type', 'users');
  missingHdr.append('file', new Blob(['﻿a,b\n1,2\n'], { type: 'text/csv' }), 'bad.csv');
  const mh = await call('POST', '/api/imports/validate', { token: S.owner, body: missingHdr });
  ok('رصد ترويسة ناقصة الأعمدة', mh.data.errors.length === 1 && mh.data.errors[0].field === 'الترويسة');

  const run = await call('POST', '/api/imports/run', { token: S.owner, body: mk() });
  ok('جدولة الاستيراد في الطابور', run.status === 202 && run.data.queued === 1);
  let batch = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 900));
    batch = (await call('GET', `/api/imports/${run.data.batch_id}`, { token: S.owner })).data;
    if (['done', 'failed'].includes(batch.status)) break;
  }
  eq('اكتمال المعالجة الخلفية', batch.status, 'done');
  eq('صف واحد أُدخل فعلياً', batch.ok_rows, 1);
  const created = (await call('GET', `/api/org/users?q=salem.${stamp}`, { token: S.owner })).data;
  ok('المستخدم المستورد أُنشئ فعلياً', created.length === 1 && created[0].role_key === 'teacher');
  ok('المستخدم المستورد سُكّن في فرعه', created[0].branch_ids.length === 1);
  ok('منع المعلم من الاستيراد', (await call('GET', '/api/imports/types', { token: S.teacher })).status === 403);
});

/* ═════════ ١٣. التقارير والتصدير ═════════ */
section('١٣. محرك التقارير والتصدير', async () => {
  const reports = (await call('GET', '/api/reports', { token: S.owner })).data;
  eq('ثمانية تقارير معرّفة', reports.length, 8);
  ok('كل تقرير يعلن فلاتره', reports.every(r => Array.isArray(r.filters)));

  for (const r of reports) {
    const run = await call('POST', `/api/reports/${r.key}/run`, { token: S.owner, body: { filters: {} } });
    if (!ok(`تشغيل تقرير «${r.label}»`, run.status === 200 && Array.isArray(run.data.rows) && run.data.columns.length > 0,
      `status ${run.status}`)) break;
  }

  const filtered = await call('POST', '/api/reports/tasks/run', { token: S.owner, body: { filters: { status: 'done' } } });
  ok('الفلترة تُطبَّق فعلياً', filtered.data.rows.every(r => r.status === 'مكتملة'));
  ok('الفلاتر المطبّقة معلنة في النتيجة', filtered.data.applied_filters.some(f => f.value === 'مكتملة'));
  ok('ملخّص التقرير محسوب', filtered.data.summary.length > 0);

  const xlsx = await call('POST', '/api/reports/attendance/export', { token: S.owner, body: { format: 'xlsx' }, raw: true });
  ok('تصدير Excel صالح (توقيع ZIP)', xlsx.buf.slice(0, 2).toString() === 'PK');
  ok('ترويسة Excel للتنزيل', /attachment/.test(xlsx.res.headers.get('content-disposition') || ''));
  const csv = await call('POST', '/api/reports/finance/export', { token: S.owner, body: { format: 'csv' }, raw: true });
  ok('تصدير CSV ببادئة BOM للعربية', csv.buf.slice(0, 3).toString('hex') === 'efbbbf');
  ok('محتوى CSV عربي سليم', csv.buf.toString('utf8').includes('رقم الطلب'));
  const html = (await call('POST', '/api/reports/kpi/export', { token: S.owner, body: { format: 'pdf' }, raw: true })).buf.toString('utf8');
  ok('المستند الرسمي مُروّس باسم الجهة', html.includes('مجمّع الرياض لتحفيظ القرآن الكريم'));
  ok('المستند يحتوي جدول البيانات', html.includes('<table'));
  ok('المستند يحمل ترويسة الطباعة', html.includes('@page'));

  ok('منع المعلم من التقارير', (await call('GET', '/api/reports', { token: S.teacher })).status === 403);
  ok('منع تقرير الرواتب عمّن لا يملك صلاحيته',
    (await call('POST', '/api/reports/payroll/run', { token: S.supervisor, body: {} })).status === 400);
});

/* ═════════ ١٤. سجل التدقيق ═════════ */
section('١٤. سجلات التدقيق والامتثال', async () => {
  const a = (await call('GET', '/api/audit?limit=400', { token: S.owner })).data;
  ok('السجل يحوي عمليات كثيرة', a.total > 40, `total ${a.total}`);
  for (const act of ['login', 'create', 'update', 'approve', 'reject', 'export', 'delete']) {
    ok(`توثيق إجراء «${act}»`, a.items.some(i => i.action === act));
  }
  ok('كل سجل يحمل الفاعل والوقت', a.items.every(i => i.created_at && (i.user_name || i.role_key === 'system')));
  ok('سجلات التعديل تحفظ القيم قبل/بعد', a.items.some(i => i.before || i.after));
  ok('الفلترة بالإجراء تعمل',
    (await call('GET', '/api/audit?action=approve', { token: S.owner })).data.items.every(i => i.action === 'approve'));
  ok('البحث النصي في السجل يعمل',
    (await call('GET', '/api/audit?q=' + encodeURIComponent('اعتمد'), { token: S.owner })).data.items.length > 0);

  const p1 = (await call('GET', '/api/audit?limit=5&offset=0', { token: S.owner })).data;
  const p2 = (await call('GET', '/api/audit?limit=5&offset=5', { token: S.owner })).data;
  ok('التصفح بالصفحات يعمل', p1.items.length === 5 && p2.items.length === 5 && p1.items[0].id !== p2.items[0].id);
  ok('المدقق يطّلع على السجل', (await call('GET', '/api/audit', { token: S.auditor })).status === 200);
  ok('حجب السجل عن المحاسب', (await call('GET', '/api/audit', { token: S.finance })).status === 403);
  ok('لا توجد نقطة اتصال لحذف السجل', (await call('DELETE', '/api/audit/1', { token: S.owner })).status === 404);
});

/* ═════════ ١٥. الإشعارات المتكاملة ═════════ */
section('١٥. نظام الإشعارات المتكامل', async () => {
  const vapid = await call('GET', '/api/push/vapid');
  ok('المفتاح العام لإشعارات الدفع متاح دون مصادقة', vapid.status === 200 && vapid.data.publicKey.length > 60);
  ok('خدمة الدفع مفعّلة', vapid.data.enabled === true);

  const n = (await call('GET', '/api/notifications', { token: S.teacher })).data;
  ok('صندوق الإشعارات يُرجع العناصر وعدّاد غير المقروء', Array.isArray(n.items) && typeof n.unread === 'number');
  for (const type of ['task.assigned', 'evaluation.received']) {
    ok(`وصول إشعار «${type}» للمعلم`, n.items.some(i => i.type === type));
  }
  ok('وصول إشعار الاعتماد المالي لمقدّم الطلب',
    (await call('GET', '/api/notifications', { token: S.employee })).data.items.some(i => i.type === 'finance.approved'));
  ok('وصول إشعار الطلب المالي لصاحب صلاحية الاعتماد',
    (await call('GET', '/api/notifications', { token: S.supervisor })).data.items.some(i => i.type === 'finance.pending'));
  ok('وصول إشعار التذكرة لفريق الدعم',
    (await call('GET', '/api/notifications', { token: S.support })).data.items.some(i => i.type === 'ticket.created'));
  ok('الإشعارات معزولة لكل مستخدم', !n.items.some(i => i.user_id !== S.u_teacher.id));

  eq('إشعار تجريبي يُنشأ', (await call('POST', '/api/notifications/test', { token: S.teacher })).data.created, 1);

  const prefs = (await call('GET', '/api/notifications/preferences', { token: S.teacher })).data;
  ok('التفضيلات تُرجع القنوات والفئات', prefs.channels.length === 2 && prefs.categories.length === 6);
  const notifiedFor = async (taskId) =>
    (await call('GET', '/api/notifications?limit=100', { token: S.teacher })).data.items
      .some(i => i.type === 'task.assigned' && i.data?.id === taskId);

  await call('PUT', '/api/notifications/preferences', { token: S.teacher, body: { preferences: { tasks: false } } });
  const silentTask = (await call('POST', '/api/tasks',
    { token: S.owner, body: { title: 'مهمة صامتة', assignee_id: S.u_teacher.id } })).data;
  ok('تعطيل فئة المهام يمنع إشعارها فعلياً', !(await notifiedFor(silentTask.id)));

  await call('PUT', '/api/notifications/preferences', { token: S.teacher, body: { preferences: { tasks: true } } });
  const loudTask = (await call('POST', '/api/tasks',
    { token: S.owner, body: { title: 'مهمة معلنة', assignee_id: S.u_teacher.id } })).data;
  ok('إعادة تفعيل الفئة تُعيد الإشعار', await notifiedFor(loudTask.id));

  const sub = await call('POST', '/api/notifications/subscribe', {
    token: S.teacher, body: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/verify-' + Date.now(),
      keys: { p256dh: 'BJ' + 'a'.repeat(85), auth: 'b'.repeat(22) } }, platform: 'android' } });
  ok('تسجيل جهاز لاستقبال الدفع', sub.status === 201);
  const devices = (await call('GET', '/api/notifications/devices', { token: S.teacher })).data;
  ok('الجهاز يظهر في قائمة الأجهزة', devices.length >= 1 && devices[0].platform === 'android');
  ok('رفض اشتراك ناقص البيانات',
    (await call('POST', '/api/notifications/subscribe', { token: S.teacher, body: { subscription: { endpoint: 'x' } } })).status === 400);

  const bc = await call('POST', '/api/notifications/broadcast', {
    token: S.owner, body: { title: 'إعلان تدقيق', body: 'رسالة عامة' } });
  ok('البث العام يصل جميع المنسوبين', bc.data.created >= 10, `created ${bc.data?.created}`);
  ok('منع المعلم من البث',
    (await call('POST', '/api/notifications/broadcast', { token: S.teacher, body: { title: 'x' } })).status === 403);

  eq('تعليم الكل كمقروء', (await call('POST', '/api/notifications/read', { token: S.teacher })).data.unread, 0);
  await call('POST', '/api/notifications/unsubscribe', { token: S.teacher, body: {} });
  ok('إلغاء اشتراك الجهاز', (await call('GET', '/api/notifications/devices', { token: S.teacher })).data.length === 0);
});

/* ═════════ ١٦. الملفات والتخزين المعزول ═════════ */
section('١٦. الملفات والتخزين المعزول', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082', 'hex');
  const fd = new FormData();
  fd.append('context', 'invoices');
  fd.append('files', new Blob([png], { type: 'image/png' }), 'فاتورة-تجريبية.png');
  const up = await call('POST', '/api/files', { token: S.finance, body: fd });
  ok('رفع ملف', up.status === 201 && up.data.files.length === 1);
  S.fileId = up.data.files[0].id;

  const get = await call('GET', `/api/files/${S.fileId}`, { token: S.finance, raw: true });
  ok('استرجاع الملف بنفس المحتوى', get.status === 200 && get.buf.equals(png));
  ok('المعاينة داخل النظام (inline)', /inline/.test(get.res.headers.get('content-disposition') || ''));
  ok('خيار التنزيل يعمل',
    /attachment/.test((await call('GET', `/api/files/${S.fileId}?download=1`, { token: S.finance, raw: true }))
      .res.headers.get('content-disposition') || ''));

  const bad = new FormData();
  bad.append('files', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'virus.exe');
  ok('رفض نوع ملف غير مسموح', (await call('POST', '/api/files', { token: S.finance, body: bad })).status === 400);
  ok('رفض الرفع بدون ملفات', (await call('POST', '/api/files', { token: S.finance, body: new FormData() })).status === 400);
  ok('منع الوصول لملف غير موجود', (await call('GET', '/api/files/999999', { token: S.finance })).status === 404);

  const inv = await call('POST', '/api/finance/invoices', {
    token: S.finance, body: { total: 500, vendor: 'مورد', file_id: S.fileId } });
  const listed = (await call('GET', '/api/finance/invoices', { token: S.finance })).data.find(i => i.id === inv.data.id);
  ok('ربط الفاتورة بمرفقها', listed.file_id === S.fileId && !!listed.original_name);

  /* النسخ الاحتياطي التلقائي (البند ١٠) — يُخزَّن معزولاً تحت مجلّد الجهة */
  const made = await call('POST', '/api/org/backups', { token: S.owner });
  ok('إنشاء نسخة احتياطية', made.status === 201 && made.data.rows > 0 && made.data.tables > 10,
    JSON.stringify(made.data));
  ok('النسخة تُحفظ داخل مجلّد الجهة', String(made.data?.key || '').startsWith('tenants/1/backups/'));

  const backups = (await call('GET', '/api/org/backups', { token: S.owner })).data;
  ok('قائمة النسخ الاحتياطية', backups.items.some(b => b.key === made.data.key));
  ok('النسخ الاحتياطي التلقائي مفعّل', backups.automatic === true && backups.keep >= 1);

  const dl = await call('GET', `/api/org/backups/${backups.items[0].name}/download`, { token: S.owner, raw: true });
  ok('تنزيل النسخة الاحتياطية مضغوطة', dl.status === 200 && dl.buf[0] === 0x1f && dl.buf[1] === 0x8b);
  const restoreSQL = new TextDecoder().decode(
    await new Response(new Blob([dl.buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  ok('النسخة تحتوي على بيانات الجهة', restoreSQL.includes('INSERT OR REPLACE INTO users'));
  ok('النسخة تعيد بناء مُشغّلات الحماية', /CREATE TRIGGER[\s\S]*trg_audit_no_update/.test(restoreSQL));
  ok('منع تنزيل نسخة بمسار ملتوٍ',
    (await call('GET', '/api/org/backups/..%2F..%2Fsecret.sql.gz/download', { token: S.owner })).status >= 400);
  ok('النسخ الاحتياطي محصور بصلاحية إدارة الإعدادات',
    (await call('GET', '/api/org/backups', { token: S.teacher })).status === 403);
});

/* ═════════ ١٧. لوحة التحكم والتخصيص الديناميكي ═════════ */
section('١٧. لوحة التحكم والتخصيص الديناميكي', async () => {
  const d = (await call('GET', '/api/dashboard', { token: S.owner })).data;
  ok('اللوحة تُرجع إحصاءات المهام', typeof d.tasks_total === 'number' && d.tasks_total > 0);
  ok('اللوحة تُرجع مؤشرات المالية', !!d.finance);
  ok('اللوحة تُرجع حضور اليوم', !!d.attendance_today);
  ok('اللوحة تُرجع مقارنة الفروع', d.branches.length >= 4 && d.branches.every(b => 'tasks' in b && 'staff' in b));
  ok('اللوحة تُرجع آخر النشاطات', d.recent_activity.length > 0);
  ok('اللوحة تُرجع المهام القادمة', Array.isArray(d.upcoming_tasks));
  ok('اللوحة تُرجع الميزانيات', !!d.budgets && typeof d.budgets.total === 'number');

  const tenant = (await call('GET', '/api/org/tenant', { token: S.owner })).data;
  ok('هوية الجهة تُقرأ من قاعدة البيانات لا من الكود',
    !!tenant.name && !!tenant.primary_color && typeof tenant.settings === 'object');
  const patched = await call('PATCH', '/api/org/tenant', {
    token: S.owner, body: { primary_color: '#123456', settings: { late_after_minutes: 20 } } });
  eq('تحديث لون الهوية', patched.data.primary_color, '#123456');
  eq('تحديث إعدادات التشغيل', patched.data.settings.late_after_minutes, 20);
  ok('التحديث لا يمسح بقية الإعدادات', !!patched.data.settings.workday);
  await call('PATCH', '/api/org/tenant', { token: S.owner, body: { primary_color: '#0F5132', settings: { late_after_minutes: 15 } } });

  const perms = (await call('GET', '/api/org/permissions', { token: S.owner })).data;
  ok('كتالوج الصلاحيات مُجمَّع حسب الوحدة', perms.list.length === ALL_PERMS && Object.keys(perms.grouped).length > 10);

  const roles = (await call('GET', '/api/org/roles', { token: S.owner })).data;
  const teacherRole = roles.find(r => r.key === 'teacher');
  const original = [...teacherRole.permissions];
  await call('PUT', `/api/org/roles/${teacherRole.id}/permissions`, {
    token: S.owner, body: { permissions: [...original, 'reports.view'] } });
  const reLogin = await login('teacher@riyadh-qu.sa', 'Teach@123');
  ok('تعديل صلاحيات الدور ينعكس على مستخدميه فوراً', reLogin.data.permissions.includes('reports.view'));
  ok('المعلم صار يصل التقارير', (await call('GET', '/api/reports', { token: reLogin.data.accessToken })).status === 200);
  await call('PUT', `/api/org/roles/${teacherRole.id}/permissions`, { token: S.owner, body: { permissions: original } });
  const back = await login('teacher@riyadh-qu.sa', 'Teach@123');
  S.teacher = back.data.accessToken;
  ok('سحب الصلاحية يمنع الوصول مجدداً', (await call('GET', '/api/reports', { token: S.teacher })).status === 403);
  ok('منع تعديل صلاحيات دور مدير الجهة',
    (await call('PUT', `/api/org/roles/${roles.find(r => r.key === 'owner').id}/permissions`,
      { token: S.owner, body: { permissions: [] } })).status === 403);

  const mail = `verify.${Date.now()}@test.sa`;
  const newUser = await call('POST', '/api/org/users', {
    token: S.owner, body: { name: 'مستخدم تدقيق', email: mail, password: 'Verify@2026',
      role_id: teacherRole.id, primary_branch_id: S.branches[0].id, branch_ids: [S.branches[0].id] } });
  ok('إنشاء مستخدم', newUser.status === 201);
  ok('منع تكرار البريد',
    (await call('POST', '/api/org/users', { token: S.owner, body: { name: 'x', email: mail, password: 'Verify@2026', role_id: teacherRole.id } })).status === 409);
  ok('رفض كلمة مرور قصيرة',
    (await call('POST', '/api/org/users', { token: S.owner, body: { name: 'x', email: 'z' + mail, password: '123', role_id: teacherRole.id } })).status === 400);
  ok('المستخدم الجديد يستطيع الدخول', (await login(mail, 'Verify@2026')).status === 200);
  await call('DELETE', `/api/org/users/${newUser.data.id}`, { token: S.owner });
  ok('إيقاف الحساب يمنع الدخول', (await login(mail, 'Verify@2026')).status === 401);
  ok('منع مدير الفرع من إنشاء دور أعلى منه',
    (await call('POST', '/api/org/users', { token: S.branch_manager, body: { name: 'x', email: 'q' + mail,
      password: 'Verify@2026', role_id: roles.find(r => r.key === 'owner').id } })).status === 403);

  ok('تغيير كلمة المرور',
    (await call('POST', '/api/auth/change-password', { token: S.support, body: { current: 'Support@123', next: 'NewSupport@2026' } })).status === 200);
  ok('كلمة المرور القديمة لم تعد تعمل', (await login('support@riyadh-qu.sa', 'Support@123')).status === 401);
  const relog = await login('support@riyadh-qu.sa', 'NewSupport@2026');
  ok('كلمة المرور الجديدة تعمل', relog.status === 200);
  await call('POST', '/api/auth/change-password', {
    token: relog.data.accessToken, body: { current: 'NewSupport@2026', next: 'Support@123' } });
  ok('استعادة كلمة المرور الأصلية', (await login('support@riyadh-qu.sa', 'Support@123')).status === 200);
});

/* ═════════ ١٨. الواجهة وتطبيق PWA ═════════ */
section('١٨. الواجهة وتطبيق PWA', async () => {
  const idx = await call('GET', '/', { raw: true });
  const html = idx.buf.toString();
  ok('الصفحة الرئيسية تُحمَّل', idx.status === 200);
  ok('الاتجاه من اليمين لليسار واللغة عربية', html.includes('dir="rtl"') && html.includes('lang="ar"'));
  ok('بيان التطبيق مرتبط', html.includes('manifest.webmanifest'));
  ok('أيقونات آبل للتثبيت مرتبطة', html.includes('apple-touch-icon'));
  ok('وضع ملء الشاشة لآبل معلن', html.includes('apple-mobile-web-app-capable'));
  ok('لون السمة معلن', html.includes('theme-color'));
  ok('العرض متجاوب مع منطقة الأمان', html.includes('viewport-fit=cover'));

  const spa = await call('GET', '/tasks', { raw: true });
  ok('توجيه SPA يعيد هيكل التطبيق', spa.status === 200 && spa.buf.toString().includes('<div id="app"'));

  const man = (await call('GET', '/manifest.webmanifest')).data;
  eq('وضع التطبيق مستقل', man.display, 'standalone');
  eq('اتجاه البيان', man.dir, 'rtl');
  ok('أيقونات بكل المقاسات', man.icons.length >= 10);
  ok('أيقونة maskable للأندرويد', man.icons.some(i => i.purpose === 'maskable'));
  ok('أيقونتا ١٩٢ و٥١٢ موجودتان',
    man.icons.some(i => i.sizes === '192x192') && man.icons.some(i => i.sizes === '512x512'));
  ok('اختصارات سريعة معرّفة', man.shortcuts.length === 3);

  const sw = (await call('GET', '/sw.js', { raw: true })).buf.toString();
  ok('عامل الخدمة يستقبل الدفع', sw.includes("addEventListener('push'"));
  ok('عامل الخدمة يعالج النقر على الإشعار', sw.includes('notificationclick'));
  ok('عامل الخدمة يخزّن هيكل التطبيق', sw.includes('SHELL'));
  /*
   * حارس انحدار: استجابة موجَّهة (redirected) لا يقبلها المتصفّح داخل respondWith
   * لطلب تنقّل فيسقط التنقّل كلياً دون اتصال — وهو ما يحدث على المستضيفات التي
   * تعيد توجيه /index.html إلى / (منها Cloudflare Static Assets).
   */
  ok('عامل الخدمة ينظّف الاستجابات الموجَّهة قبل خدمتها',
    sw.includes('cleanCopy') && /res\.redirected/.test(sw));
  ok('التحميل المسبق للتنقّل معطّل كي يصل حدث fetch للعامل دون اتصال',
    /navigationPreload\.disable\(\)/.test(sw) && !/navigationPreload\.enable\(\)/.test(sw));
  ok('تنقّل دون اتصال يعيد هيكل التطبيق لا undefined',
    sw.includes('shellResponse') && /new Response\('<!doctype html>/.test(sw));
  ok('مطابقة الذاكرة المؤقتة تتجاهل Vary', /ignoreVary:\s*true/.test(sw));
  ok('شاشات المرحلة الثانية مخزّنة للعمل دون اتصال',
    ['billing.js', 'pricing.js', 'signup.js'].every(v => sw.includes(`/js/views/${v}`)));
  ok('عامل الخدمة يدعم العمل دون اتصال', sw.includes('offline.html'));
  ok('عامل الخدمة يعالج تغيّر الاشتراك', sw.includes('pushsubscriptionchange'));

  for (const size of [192, 512]) {
    const ic = await call('GET', `/assets/icons/icon-${size}.png`, { raw: true });
    ok(`أيقونة ${size} بكسل صالحة`, ic.status === 200 && ic.buf.slice(1, 4).toString() === 'PNG');
  }
  ok('صفحة انقطاع الاتصال متاحة',
    (await call('GET', '/offline.html', { raw: true })).buf.toString().includes('لا يوجد اتصال'));

  ok('سياسة أمان المحتوى مفعّلة', (idx.res.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  ok('منع تخمين نوع المحتوى', idx.res.headers.get('x-content-type-options') === 'nosniff');
  ok('إذن الموقع الجغرافي مسموح للمنصة',
    (idx.res.headers.get('permissions-policy') || '').includes('geolocation=(self)'));
});

/* ═════════ ١٩. المرحلة الثانية: التسجيل الآلي والخطط والفوترة ولوحة المالك ═════════ */
section('١٩. طبقة الـ SaaS (المرحلة الثانية)', async () => {
  /* ── لوحة المنصة لها هويّتها المستقلة: لا يفتحها رمز مجمّع مهما علا دوره ── */
  const alog = await adminLogin();
  ok('دخول ادمن المنصة بحسابه المستقل', alog.status === 200, JSON.stringify(alog.data).slice(0, 160));
  S.admin = alog.data.accessToken;
  S.adminRefresh = alog.data.refreshToken;

  ok('لوحة المنصة محجوبة عن المعلم',
    (await call('GET', '/api/admin/overview', { token: S.teacher })).status === 403);
  ok('لوحة المنصة محجوبة عن مدير الفرع',
    (await call('GET', '/api/admin/tenants', { token: S.branch_manager })).status === 403);
  ok('لوحة المنصة محجوبة عن مدير المجمّع نفسه',
    (await call('GET', '/api/admin/overview', { token: S.owner })).status === 403);
  ok('رمز الادمن لا يفتح مسارات المجمّعات',
    (await call('GET', '/api/tasks', { token: S.admin })).status === 403);
  ok('رمز الادمن لا يفتح جلسة مجمّع',
    (await call('GET', '/api/auth/me', { token: S.admin })).status === 403);
  ok('حساب الادمن لا يظهر في مستخدمي أي مجمّع',
    !JSON.stringify((await call('GET', '/api/org/users', { token: S.owner })).data)
      .includes('admin@raqeem.sa'));

  const ov = await call('GET', '/api/admin/overview', { token: S.admin });
  ok('ادمن المنصة يرى لوحته', ov.status === 200 && ov.data.tenants_total >= 1);
  ok('اللوحة تحسب الإيراد الشهري المتكرر', typeof ov.data.mrr === 'number');
  ok('اللوحة تُظهر تعطُّل طبقة الـ SaaS ابتدائياً', ov.data.platform.saas_enabled === false);

  /* ── التسجيل الذاتي مغلق ما لم يُفتح ── */
  ok('التسجيل الذاتي مرفوض والطبقة معطّلة',
    (await call('POST', '/api/public/signup', { body: { code: 'ZZ1', tenant_name: 'x', admin_name: 'y',
      email: 'z@z.sa', password: 'Abcd@1234' } })).status === 403);

  const settings = await call('PUT', '/api/admin/settings', {
    token: S.admin, body: { saas_enabled: true, signup_enabled: true } });
  ok('تفعيل طبقة الـ SaaS من لوحة المالك', settings.status === 200 && settings.data.saas_enabled === 1);

  /* ── صفحة الأسعار العامة ── */
  const pub = await call('GET', '/api/public/platform');
  ok('هوية المنصة متاحة للعموم', pub.status === 200 && !!pub.data.name && pub.data.signup_enabled === true);
  const plans = await call('GET', '/api/public/plans');
  ok('صفحة الأسعار تعرض الخطط', plans.status === 200 && plans.data.plans.length >= 3);
  ok('كل خطة تحمل حدودها ومزاياها',
    plans.data.plans.every(p => p.limits && Array.isArray(p.perks) && p.perks.length));
  ok('الخطة السنوية توفّر عن الشهرية',
    plans.data.plans.some(p => p.yearly_savings > 0));
  ok('الأسعار تُقرأ من قاعدة البيانات لا من الكود',
    plans.data.plans.find(p => p.code === 'growth')?.price_monthly === 499);
  ok('صفحة الأسعار لا تسرّب خططاً مخفية', plans.data.plans.every(p => p.code !== 'internal'));

  /* ── هوية النطاق (White-labeling) ── */
  const brand = await call('GET', '/api/public/brand');
  ok('هوية النطاق تُرجع بيانات المنصة', brand.status === 200 && !!brand.data.platform.name);

  /* ── التحقق من توفر الرمز والبريد ── */
  const avail = await call('GET', '/api/public/signup/availability?code=RQ&email=admin@riyadh-qu.sa');
  ok('رمز الجهة المستخدم غير متاح', avail.data.code.available === false);
  ok('البريد المسجّل غير متاح', avail.data.email.available === false);
  const avail2 = await call('GET', '/api/public/signup/availability?code=ADMIN&email=bad-mail');
  ok('الرموز المحجوزة مرفوضة', avail2.data.code.reserved === true);
  ok('البريد غير الصحيح مرفوض', avail2.data.email.invalid === true);

  /* ── التسجيل الآلي لجهة جديدة ── */
  const bad = await call('POST', '/api/public/signup', { body: {
    code: 'QV1', tenant_name: 'جهة', admin_name: 'مدير', email: 'v@v.sa', password: '123' } });
  ok('رفض كلمة مرور قصيرة في التسجيل', bad.status === 400);

  const stamp = Date.now().toString().slice(-5);
  const CODE = 'V' + stamp;
  const MAIL = `owner${stamp}@verify.sa`;
  const signup = await call('POST', '/api/public/signup', { body: {
    code: CODE, tenant_name: 'مجمّع التدقيق لتحفيظ القرآن', admin_name: 'مدير التدقيق',
    email: MAIL, password: 'Verify@2026', plan_code: 'growth', cycle: 'monthly' } });
  ok('التسجيل الآلي ينشئ الجهة فوراً', signup.status === 201 && signup.data.status === 'active', JSON.stringify(signup.data));
  ok('الجهة الجديدة تبدأ بفترة تجريبية', signup.data.subscription?.status === 'trialing');
  S.newTenantId = signup.data.tenant.id;

  ok('رفض تكرار رمز الجهة',
    (await call('POST', '/api/public/signup', { body: { code: CODE, tenant_name: 'x', admin_name: 'y',
      email: 'other' + MAIL, password: 'Verify@2026', plan_code: 'growth' } })).status === 409);

  /* ── الجهة الجديدة جاهزة للعمل فوراً ── */
  const nlog = await login(MAIL, 'Verify@2026');
  ok('مدير الجهة الجديدة يدخل مباشرةً', nlog.status === 200);
  S.newOwner = nlog.data.accessToken;
  ok('الجهة الجديدة مجهّزة بأدوارها كاملة', nlog.data.permissions.length === ALL_PERMS);
  ok('الجهة الجديدة لها فرع وفصل جاريان',
    nlog.data.branches.length === 1 && !!nlog.data.current_term);
  ok('الجهة الجديدة معزولة عن بيانات الجهة الأولى',
    (await call('GET', '/api/tasks', { token: S.newOwner })).data.length === 0);
  ok('الجهة الأولى لا ترى الجهة الجديدة',
    !(await call('GET', '/api/org/users', { token: S.owner })).data.some(u => u.email === MAIL));

  /* ── الاشتراك والاستهلاك ── */
  const bill = await call('GET', '/api/billing', { token: S.newOwner });
  ok('شاشة الاشتراك تُظهر الخطة', bill.status === 200 && bill.data.subscription.plan.code === 'growth');
  ok('الاستهلاك يُقاس مقابل حدود الخطة',
    bill.data.usage.users.limit === 120 && bill.data.usage.users.used === 1);
  ok('نسبة الاستهلاك محسوبة', bill.data.usage.branches.percent !== null);
  ok('الاشتراك التجريبي يسمح بالكتابة', bill.data.subscription.writable === true);
  ok('شاشة الاشتراك محجوبة عن غير أصحاب الصلاحية',
    (await call('GET', '/api/billing', { token: S.teacher })).status === 403);

  /* ── حدّ الخطة يُطبَّق فعلياً ── */
  const starter = await call('POST', '/api/billing/subscribe', {
    token: S.newOwner, body: { plan_code: 'starter', cycle: 'monthly' } });
  ok('التحويل إلى الخطة المجانية', starter.status === 201);
  const b2 = await call('POST', '/api/org/branches', {
    token: S.newOwner, body: { code: 'B02', name: 'فرع ثانٍ' } });
  ok('حدّ الفروع في الخطة يمنع الإضافة', b2.status === 403 && b2.data.error.code === 'QUOTA_EXCEEDED',
    JSON.stringify(b2.data));
  ok('رسالة الحدّ توضّح الحدّ والاستهلاك',
    b2.data.error.details?.limit === 1 && b2.data.error.details?.resource === 'branches');

  /* ── الترقية تُصدر فاتورة بالضريبة ── */
  const up = await call('POST', '/api/billing/subscribe', {
    token: S.newOwner, body: { plan_code: 'growth', cycle: 'yearly' } });
  ok('الترقية تُصدر فاتورة', up.status === 201 && !!up.data.invoice);
  const inv = up.data.invoice;
  ok('الفاتورة تحمل رقماً متسلسلاً', /^RQM-\d{4}-\d{5}$/.test(inv.number), inv.number);
  eq('قيمة الاشتراك السنوي', inv.subtotal, 4990);
  eq('ضريبة القيمة المضافة ١٥٪', inv.vat_amount, 748.5);
  eq('الإجمالي شامل الضريبة', inv.total, 5738.5);
  ok('الفاتورة غير مسددة عند الإصدار', inv.status === 'open' && !inv.paid_at);
  ok('الفاتورة لها تاريخ استحقاق', !!inv.due_at);

  const b3 = await call('POST', '/api/org/branches', {
    token: S.newOwner, body: { code: 'B02', name: 'فرع ثانٍ' } });
  ok('الترقية ترفع الحدّ فوراً', b3.status === 201);

  /* ── دورة السداد ── */
  const invoices = await call('GET', '/api/billing/invoices', { token: S.newOwner });
  ok('قائمة الفواتير تعرض الرصيد المستحق', invoices.data.balance.due === inv.total);
  const print = await call('GET', `/api/billing/invoices/${inv.id}/print`, { token: S.newOwner, raw: true });
  ok('الفاتورة تُطبع بترويسة رسمية',
    print.status === 200 && print.buf.toString().includes(inv.number));

  const declare = await call('POST', `/api/billing/invoices/${inv.id}/declare-payment`, {
    token: S.newOwner, body: { reference: 'TRX-VERIFY', method: 'bank_transfer' } });
  ok('إشعار السداد يُسجَّل معلّقاً', declare.status === 201 && declare.data.status === 'pending');
  ok('الفاتورة تبقى غير مسددة قبل الاعتماد',
    (await call('GET', `/api/billing/invoices/${inv.id}`, { token: S.newOwner })).data.status === 'open');

  const pending = await call('GET', '/api/admin/payments?status=pending', { token: S.admin });
  ok('إشعار السداد يظهر لمالك المنصة', pending.data.some(p => p.reference === 'TRX-VERIFY'));
  const payId = pending.data.find(p => p.reference === 'TRX-VERIFY').id;
  const confirm = await call('POST', `/api/admin/payments/${payId}/confirm`, { token: S.admin });
  ok('اعتماد السداد يسدّد الفاتورة', confirm.status === 200 && confirm.data.invoice.status === 'paid');
  ok('لا يمكن اعتماد الإشعار مرتين',
    (await call('POST', `/api/admin/payments/${payId}/confirm`, { token: S.admin })).status === 400);
  ok('الرصيد المستحق صفر بعد السداد',
    (await call('GET', '/api/billing/invoices', { token: S.newOwner })).data.balance.due === 0);

  /* ── إيقاف التجديد واستئنافه ── */
  ok('إيقاف التجديد التلقائي',
    (await call('POST', '/api/billing/cancel', { token: S.newOwner })).data.subscription.cancel_at_period_end === true);
  ok('استئناف التجديد التلقائي',
    (await call('POST', '/api/billing/resume', { token: S.newOwner })).data.subscription.cancel_at_period_end === false);

  /* ── إيقاف الجهة إدارياً ── */
  const susp = await call('PATCH', `/api/admin/tenants/${S.newTenantId}`, {
    token: S.admin, body: { status: 'suspended', suspend_reason: 'تدقيق' } });
  ok('إيقاف الجهة من لوحة المالك', susp.status === 200 && susp.data.status === 'suspended');
  const blocked = await call('POST', '/api/tasks', { token: S.newOwner, body: { title: 'مهمة أثناء الإيقاف' } });
  ok('الجهة الموقوفة لا تستطيع الكتابة',
    blocked.status === 402 && blocked.data.error.code === 'SUBSCRIPTION_INACTIVE', JSON.stringify(blocked.data));
  ok('الجهة الموقوفة تبقى قادرة على القراءة',
    (await call('GET', '/api/tasks', { token: S.newOwner })).status === 200);
  ok('الجهة الموقوفة تصل لشاشة السداد',
    (await call('GET', '/api/billing', { token: S.newOwner })).status === 200);
  ok('لا يمكن إيقاف الجهة رقم ١',
    (await call('PATCH', '/api/admin/tenants/1', { token: S.admin, body: { status: 'suspended' } })).status === 400);
  ok('إعادة تفعيل الجهة',
    (await call('PATCH', `/api/admin/tenants/${S.newTenantId}`, { token: S.admin, body: { status: 'active' } })).data.status === 'active');
  ok('الكتابة تعود بعد التفعيل',
    (await call('POST', '/api/tasks', { token: S.newOwner, body: { title: 'مهمة بعد التفعيل' } })).status === 201);

  /* ── إدارة الخطط ── */
  const newPlan = await call('POST', '/api/admin/plans', { token: S.admin, body: {
    code: 'verify-plan', name: 'خطة التدقيق', price_monthly: 99, price_yearly: 990,
    max_branches: 2, max_users: 20, max_storage_mb: 1024, is_public: false,
    perks: ['ميزة أولى', 'ميزة ثانية'] } });
  ok('إنشاء خطة جديدة', newPlan.status === 201);
  ok('الخطة غير المعروضة لا تظهر للعموم',
    !(await call('GET', '/api/public/plans')).data.plans.some(p => p.code === 'verify-plan'));
  ok('تحرير الخطة',
    (await call('PATCH', `/api/admin/plans/${newPlan.data.id}`, { token: S.admin, body: { price_monthly: 149 } })).data.price_monthly === 149);
  ok('رفض تكرار رمز الخطة',
    (await call('POST', '/api/admin/plans', { token: S.admin, body: { code: 'verify-plan', name: 'x' } })).status === 409);
  ok('حذف خطة بلا مشتركين',
    (await call('DELETE', `/api/admin/plans/${newPlan.data.id}`, { token: S.admin })).status === 200);
  const growthPlan = (await call('GET', '/api/admin/plans', { token: S.admin })).data.find(p => p.code === 'growth');
  ok('منع حذف خطة مرتبطة بجهات',
    (await call('DELETE', `/api/admin/plans/${growthPlan.id}`, { token: S.admin })).status === 409);

  /* ── الدخول الإداري للمساندة ── */
  const imp = await call('POST', `/api/admin/tenants/${S.newTenantId}/impersonate`, { token: S.admin });
  ok('الدخول الإداري يصدر جلسة للجهة', imp.status === 200 && !!imp.accessToken === false && !!imp.data.accessToken);
  const impSession = await call('GET', '/api/auth/me', { token: imp.data.accessToken });
  ok('جلسة المساندة داخل نطاق الجهة المستهدفة', impSession.data.tenant.id === S.newTenantId);
  ok('الدخول الإداري مسجَّل في سجل الجهة',
    (await call('GET', '/api/audit', { token: imp.data.accessToken })).data.items
      .some(a => String(a.summary).includes('دخول إداري')));

  /* ── سجل المنصة مقفل ── */
  const logs = await call('GET', '/api/admin/logs', { token: S.admin });
  ok('سجل المنصة يسجّل عمليات المالك', logs.data.total > 0);
  ok('السجل يوثّق الإيقاف والتفعيل',
    logs.data.items.some(l => l.action === 'suspend') && logs.data.items.some(l => l.action === 'resume'));
  ok('السجل يوثّق الدخول الإداري', logs.data.items.some(l => l.action === 'impersonate'));
  ok('سجل المنصة محجوب عن غير المالك',
    (await call('GET', '/api/admin/logs', { token: S.newOwner })).status === 403);

  /* ── طلبات التسجيل بالمراجعة اليدوية ── */
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { signup_needs_review: true } });
  const review = await call('POST', '/api/public/signup', { body: {
    code: 'R' + stamp, tenant_name: 'جهة بانتظار المراجعة', admin_name: 'مدير',
    email: `review${stamp}@verify.sa`, password: 'Verify@2026', plan_code: 'starter' } });
  ok('طلب التسجيل ينتظر المراجعة', review.status === 201 && review.data.status === 'pending_review');
  ok('الجهة لا تُنشأ قبل الاعتماد',
    (await login(`review${stamp}@verify.sa`, 'Verify@2026')).status === 401);
  const reqs = await call('GET', '/api/admin/signups?status=pending', { token: S.admin });
  ok('الطلب يظهر لمالك المنصة', reqs.data.some(r => r.id === review.data.request_id));
  const approved = await call('POST', `/api/admin/signups/${review.data.request_id}/approve`, { token: S.admin });
  ok('اعتماد الطلب يجهّز الجهة', approved.status === 201 && !!approved.data.tenant.id);
  ok('الجهة المعتمَدة تستطيع الدخول',
    (await login(`review${stamp}@verify.sa`, 'Verify@2026')).status === 200);
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { signup_needs_review: false } });

  /* ── مالكو المنصة ── */
  const admins = await call('GET', '/api/admin/admins', { token: S.admin });
  ok('قائمة مالكي المنصة', admins.data.length >= 1);
  ok('لا يمكن سحب صلاحية المالك الوحيد',
    (await call('DELETE', `/api/admin/admins/${S.u_owner.id}`, { token: S.admin })).status === 400);

  /* ── دورة الاشتراكات: انتهاء التجربة ← فاتورة ← مهلة ← إيقاف الكتابة ── */
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { grace_days: 0 } });
  const LC = 'L' + stamp;
  const LMAIL = `cycle${stamp}@verify.sa`;
  const lifeTenant = await call('POST', '/api/admin/tenants', { token: S.admin, body: {
    code: LC, name: 'جهة دورة الاشتراك', admin_name: 'مدير الدورة', email: LMAIL,
    password: 'Verify@2026', plan_code: 'growth', cycle: 'monthly' } });
  ok('إنشاء جهة من لوحة المالك', lifeTenant.status === 201);
  const LT = lifeTenant.data.tenant.id;
  const lifeOwner = (await login(LMAIL, 'Verify@2026')).data.accessToken;

  /* تجربة تنتهي اليوم — سيناريو إداري مشروع، لا باب خلفي */
  await call('POST', `/api/admin/tenants/${LT}/plan`, {
    token: S.admin, body: { plan_code: 'growth', cycle: 'monthly', status: 'trialing', trial_days: 0 } });
  ok('التجربة المنتهية اليوم قبل التشغيل',
    (await call('GET', '/api/billing', { token: lifeOwner })).data.subscription.status === 'trialing');

  const cycle1 = await call('POST', '/api/admin/jobs/subscriptions/run', { token: S.admin });
  ok('تشغيل دورة الاشتراكات يدوياً', cycle1.status === 200);
  ok('الدورة حوّلت التجربة المنتهية', cycle1.data.result.trials.converted >= 1, JSON.stringify(cycle1.data.result));

  const afterTrial = (await call('GET', '/api/billing', { token: lifeOwner })).data;
  ok('انتهاء التجربة يحوّل الاشتراك لمتأخر السداد', afterTrial.subscription.status === 'past_due');
  ok('انتهاء التجربة يُصدر فاتورة تلقائياً', afterTrial.balance.invoices === 1 && afterTrial.balance.due > 0);
  ok('المنصة تبقى قابلة للكتابة داخل مهلة السداد أو تمنعها بوضوح',
    [201, 402].includes((await call('POST', '/api/tasks', { token: lifeOwner, body: { title: 'مهمة أثناء المهلة' } })).status));

  const cycle2 = await call('POST', '/api/admin/jobs/subscriptions/run', { token: S.admin });
  ok('الدورة الثانية ترصد تجاوز مهلة السداد',
    cycle2.data.result.reminders.blocked >= 1 || cycle2.data.result.reminders.overdue >= 1,
    JSON.stringify(cycle2.data.result.reminders));

  const lateWrite = await call('POST', '/api/tasks', { token: lifeOwner, body: { title: 'مهمة بعد المهلة' } });
  ok('انتهاء مهلة السداد يوقف الكتابة',
    lateWrite.status === 402 && lateWrite.data.error.code === 'SUBSCRIPTION_INACTIVE', JSON.stringify(lateWrite.data));
  ok('القراءة تبقى متاحة رغم توقف السداد',
    (await call('GET', '/api/tasks', { token: lifeOwner })).status === 200);
  ok('إشعار توقف الاشتراك يصل لصاحب الصلاحية',
    (await call('GET', '/api/notifications', { token: lifeOwner })).data.items
      .some(n => String(n.type).startsWith('billing.')));

  const lateInv = (await call('GET', '/api/billing/invoices', { token: lifeOwner })).data.items[0];
  const settle = await call('POST', `/api/admin/invoices/${lateInv.id}/mark-paid`, { token: S.admin });
  ok('اعتماد السداد من لوحة المالك', settle.status === 200 && settle.data.status === 'paid');
  ok('السداد يعيد الاشتراك للعمل',
    (await call('GET', '/api/billing', { token: lifeOwner })).data.subscription.status === 'active');
  ok('الكتابة تعود بعد السداد',
    (await call('POST', '/api/tasks', { token: lifeOwner, body: { title: 'مهمة بعد السداد' } })).status === 201);

  ok('إلغاء فاتورة مسددة ممنوع',
    (await call('POST', `/api/admin/invoices/${lateInv.id}/void`, { token: S.admin })).status === 400);
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { grace_days: 7 } });
  await call('DELETE', `/api/admin/tenants/${LT}?confirm=${LC}`, { token: S.admin });

  /* ── محو جهة بالكامل ── */
  ok('المحو يتطلّب تأكيد الرمز',
    (await call('DELETE', `/api/admin/tenants/${S.newTenantId}`, { token: S.admin })).status === 400);
  const purge = await call('DELETE', `/api/admin/tenants/${S.newTenantId}?confirm=${CODE}`, { token: S.admin });
  ok('محو الجهة ينجح بالتأكيد الصحيح', purge.status === 200 && purge.data.purged.users >= 1);
  ok('المحو يشمل سجل تدقيق الجهة', purge.data.purged.audit_logs > 0);
  ok('الجهة الممحوّة لم تعد موجودة',
    (await call('GET', `/api/admin/tenants/${S.newTenantId}`, { token: S.admin })).status === 404);
  ok('مستخدمو الجهة الممحوّة لم يعودوا يدخلون', (await login(MAIL, 'Verify@2026')).status === 401);
  ok('أثر المحو محفوظ في سجل المنصة',
    (await call('GET', '/api/admin/logs', { token: S.admin })).data.items
      .some(l => l.action === 'delete' && l.entity === 'tenant'));
  ok('لا يمكن محو الجهة رقم ١',
    (await call('DELETE', '/api/admin/tenants/1?confirm=RQ', { token: S.admin })).status === 400);

  /* ── سجل التدقيق يبقى مقفلاً بعد كل ذلك ── */
  ok('سجل تدقيق الجهة الأولى ما زال محمياً',
    (await call('GET', '/api/audit', { token: S.owner })).data.total > 0);

  /* ── إعادة الطبقة إلى وضع المرحلة الأولى ── */
  const off = await call('PUT', '/api/admin/settings', {
    token: S.admin, body: { saas_enabled: false, signup_enabled: false } });
  ok('إمكان إعادة المنصة لوضع المستأجر الواحد', off.data.saas_enabled === 0);
  ok('التسجيل الذاتي يُغلق فوراً',
    (await call('POST', '/api/public/signup', { body: { code: 'ZZ9', tenant_name: 'x', admin_name: 'y',
      email: 'zz9@z.sa', password: 'Abcd@1234' } })).status === 403);
});

/* ═════════ ٢٠. لوحة المالك — المستويات ١–٤ ═════════ */
section('٢٠. لوحة المالك: المزايا والنمو والامتثال والفوترة المتقدمة', async () => {
  const crypto = await import('node:crypto');
  /* مولّد رمز TOTP محلي للتحقق من مطابقة الخادم لمعيار RFC 6238 */
  const b32 = (s) => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
    const out = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(out);
  };
  const totpOf = (secret, step = Math.floor(Date.now() / 30000)) => {
    const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
    const mac = crypto.createHmac('sha1', b32(secret)).update(buf).digest();
    const o = mac[mac.length - 1] & 0x0f;
    const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
    return String(n % 1e6).padStart(6, '0');
  };

  /* الطبقة أُعيدت إلى وضع المستأجر الواحد في نهاية القسم السابق — نعيد تفعيلها */
  await call('PUT', '/api/admin/settings', {
    token: S.admin, body: { saas_enabled: true, signup_enabled: true, signup_needs_review: false } });

  const stamp = Date.now().toString().slice(-6);
  const CODE = 'L' + stamp;
  const MAIL = `lvl${stamp}@verify.sa`;
  const su = await call('POST', '/api/public/signup', { body: {
    code: CODE, tenant_name: 'مجمّع اختبار المستويات', admin_name: 'مدير المستويات',
    email: MAIL, password: 'Verify@2026', plan_code: 'starter', cycle: 'monthly' } });
  ok('تهيئة جهة اختبار للمستويات', su.status === 201, JSON.stringify(su.data));
  const TID = su.data.tenant.id;
  const TK = (await login(MAIL, 'Verify@2026')).data.accessToken;

  /* ─────────── المستوى ١: تفعيل مزايا الخطط ─────────── */
  const feats = await call('GET', '/api/admin/features', { token: S.admin });
  ok('كتالوج المزايا متاح للمالك', feats.status === 200 && feats.data.length >= 13);
  ok('كل ميزة لها مفتاح واسم عربي ووحدة',
    feats.data.every(f => f.key && f.label && f.module));

  ok('خطة البداية تتيح المهام', (await call('GET', '/api/tasks', { token: TK })).status === 200);
  const locked = await call('GET', '/api/finance/requests', { token: TK });
  ok('خطة البداية تحجب الدورة المالية', locked.status === 403);
  ok('الحجب يعلن سببه بوضوح للواجهة', locked.data?.error?.details?.code === 'FEATURE_LOCKED');
  ok('رسالة الحجب تذكر اسم الميزة بالعربية',
    /الدورة المالية/.test(locked.data?.error?.message || ''));
  ok('خطة البداية تحجب منشئ النماذج',
    (await call('GET', '/api/forms', { token: TK })).status === 403);
  ok('خطة البداية تحجب مفاتيح الربط',
    (await call('GET', '/api/api-keys', { token: TK })).status === 403);
  ok('الإشعارات تعمل في خطة البداية',
    (await call('GET', '/api/notifications', { token: TK })).status === 200);

  await call('POST', `/api/admin/tenants/${TID}/plan`, {
    token: S.admin, body: { plan_code: 'enterprise', cycle: 'monthly', status: 'active' } });
  ok('خطة المؤسسات تفتح كل الوحدات',
    (await call('GET', '/api/finance/requests', { token: TK })).status === 200);
  ok('خطة المؤسسات تفتح مفاتيح الربط',
    (await call('GET', '/api/api-keys', { token: TK })).status === 200);

  /* ─────────── المستوى ١: لقطات المؤشرات التاريخية ─────────── */
  const snap = await call('POST', '/api/admin/metrics/snapshot', { token: S.admin });
  ok('التقاط لقطة مؤشرات فورية', snap.status === 201 && /^\d{4}-\d{2}-\d{2}$/.test(snap.data.date));
  ok('اللقطة تسجّل الإيراد الشهري المتكرر', typeof snap.data.mrr === 'number');
  const mt = await call('GET', '/api/admin/metrics?days=30', { token: S.admin });
  ok('سلسلة المؤشرات الزمنية متاحة', mt.status === 200 && Array.isArray(mt.data.points) && mt.data.points.length >= 1);
  ok('السلسلة تحمل دلتا الفترة', mt.data.change && typeof mt.data.change.mrr === 'number');
  ok('السلسلة تحسب معدل التسرّب', typeof mt.data.change.churn_rate === 'number');
  ok('السلسلة ترفق تحويل التجارب', mt.data.trial_conversion && typeof mt.data.trial_conversion.rate === 'number');
  ok('السلسلة ترفق توقّع الإيراد',
    mt.data.forecast && typeof mt.data.forecast.expected === 'number'
    && typeof mt.data.forecast.at_risk === 'number');
  ok('اللقطة لا تتكرر لنفس اليوم',
    mt.data.points.filter(p => p.date === snap.data.date).length === 1);

  /* ─────────── المستوى ١: سجل تشغيل الوظائف ─────────── */
  const runJob = await call('POST', '/api/admin/jobs/kpi/run', { token: S.admin });
  ok('تشغيل وظيفة يدوياً ينجح', runJob.status === 200 && typeof runJob.data.ms === 'number');
  const runs = await call('GET', '/api/admin/jobs/runs?job=kpi', { token: S.admin });
  ok('سجل التشغيل يحفظ الوظيفة المنفّذة', runs.status === 200 && runs.data.length >= 1);
  ok('السجل يميّز التشغيل اليدوي عن المجدول', runs.data.some(r => r.trigger === 'manual'));
  ok('السجل يسجّل الحالة والمدة',
    runs.data[0].status === 'success' && Number(runs.data[0].duration_ms) >= 0,
    JSON.stringify({ status: runs.data[0].status, ms: runs.data[0].duration_ms }));
  ok('السجل يحفظ ناتج الوظيفة', runs.data[0].result !== null && runs.data[0].result !== undefined);
  ok('السجل يسمّي مُشغّل الوظيفة', !!runs.data[0].actor_name);
  const jh = await call('GET', '/api/admin/jobs/health', { token: S.admin });
  ok('صحة الوظائف تشمل كل الوظائف المعرّفة', jh.status === 200 && jh.data.jobs.length >= 6);
  ok('صحة الوظائف تحصي الإخفاقات', typeof jh.data.failing === 'number' && jh.data.failing === 0);
  ok('وظيفة لم تُعرّف تُرفض',
    (await call('POST', '/api/admin/jobs/nope/run', { token: S.admin })).status === 404);

  /* ─────────── المستوى ١: التناسب عند تغيير الخطة ─────────── */
  const sub1 = await call('POST', '/api/billing/subscribe', {
    token: TK, body: { plan_code: 'growth', cycle: 'monthly' } });
  ok('الاشتراك في خطة النمو يُصدر فاتورة', sub1.status === 201 && sub1.data.invoice?.total > 0);
  const inv1 = sub1.data.invoice;
  near('الفاتورة تحسب ضريبة ١٥٪ على ٤٩٩', inv1.total, 573.85);

  const up1 = await call('POST', '/api/billing/subscribe', {
    token: TK, body: { plan_code: 'enterprise', cycle: 'monthly' } });
  ok('الترقية قبل السداد لا تمنح رصيداً غير مدفوع',
    !up1.data.proration || up1.data.proration.credit === 0,
    JSON.stringify(up1.data.proration));
  near('فاتورة الترقية بلا خصم غير مستحق', up1.data.invoice.total, 1723.85);

  /* الآن نسدّد فعلياً ثم نرقّي — يجب أن يُحتسب المتبقّي رصيداً */
  await call('POST', `/api/admin/invoices/${up1.data.invoice.id}/mark-paid`, { token: S.admin });
  const up2 = await call('POST', '/api/billing/subscribe', {
    token: TK, body: { plan_code: 'growth', cycle: 'monthly' } });
  ok('الفترة المدفوعة غير المستهلكة تُرحَّل رصيداً',
    up2.data.proration && up2.data.proration.credit > 0, JSON.stringify(up2.data.proration));
  ok('التناسب يفصح عن أيام الفترة ليُشرح للجهة',
    up2.data.proration.unusedDays >= 0 && up2.data.proration.totalDays > 0);
  ok('التناسب يسمّي الخطة السابقة بالعربية لا بالرمز',
    !!up2.data.proration.from_plan_name && up2.data.proration.from_plan_name !== up2.data.proration.from_plan);
  ok('التناسب يعلن المدفوع فعلاً عن الفترة',
    Number(up2.data.proration.paid_for_period) > 0);
  near('الرصيد يساوي المدفوع صافياً قبل الضريبة', up2.data.proration.credit, 1499, 2);
  ok('الرصيد يغطي الفاتورة الجديدة بالكامل',
    up2.data.invoice === null || up2.data.invoice.total === 0 || up2.data.invoice.status === 'paid',
    JSON.stringify(up2.data.invoice));

  const bal = await call('GET', '/api/billing', { token: TK });
  ok('الرصيد المتبقي يظهر للجهة', Number(bal.data.credit_balance || 0) > 0,
    `الرصيد ${bal.data.credit_balance}`);

  /* ─────────── المستوى ٢: صحة الجهات وفرص الترقية ─────────── */
  const hl = await call('GET', '/api/admin/health', { token: S.admin });
  ok('تقرير صحة الجهات متاح', hl.status === 200 && hl.data.items.length >= 2);
  const me = hl.data.items.find(t => t.id === TID);
  ok('كل جهة تُقيَّم من ١٠٠', me && me.health.score >= 0 && me.health.score <= 100);
  ok('التقييم يصنّف الخطورة',
    ['healthy', 'watch', 'at_risk', 'critical'].includes(me.health.risk));
  ok('التقييم يفصّل أسبابه', Array.isArray(me.health.reasons));
  ok('التقييم يرصد إشارات الاستخدام',
    typeof me.users === 'number' && typeof me.events_30d === 'number');
  ok('التقرير يلخّص التوزيع حسب الخطورة',
    hl.data.summary && typeof hl.data.summary.by_risk.at_risk === 'number'
    && hl.data.summary.total === hl.data.items.length);
  ok('التقرير يحسب متوسط التقييم العام', typeof hl.data.summary.average_score === 'number');
  ok('التقرير يقدّر قيمة فرص الترقية', typeof hl.data.summary.upsell_value === 'number');
  ok('التقرير يفرز الجهات المعرّضة للخطر على حدة', Array.isArray(hl.data.at_risk));
  ok('التقرير يرصد فرص الترقية', Array.isArray(hl.data.upsells));
  ok('تسميات الخطورة بالعربية',
    (await call('GET', '/api/admin/health/risk-labels', { token: S.admin })).data.at_risk === 'معرّضة للتسرّب');
  ok('كل جهة تحمل تسمية خطورتها بالعربية', !!me.health.risk_label);

  /* ─────────── المستوى ٢: البث والإعلانات ─────────── */
  const ann = await call('POST', '/api/admin/announcements', { token: S.admin, body: {
    title: 'تحديث مجدول للمنصة', body: 'ستتوقف الخدمة ١٥ دقيقة الجمعة',
    severity: 'warning', audience: 'all', banner: true, push: false } });
  ok('بثّ إعلان لكل الجهات', ann.status === 201 && ann.data.tenants >= 2);
  ok('الإعلان يصل مستخدمي الجهات', ann.data.recipients >= 2);
  const sess = await call('GET', '/api/auth/me', { token: TK });
  ok('الإعلان يظهر شريطاً في جلسة الجهة',
    sess.data.banners?.some(b => b.title === 'تحديث مجدول للمنصة'));
  const anNotifs = (await call('GET', '/api/notifications', { token: TK })).data.items
    .filter(n => n.type === 'platform.announcement');
  ok('الإعلان يصل كإشعار للمستخدم', anNotifs.length >= 1);
  /* وسم إشعار الدفع يُبنى من data.id — بدونه يحلّ إعلان محلّ آخر على الجهاز */
  ok('الإعلان يحمل معرّفه فيبقى وسم الدفع فريداً',
    anNotifs.every(n => (typeof n.data === 'string' ? JSON.parse(n.data || '{}') : (n.data || {})).id > 0));

  const targeted = await call('POST', '/api/admin/announcements', { token: S.admin, body: {
    title: 'عرض خاص لخطة المؤسسات', severity: 'info',
    audience: 'plan', audience_value: 'enterprise', push: false } });
  ok('البث الموجّه يحصر الجمهور بالخطة', targeted.status === 201 && targeted.data.audience === 'plan');
  ok('الجهة على خطة النمو لا ترى إعلان المؤسسات',
    !(await call('GET', '/api/auth/me', { token: TK })).data.banners
      ?.some(b => b.title === 'عرض خاص لخطة المؤسسات'));
  ok('البث الموجّه بلا قيمة جمهور مرفوض',
    (await call('POST', '/api/admin/announcements', { token: S.admin,
      body: { title: 'x', audience: 'plan' } })).status === 400);
  ok('الإعلان بلا عنوان مرفوض',
    (await call('POST', '/api/admin/announcements', { token: S.admin, body: { title: '  ' } })).status === 400);
  ok('حذف الإعلان يزيل الشريط',
    (await call('DELETE', `/api/admin/announcements/${ann.data.id}`, { token: S.admin })).status === 200 &&
    !(await call('GET', '/api/auth/me', { token: TK })).data.banners
      ?.some(b => b.title === 'تحديث مجدول للمنصة'));

  /* ─────────── المستوى ٢: صندوق الدعم الموحّد ─────────── */
  const tk1 = await call('POST', '/api/comms/tickets', { token: TK, body: {
    subject: 'تعذّر تصدير التقرير', body: 'يظهر خطأ عند التصدير', category: 'technical', priority: 'high' } });
  ok('الجهة ترفع تذكرة', tk1.status === 201);
  const esc = await call('POST', `/api/comms/tickets/${tk1.data.id}/escalate-vendor`, { token: TK });
  ok('تصعيد التذكرة إلى مزوّد المنصة', esc.status === 200 && esc.data.status === 'open');
  const inbox = await call('GET', '/api/admin/support', { token: S.admin });
  ok('التذكرة تظهر في صندوق دعم المزوّد',
    inbox.status === 200 && inbox.data.items.some(i => i.id === tk1.data.id));
  ok('الصندوق يعرض اسم الجهة مع التذكرة',
    inbox.data.items.find(i => i.id === tk1.data.id).tenant_name === 'مجمّع اختبار المستويات');
  ok('الصندوق يحصي المفتوح', inbox.data.open >= 1);
  ok('الرد الفارغ من المزوّد مرفوض',
    (await call('POST', `/api/admin/support/${tk1.data.id}/reply`, {
      token: S.admin, body: { reply: '   ' } })).status === 400);
  const rep = await call('POST', `/api/admin/support/${tk1.data.id}/reply`, {
    token: S.admin, body: { reply: 'صُحّح الخلل في تحديث اليوم', close: true } });
  ok('المزوّد يردّ على التذكرة', rep.status === 200 && rep.data.closed === true);
  const seen = await call('GET', `/api/comms/tickets/${tk1.data.id}`, { token: TK });
  ok('ردّ المزوّد يصل للجهة', seen.data.vendor?.reply === 'صُحّح الخلل في تحديث اليوم');
  ok('حالة المعالجة تظهر للجهة', seen.data.vendor.status === 'closed');
  const vNotif = (await call('GET', '/api/notifications', { token: TK })).data.items
    .find(n => n.type === 'ticket.vendor_reply');
  ok('صاحب التذكرة يُشعَر بردّ المزوّد', !!vNotif);
  ok('إشعار ردّ المزوّد يشير لتذكرته', String(vNotif.url).includes(`id=${tk1.data.id}`));
  ok('إشعار ردّ المزوّد يحمل معرّف تذكرته فلا تتصادم الوسوم',
    (typeof vNotif.data === 'string' ? JSON.parse(vNotif.data || '{}') : (vNotif.data || {})).id === tk1.data.id);
  ok('التذكرة تخرج من قائمة المفتوح بعد إغلاقها',
    !(await call('GET', '/api/admin/support?status=open', { token: S.admin })).data.items
      .some(i => i.id === tk1.data.id));
  ok('الرد على تذكرة غير مُصعّدة مرفوض',
    (await call('POST', '/api/admin/support/999999/reply', {
      token: S.admin, body: { reply: 'x' } })).status === 404);

  /* ─────────── المستوى ٢: ملاحظات وإدارة العلاقة ─────────── */
  const note = await call('POST', `/api/admin/tenants/${TID}/notes`, {
    token: S.admin, body: { body: 'اتصال متابعة — مهتمون بخطة المؤسسات', pinned: true } });
  ok('تسجيل ملاحظة على الجهة', note.status === 201);
  ok('الملاحظة توثّق كاتبها', note.data.author_name && note.data.author_id >= 1);
  ok('الملاحظة الفارغة مرفوضة',
    (await call('POST', `/api/admin/tenants/${TID}/notes`, { token: S.admin, body: { body: ' ' } })).status === 400);
  const notes = await call('GET', `/api/admin/tenants/${TID}/notes`, { token: S.admin });
  ok('الملاحظات تُقرأ بترتيبها',
    notes.data.some(n => n.body.startsWith('اتصال متابعة')));
  ok('الملاحظة المثبّتة تتصدّر القائمة', notes.data[0].pinned === 1);
  const crm = await call('PUT', `/api/admin/tenants/${TID}/crm`, {
    token: S.admin, body: { crm_stage: 'at_risk', contact_name: 'فريق المبيعات', crm_source: 'معرض' } });
  ok('تحديث مرحلة العلاقة مع الجهة', crm.status === 200 && crm.data.crm_stage === 'at_risk');
  ok('بيانات جهة الاتصال تُحفظ', crm.data.contact_name === 'فريق المبيعات' && crm.data.crm_source === 'معرض');
  ok('مرحلة غير معروفة مرفوضة',
    (await call('PUT', `/api/admin/tenants/${TID}/crm`, { token: S.admin, body: { crm_stage: 'zzz' } })).status === 400);
  ok('حذف الملاحظة متاح',
    (await call('DELETE', `/api/admin/tenants/${TID}/notes/${note.data.id}`, { token: S.admin })).status === 200);

  /* ─────────── المستوى ٣: الفاتورة الإلكترونية (ZATCA) ─────────── */
  const zs = await call('PUT', '/api/admin/settings', { token: S.admin, body: {
    zatca_enabled: true, vat_number: '300000000000003', cr_number: '1010101010',
    seller_address: { street: 'طريق الملك فهد', district: 'العليا', city: 'الرياض', postal_code: '12345' } } });
  ok('تفعيل الفوترة الإلكترونية من الإعدادات', zs.status === 200 && zs.data.zatca_enabled === 1);
  ok('الرقم الضريبي للمنصة محفوظ', zs.data.vat_number === '300000000000003');

  const zi = await call('POST', '/api/admin/invoices', {
    token: S.admin, body: { tenant_id: TID, note: 'فاتورة اختبار الفوترة الإلكترونية' } });
  ok('إصدار فاتورة بعد التفعيل', zi.status === 201);
  const ez = await call('GET', `/api/admin/einvoice/${zi.data.id}`, { token: S.admin });
  ok('الفاتورة مختومة برمز الاستجابة السريعة', ez.status === 200 && !!ez.data.qr);
  ok('الرمز يفكّ إلى وسوم ZATCA الإلزامية',
    ez.data.fields && [1, 2, 3, 4, 5].every(t => ez.data.fields[t] !== undefined));
  ok('اسم البائع في الرمز عربي سليم بلا تلف ترميز', /[؀-ۿ]/.test(ez.data.fields[1] || ''));
  ok('الرقم الضريبي مضمّن في الرمز', ez.data.fields[2] === '300000000000003');
  near('إجمالي الفاتورة في الرمز يطابقها', Number(ez.data.fields[4]), Number(zi.data.total));
  near('قيمة الضريبة في الرمز تطابق الفاتورة', Number(ez.data.fields[5]), Number(zi.data.vat_amount));
  ok('طابع الإصدار الزمني بصيغة ISO', !Number.isNaN(Date.parse(ez.data.fields[3])));
  ok('لكل فاتورة معرّف عالمي فريد', /^[0-9a-f-]{36}$/.test(ez.data.uuid));
  ok('الفاتورة مرتبطة بتجزئة سابقتها', !!ez.data.hash && !!ez.data.previous_hash);
  ok('مستند UBL محفوظ في التخزين', !!ez.data.xml_key);
  const chain = await call('GET', '/api/admin/einvoice/chain', { token: S.admin });
  ok('سلسلة التجزئة سليمة', chain.status === 200 && chain.data.intact === true,
    JSON.stringify(chain.data.breaks || []));
  ok('السلسلة تغطي كل الفواتير المختومة', chain.data.checked >= 1);
  const xml = await call('GET', `/api/billing/invoices/${zi.data.id}/xml`, { token: TK, raw: true });
  ok('الجهة تنزّل مستند UBL', xml.status === 200 && xml.buf.toString().includes('<cbc:UUID>'));
  ok('المستند بصيغة الفاتورة المبسّطة', xml.buf.toString().includes('InvoiceTypeCode'));
  ok('فاتورة غير مختومة لا تُعيد رمزاً',
    (await call('GET', '/api/admin/einvoice/999999', { token: S.admin })).status === 404);

  /* ─────────── المستوى ٣: التحقق بخطوتين ─────────── */
  const st = await call('POST', '/api/auth/2fa/setup', { token: TK });
  ok('بدء تفعيل التحقق بخطوتين', st.status === 200 && st.data.secret.length >= 16);
  ok('رابط التطبيق المصادق صحيح', st.data.uri.startsWith('otpauth://totp/'));
  ok('رمز خاطئ يمنع التفعيل',
    (await call('POST', '/api/auth/2fa/enable', { token: TK, body: { token: '000000' } })).status === 400);
  const en = await call('POST', '/api/auth/2fa/enable', { token: TK, body: { token: totpOf(st.data.secret) } });
  ok('الرمز الصحيح يفعّل التحقق بخطوتين', en.status === 200);
  ok('رموز الاسترداد تُسلَّم مرة واحدة', Array.isArray(en.data.backup_codes) && en.data.backup_codes.length >= 8);

  const noTotp = await login(MAIL, 'Verify@2026');
  ok('الدخول بدون الرمز مرفوض', noTotp.status === 401);
  ok('الواجهة تعرف أن الرمز مطلوب', noTotp.data?.error?.code === 'TOTP_REQUIRED');
  ok('رمز خاطئ يرفض الدخول',
    (await call('POST', '/api/auth/login', { body: { email: MAIL, password: 'Verify@2026', totp: '123456' } })).status === 401);
  const withTotp = await call('POST', '/api/auth/login', {
    body: { email: MAIL, password: 'Verify@2026', totp: totpOf(st.data.secret) } });
  ok('الدخول بالرمز الصحيح ينجح', withTotp.status === 200);
  const backup = en.data.backup_codes[0];
  const byBackup = await call('POST', '/api/auth/login', {
    body: { email: MAIL, password: 'Verify@2026', totp: backup } });
  ok('رمز الاسترداد يصلح للدخول', byBackup.status === 200);
  ok('رمز الاسترداد لا يُستخدم مرتين',
    (await call('POST', '/api/auth/login', { body: { email: MAIL, password: 'Verify@2026', totp: backup } })).status === 401);
  const TK2 = withTotp.data.accessToken;
  ok('حالة التحقق بخطوتين تظهر للمستخدم',
    (await call('GET', '/api/auth/2fa', { token: TK2 })).data.enabled === true);
  ok('إلغاء التحقق يتطلّب كلمة المرور',
    (await call('POST', '/api/auth/2fa/disable', { token: TK2, body: { password: 'wrong' } })).status === 400);

  /*
   * إلزام حسابات الادمن بالتحقق بخطوتين — يسري على جدول الادمن وحده،
   * ولا يمسّ مستخدمي المجمّعات لأن الطبقتين انفصلتا هويّةً ومساراً.
   */
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { require_2fa_admins: true } });
  ok('إلزام حسابات الادمن بالتحقق بخطوتين',
    (await call('GET', '/api/admin/auth/me', { token: S.admin })).data.security.totp_required === true);
  ok('الإلزام معلن أيضاً في مسار التحقق بخطوتين للادمن',
    (await call('GET', '/api/admin/auth/2fa', { token: S.admin })).data.required === true);
  ok('مستخدمو المجمّعات لا يشملهم الإلزام',
    (await call('GET', '/api/auth/me', { token: TK2 })).data.platform.totp_required === false);
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { require_2fa_admins: false } });
  ok('إلغاء التحقق بكلمة المرور الصحيحة',
    (await call('POST', '/api/auth/2fa/disable', { token: TK2, body: { password: 'Verify@2026' } })).status === 200);
  ok('الدخول يعود بلا رمز بعد الإلغاء', (await login(MAIL, 'Verify@2026')).status === 200);

  /* ─────────── المستوى ٣: مراقبة محاولات الدخول ─────────── */
  for (let i = 0; i < 3; i++) await login(`intruder${stamp}@x.sa`, 'WrongPass@1');
  const sec = await call('GET', '/api/admin/security?hours=24', { token: S.admin });
  ok('تقرير أمن الدخول متاح', sec.status === 200 && sec.data.total > 0);
  ok('المحاولات الفاشلة محصاة', sec.data.failed >= 3);
  ok('المحاولات الناجحة محصاة', sec.data.succeeded >= 1);
  ok('أكثر الحسابات استهدافاً مرصودة',
    sec.data.top_failed_accounts.some(f => f.email === `intruder${stamp}@x.sa` && f.attempts >= 3));
  ok('السجل يرصد عناوين المصدر', Array.isArray(sec.data.top_failed_ips));
  ok('التقرير يحصي الحسابات الموقوفة', typeof sec.data.suspended_accounts === 'number');
  ok('السجل يوثّق سبب كل رفض',
    sec.data.recent.some(r => r.success === 0 && !!r.reason));
  ok('السجل يميّز الرفض بسبب التحقق بخطوتين',
    sec.data.recent.some(r => /رمز التحقّق|رمز تحقّق/.test(r.reason || '')));

  /* ─────────── المستوى ٣: تصدير بيانات جهة كاملة ─────────── */
  const exp = await call('GET', `/api/admin/tenants/${TID}/export`, { token: S.admin, raw: true });
  ok('تصدير بيانات الجهة ينجح', exp.status === 200);
  ok('الملف مضغوط ومهيّأ للتنزيل',
    /attachment; filename=/.test(exp.res.headers.get('content-disposition') || ''));
  const zlib = await import('node:zlib');
  const sql = zlib.gunzipSync(exp.buf).toString('utf8');
  ok('التصدير يحوي سجل الجهة نفسها', new RegExp(`INSERT OR REPLACE INTO tenants\\(`).test(sql) && sql.includes(CODE));
  ok('التصدير يحوي مستخدمي الجهة', sql.includes(MAIL));
  ok('التصدير يحوي فواتير اشتراكها', sql.includes('subscription_invoices'));
  ok('التصدير لا يسرّب مستخدمي جهة أخرى', !sql.includes('admin@riyadh-qu.sa'));
  ok('التصدير لا يسرّب إعدادات المنصة ولا مفاتيح البوابة',
    !sql.includes('platform_settings') && !sql.includes('gateway_config'));
  ok('التصدير لا يسرّب خطط المنصة ولا كوبوناتها',
    !/INSERT OR REPLACE INTO plans\(/.test(sql) && !/INSERT OR REPLACE INTO coupons\(/.test(sql));
  ok('التصدير قابل للاستعادة (يُسقط المُشغّلات ثم يعيدها)',
    sql.includes('DROP TRIGGER IF EXISTS') && sql.includes('CREATE TRIGGER'));
  ok('التصدير يوثَّق في سجل المنصة',
    (await call('GET', '/api/admin/logs', { token: S.admin })).data.items
      .some(l => l.action === 'export' && l.entity === 'tenant'));
  ok('تصدير جهة غير موجودة مرفوض',
    (await call('GET', '/api/admin/tenants/999999/export', { token: S.admin })).status === 404);

  /* ─────────── المستوى ٤: الكوبونات ─────────── */
  const CP = 'VERIFY' + stamp;
  const cp = await call('POST', '/api/admin/coupons', { token: S.admin, body: {
    code: CP.toLowerCase(), name: 'خصم التدقيق', type: 'percent', value: 25, duration: 'once' } });
  ok('إنشاء كوبون خصم', cp.status === 201);
  ok('رمز الكوبون يُوحَّد بحروف كبيرة', cp.data.code === CP);
  ok('تكرار رمز الكوبون مرفوض',
    (await call('POST', '/api/admin/coupons', { token: S.admin,
      body: { code: CP, name: 'x', type: 'percent', value: 5 } })).status === 409);
  ok('نسبة خصم فوق ١٠٠٪ مرفوضة',
    (await call('POST', '/api/admin/coupons', { token: S.admin,
      body: { code: 'BAD' + stamp, name: 'x', type: 'percent', value: 150 } })).status === 400);
  ok('قيمة خصم صفرية مرفوضة',
    (await call('POST', '/api/admin/coupons', { token: S.admin,
      body: { code: 'ZER' + stamp, name: 'x', type: 'percent', value: 0 } })).status === 400);

  const apply = await call('POST', '/api/billing/coupon', { token: TK, body: { code: CP } });
  ok('الجهة تفعّل الكوبون', apply.status === 200 && apply.data.code === CP);
  near('معاينة الخصم ٢٥٪ من ٤٩٩', apply.data.discount_preview, 124.75);
  ok('كوبون غير موجود مرفوض',
    (await call('POST', '/api/billing/coupon', { token: TK, body: { code: 'NOPE' } })).status === 400);

  /* الرصيد المتبقي من الترقية يشوّش على حساب الكوبون — نصفّره أولاً */
  await call('POST', '/api/admin/invoices', { token: S.admin, body: { tenant_id: TID, note: 'استهلاك الرصيد' } });
  const cInv = await call('POST', '/api/admin/invoices', {
    token: S.admin, body: { tenant_id: TID, note: 'فاتورة بعد الكوبون' } });
  ok('الفاتورة تُصدر بعد تفعيل الكوبون', cInv.status === 201);
  const cpReport = await call('GET', '/api/admin/coupons', { token: S.admin });
  const mine = cpReport.data.find(c => c.code === CP);
  ok('تقرير الكوبونات يحصي الاستخدام', mine && mine.uses >= 1, JSON.stringify(mine));
  ok('التقرير يحصي قيمة الخصم الممنوح', Number(mine.total_discount) > 0);
  ok('التقرير يحصي الجهات المستفيدة', Number(mine.tenants) >= 1);
  ok('حذف كوبون مستخدَم مرفوض',
    (await call('DELETE', `/api/admin/coupons/${cp.data.id}`, { token: S.admin })).status === 409);
  ok('تعطيل الكوبون بديل الحذف',
    (await call('PATCH', `/api/admin/coupons/${cp.data.id}`, {
      token: S.admin, body: { is_active: false } })).data.is_active === 0);
  ok('إزالة الكوبون من الجهة متاحة',
    (await call('DELETE', '/api/billing/coupon', { token: TK })).status === 200);

  /* ─────────── المستوى ٤: الإشعارات الدائنة ─────────── */
  const paidInv = await call('POST', '/api/admin/invoices', {
    token: S.admin, body: { tenant_id: TID, note: 'فاتورة للإشعار الدائن' } });
  await call('POST', `/api/admin/invoices/${paidInv.data.id}/mark-paid`, { token: S.admin });
  const before = Number((await call('GET', '/api/billing', { token: TK })).data.credit_balance || 0);
  const cn = await call('POST', `/api/admin/invoices/${paidInv.data.id}/credit-note`, {
    token: S.admin, body: { amount: 115, reason: 'خصم تسوية' } });
  ok('إصدار إشعار دائن على فاتورة مسددة', cn.status === 201 && cn.data.doc_type === 'credit_note');
  ok('الإشعار الدائن مرتبط بفاتورته الأصلية', cn.data.parent_id === paidInv.data.id);
  near('الإشعار يفصل الأصل عن الضريبة', cn.data.subtotal, 100);
  near('ضريبة الإشعار الدائن ١٥٪', cn.data.vat_amount, 15);
  const after = Number((await call('GET', '/api/billing', { token: TK })).data.credit_balance || 0);
  /* الرصيد يُخزَّن ويُطبَّق قبل الضريبة، فيعود للجهة ١١٥ عند احتساب الضريبة على الفاتورة التالية */
  near('الإشعار الدائن على فاتورة مسددة يزيد الرصيد صافياً', after - before, 100);

  const openInv = await call('POST', '/api/admin/invoices', {
    token: S.admin, body: { tenant_id: TID, note: 'فاتورة غير مسددة' } });
  const balBefore = Number((await call('GET', '/api/billing', { token: TK })).data.credit_balance || 0);
  const cn2 = await call('POST', `/api/admin/invoices/${openInv.data.id}/credit-note`, {
    token: S.admin, body: { reason: 'إلغاء كامل' } });
  ok('إشعار دائن على فاتورة غير مسددة ينجح', cn2.status === 201);
  const balAfter = Number((await call('GET', '/api/billing', { token: TK })).data.credit_balance || 0);
  ok('لا يُمنح رصيد على مبلغ لم يُدفع', Math.abs(balAfter - balBefore) < 0.01,
    `قبل ${balBefore} بعد ${balAfter}`);
  ok('الفاتورة تُلغى بتغطيتها كاملةً',
    (await call('GET', `/api/billing/invoices/${openInv.data.id}`, { token: TK })).data.status === 'void');
  ok('تجاوز قيمة الفاتورة بإشعار دائن ممنوع',
    (await call('POST', `/api/admin/invoices/${openInv.data.id}/credit-note`, {
      token: S.admin, body: { amount: 5000 } })).status === 400);

  /* ─────────── المستوى ٤: بوابات الدفع ─────────── */
  const gw = await call('GET', '/api/admin/gateways', { token: S.admin });
  ok('كتالوج بوابات الدفع متاح', gw.status === 200 && gw.data.options.length >= 2);
  ok('البوابات تشمل مزوّدات سعودية',
    gw.data.options.some(g => /moyasar|tap/i.test(g.key)));
  ok('البوابة غير مهيّأة ابتدائياً', gw.data.configured === false);
  ok('كل بوابة تحمل مفتاحها واسمها العربي لتبنى منها قائمة الإعدادات',
    gw.data.options.every(g => g.key && g.label));
  ok('الكتالوج يعلن أي البوابات تحوّل لصفحتها',
    gw.data.options.some(g => g.redirects === true) && gw.data.options.some(g => g.redirects === false));
  const payTry = await call('POST', `/api/billing/invoices/${paidInv.data.id}/pay`, { token: TK });
  ok('الدفع الإلكتروني يُرفض قبل تهيئة البوابة', payTry.status === 400);
  await call('PUT', '/api/admin/settings', { token: S.admin, body: {
    payment_gateway: 'moyasar', gateway_config: { secret_key: 'sk_test_verify', publishable_key: 'pk_test' } } });
  ok('تهيئة البوابة تُحفظ',
    (await call('GET', '/api/admin/gateways', { token: S.admin })).data.configured === true);
  ok('مفتاح البوابة السرّي لا يُسرَّب للجهة',
    !JSON.stringify((await call('GET', '/api/billing', { token: TK })).data).includes('sk_test_verify'));
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { gateway_config: {} } });

  /* ─────────── المستوى ٤: تجاوزات الحدود والمزايا ─────────── */
  const ovr = await call('PUT', `/api/admin/tenants/${TID}/overrides`, { token: S.admin, body: {
    limits: { branches: 1 }, features: { finance: false, api: true } } });
  ok('ضبط تجاوزات خاصة بالجهة', ovr.status === 200);
  eq('حد الفروع الخاص يطغى على الخطة', ovr.data.limits.branches, 1);
  ok('إيقاف ميزة لجهة رغم توفرها في خطتها',
    !ovr.data.features.includes('finance') && ovr.data.features.includes('api'));
  ok('الوحدة الموقوفة تُحجب فعلياً',
    (await call('GET', '/api/finance/requests', { token: TK })).status === 403);
  ok('الوحدة الممنوحة تُفتح فعلياً',
    (await call('GET', '/api/api-keys', { token: TK })).status === 200);
  const br = await call('POST', '/api/org/branches', { token: TK, body: {
    name: 'فرع إضافي', code: 'X1', lat: 24.7, lng: 46.7, radius_m: 150 } });
  ok('حد الفروع الخاص يمنع التجاوز', br.status === 403, `status ${br.status}`);
  ok('رسالة التجاوز تذكر الحد الخاص لا حد الخطة',
    br.data?.error?.details?.limit === 1 && br.data.error.details.resource === 'branches');
  ok('مفتاح ميزة غير معروف يُتجاهل',
    !(await call('PUT', `/api/admin/tenants/${TID}/overrides`, { token: S.admin,
      body: { features: { not_a_feature: true } } })).data.overrides.features.not_a_feature);
  await call('PUT', `/api/admin/tenants/${TID}/overrides`, {
    token: S.admin, body: { limits: {}, features: {} } });
  ok('إزالة التجاوزات تعيد سلوك الخطة',
    (await call('GET', '/api/finance/requests', { token: TK })).status === 200);

  /* ─────────── المستوى ٤: بيانات المشتري وأمر الشراء ─────────── */
  ok('رقم ضريبي غير صحيح مرفوض',
    (await call('PUT', '/api/billing/billing-entity', { token: TK,
      body: { name: 'x', vat_number: '123' } })).status === 400);
  const be = await call('PUT', '/api/billing/billing-entity', { token: TK, body: {
    name: 'مجمّع اختبار المستويات', vat_number: '311111111111113', cr_number: '1010202020',
    po_number: 'PO-2026-77', email: 'acc@verify.sa',
    address: { street: 'شارع الأمير', district: 'النخيل', city: 'الرياض', postal_code: '11564' } } });
  ok('حفظ بيانات المشتري والرقم الضريبي', be.status === 200 && be.data.vat_number === '311111111111113');
  const poInv = await call('POST', '/api/admin/invoices', {
    token: S.admin, body: { tenant_id: TID, note: 'فاتورة بأمر شراء' } });
  const full = await call('GET', `/api/billing/invoices/${poInv.data.id}`, { token: TK });
  ok('الفاتورة تحمل بيانات المشتري', full.data.buyer?.vat_number === '311111111111113');
  ok('الفاتورة تحمل رقم أمر الشراء', full.data.buyer.po_number === 'PO-2026-77');
  const pxml = await call('GET', `/api/billing/invoices/${poInv.data.id}/xml`, { token: TK, raw: true });
  ok('رقم المشتري الضريبي مضمّن في مستند UBL',
    pxml.status === 200 && pxml.buf.toString().includes('311111111111113'));
  ok('أمر الشراء مضمّن في مستند UBL', pxml.buf.toString().includes('PO-2026-77'));

  /* ─────────── تنظيف ─────────── */
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { zatca_enabled: false } });
  await call('DELETE', `/api/admin/tenants/${TID}?confirm=${CODE}`, { token: S.admin });
  ok('حذف جهة الاختبار بعد الانتهاء',
    (await call('GET', `/api/admin/tenants/${TID}`, { token: S.admin })).status === 404);
  await call('PUT', '/api/admin/settings', {
    token: S.admin, body: { saas_enabled: false, signup_enabled: false } });
});

/* ═════════ ٢١. حدود بيئة التشغيل ═════════ */
section('٢١. حدود بيئة Cloudflare المفروضة على الشيفرة', async () => {
  const { readFileSync } = await import('node:fs');
  const crypto = readFileSync('server/core/crypto.js', 'utf8');

  /*
   * سقف Workers لتكرارات PBKDF2 هو ١٠٠٬٠٠٠، ولا تفرضه بيئة التطوير المحلية
   * ولا Node — فتمرّ كل الفحوص محلياً ثم تسقط التهيئة على الإنتاج.
   * هذا الفحص يقرأ المصدر فيكشف التجاوز قبل النشر لا بعده.
   */
  const cap = Number((crypto.match(/PBKDF2_MAX_ITERATIONS\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ''));
  ok('سقف تكرارات PBKDF2 معرّف صراحةً', cap === 100000, `القيمة ${cap}`);

  const literals = [...crypto.matchAll(/iterations\s*=\s*([\d_]+)/g)]
    .map(m => Number(m[1].replace(/_/g, ''))).filter(Number.isFinite);
  ok('لا عدد تكرارات يتجاوز سقف Workers',
    literals.every(n => n <= 100000), `القيم: ${literals.join('، ')}`);

  /* التجزئة المولَّدة فعلاً يجب أن تلتزم السقف */
  const { hashPassword, needsRehash } = await import('../server/core/crypto.js');
  const h = await hashPassword('Verify@2026');
  const used = Number(h.split('$')[2]);
  ok('التجزئة المولَّدة تلتزم السقف', used <= 100000, `استُعملت ${used}`);
  ok('صيغة التجزئة تحمل عدد تكراراتها', /^pbkdf2\$sha256\$\d+\$/.test(h));
  ok('تجزئة تتجاوز السقف تُعلَّم للترقية',
    needsRehash('pbkdf2$sha256$150000$c2FsdA$aGFzaA') === true);
  ok('تجزئة ملتزمة بالسقف لا تُعلَّم', needsRehash(h) === false);
  ok('تجزئة bcrypt القديمة تُعلَّم للترقية',
    needsRehash('$2b$10$abcdefghijklmnopqrstuv') === true);

  /* الدخول الحقيقي يثبت أن السلسلة كلها تعمل على بيئة التشغيل الجارية */
  ok('الدخول يعمل بالتجزئة الملتزمة بالسقف',
    (await login('admin@riyadh-qu.sa', 'Admin@123')).status === 200);

  /*
   * أزرار «الحسابات التجريبية» تفتح حساب مالك كامل الصلاحية بنقرة واحدة.
   * كانت مقيّدة بتعطيل طبقة الـ SaaS فقط — وهي معطّلة افتراضياً — فتظهر على
   * كل نسخة منشورة. القرار الآن للخادم، والافتراض المغلق: إنتاج ما لم يُصرَّح.
   */
  const pub = (await call('GET', '/api/public/platform')).data;
  ok('الخادم يصرّح بحالة الحسابات التجريبية', typeof pub.demo_logins === 'boolean');
  const login_js = readFileSync('web/js/views/login.js', 'utf8');
  ok('شاشة الدخول لا تعرضها إلا بإذن الخادم',
    /platform\?\.demo_logins/.test(login_js));
  /* الاقتران هو المطلوب: تُفتح على التطوير وحده، ويقرّرها الخادم لا العميل */
  const srvEnv = (await call('GET', '/api/health')).data.env;
  ok('الحسابات التجريبية مقترنة ببيئة الخادم لا بشيء آخر',
    pub.demo_logins === (srvEnv === 'development'),
    `env=${srvEnv} · demo_logins=${pub.demo_logins}`);
  ok('بيئة الإنتاج تحجبها قطعاً',
    srvEnv === 'development' || pub.demo_logins === false, `env=${srvEnv}`);
});

/* ═════════ ٢٢. فصل هويّة لوحة المنصة ═════════ */
section('٢٢. فصل هويّة لوحة المنصة عن المجمّعات', async () => {
  const stamp = Date.now().toString().slice(-6);

  /* ── جمهور الرمز: كل حارس يرفض رمز الآخر ── */
  const a = await adminLogin();
  ok('دخول الادمن يُصدر رمزاً ورمز تجديد', a.status === 200 && !!a.data.accessToken && !!a.data.refreshToken);
  const ADM = a.data.accessToken;
  ok('جلسة الادمن لا تحمل جهة ولا فروعاً ولا فصولاً',
    !!a.data.admin && a.data.branches === undefined && a.data.current_term === undefined
    && a.data.tenant === undefined);

  for (const [path, label] of [['/api/tasks', 'المهام'], ['/api/org/users', 'المستخدمين'],
    ['/api/finance/requests', 'المالية'], ['/api/auth/me', 'جلسة المجمّع']]) {
    ok(`رمز الادمن لا يفتح ${label}`, (await call('GET', path, { token: ADM })).status === 403);
  }
  for (const [path, label] of [['/api/admin/overview', 'نظرة عامة'], ['/api/admin/tenants', 'المجمّعات'],
    ['/api/admin/settings', 'الإعدادات'], ['/api/admin/logs', 'سجل المنصة']]) {
    ok(`رمز المجمّع لا يفتح ${label}`, (await call('GET', path, { token: S.owner })).status === 403);
  }
  ok('رمز مزوّر لا يفتح اللوحة',
    (await call('GET', '/api/admin/overview', { token: 'not.a.token' })).status === 401);

  /* ── العزل البنيوي: لا وجود لحساب ادمن داخل أي مجمّع ── */
  ok('حساب الادمن غائب عن مستخدمي المجمّع',
    !JSON.stringify((await call('GET', '/api/org/users', { token: S.owner })).data)
      .includes('admin@raqeem.sa'));
  ok('لا مستخدم مجمّع يحمل صلاحية منصة',
    (await call('GET', '/api/admin/admins', { token: ADM })).data
      .every(x => !String(x.email).includes('riyadh-qu.sa')));

  /* ── دورة حياة حساب ادمن ── */
  const MAIL = `adm${stamp}@raqeem.sa`;
  ok('كلمة مرور قصيرة مرفوضة',
    (await call('POST', '/api/admin/admins', { token: ADM,
      body: { name: 'ت', email: MAIL, password: '123' } })).status === 400);
  ok('بريد غير صالح مرفوض',
    (await call('POST', '/api/admin/admins', { token: ADM,
      body: { name: 'ت', email: 'bad', password: 'Admin@2026' } })).status === 400);

  const nw = await call('POST', '/api/admin/admins', { token: ADM,
    body: { name: 'ادمن الاختبار', email: MAIL, password: 'Admin@2026' } });
  ok('إنشاء حساب ادمن جديد', nw.status === 201);
  ok('تكرار البريد مرفوض',
    (await call('POST', '/api/admin/admins', { token: ADM,
      body: { name: 'x', email: MAIL, password: 'Admin@2026' } })).status === 409);

  const n2 = await adminLogin(MAIL, 'Admin@2026');
  ok('الحساب الجديد يدخل فوراً', n2.status === 200);
  const ADM2 = n2.data.accessToken;
  ok('ويفتح اللوحة', (await call('GET', '/api/admin/overview', { token: ADM2 })).status === 200);

  /* الإيقاف يُنهي الجلسات القائمة لا عند انتهاء صلاحيتها */
  ok('إيقاف الحساب ينجح',
    (await call('PATCH', `/api/admin/admins/${nw.data.id}`, { token: ADM,
      body: { status: 'suspended' } })).data.status === 'suspended');
  ok('الحساب الموقوف لا يدخل', (await adminLogin(MAIL, 'Admin@2026')).status === 401);
  ok('ورمزه القائم يسقط فوراً',
    (await call('GET', '/api/admin/overview', { token: ADM2 })).status === 401);

  ok('لا يحذف المرء حسابه بنفسه',
    (await call('DELETE', `/api/admin/admins/${a.data.admin.id}`, { token: ADM })).status === 400);
  ok('حذف الحساب المضاف ينجح',
    (await call('DELETE', `/api/admin/admins/${nw.data.id}`, { token: ADM })).status === 200);

  /* ── تغيير كلمة المرور يُنهي الجلسات الأخرى ── */
  const t3 = await adminLogin();
  ok('جلسة ثانية للادمن نفسه', t3.status === 200);
  ok('كلمة مرور حالية خاطئة مرفوضة',
    (await call('POST', '/api/admin/auth/change-password', { token: ADM,
      body: { current: 'wrong', next: 'Admin@9999' } })).status === 400);
  ok('تغيير كلمة المرور ينجح',
    (await call('POST', '/api/admin/auth/change-password', { token: ADM,
      body: { current: 'Admin@123', next: 'Admin@9999' } })).status === 200);
  ok('رمز التجديد القديم لم يعد يعمل',
    (await call('POST', '/api/admin/auth/refresh',
      { body: { refreshToken: t3.data.refreshToken } })).status === 401);
  ok('الدخول بكلمة المرور الجديدة يعمل', (await adminLogin('admin@raqeem.sa', 'Admin@9999')).status === 200);
  /* نعيدها كي لا تتأثر بقية الأقسام */
  const back = await adminLogin('admin@raqeem.sa', 'Admin@9999');
  await call('POST', '/api/admin/auth/change-password', { token: back.data.accessToken,
    body: { current: 'Admin@9999', next: 'Admin@123' } });
  ok('كلمة المرور أُعيدت لأصلها', (await adminLogin()).status === 200);

  /* ── التجديد والخروج ── */
  const fresh = await adminLogin();
  const rf = await call('POST', '/api/admin/auth/refresh', { body: { refreshToken: fresh.data.refreshToken } });
  ok('تجديد جلسة الادمن يعمل', rf.status === 200 && !!rf.data.accessToken);
  ok('الرمز المجدَّد يفتح اللوحة',
    (await call('GET', '/api/admin/overview', { token: rf.data.accessToken })).status === 200);
  await call('POST', '/api/admin/auth/logout', { body: { refreshToken: fresh.data.refreshToken } });
  ok('الخروج يُبطل رمز التجديد',
    (await call('POST', '/api/admin/auth/refresh',
      { body: { refreshToken: fresh.data.refreshToken } })).status === 401);

  /* ── محو مجمّع لا يمسّ حسابات الادمن ── */
  const before = (await call('GET', '/api/admin/admins', { token: S.admin })).data.length;
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { saas_enabled: true, signup_enabled: true } });
  const CODE = 'X' + stamp;
  const su = await call('POST', '/api/public/signup', { body: {
    code: CODE, tenant_name: 'مجمّع للحذف', admin_name: 'م', email: `x${stamp}@v.sa`,
    password: 'Verify@2026', plan_code: 'starter' } });
  ok('تهيئة مجمّع للحذف', su.status === 201);
  await call('DELETE', `/api/admin/tenants/${su.data.tenant.id}?confirm=${CODE}`, { token: S.admin });
  ok('محو مجمّع لا ينقص حسابات الادمن',
    (await call('GET', '/api/admin/admins', { token: S.admin })).data.length === before);
  await call('PUT', '/api/admin/settings', { token: S.admin, body: { saas_enabled: false, signup_enabled: false } });

  /* ── سجل المنصة ينسب العملية للادمن لا لمستخدم مجمّع ── */
  const logs = (await call('GET', '/api/admin/logs', { token: S.admin })).data.items;
  ok('سجل المنصة يسمّي الادمن فاعلاً', logs.some(l => l.actor_name && !String(l.actor_name).includes('عبدالله')));
  ok('دخول الادمن موثّق في السجل', logs.some(l => l.entity === 'platform_admin' || l.action === 'login'));

  /* ── الهيكل: لوحة المنصة لا تشترك مع لوحة المجمّعات في شيء ── */
  const { readFileSync } = await import('node:fs');
  const appJs = readFileSync('web/js/app.js', 'utf8');
  const shell = readFileSync('web/js/admin-shell.js', 'utf8');
  ok('لوحة المنصة لها هيكلها المستقل',
    /location\.pathname\.startsWith\('\/admin'\)/.test(appJs) && shell.includes('admin-shell'));
  ok('بند اللوحة أُزيل من قائمة المجمّعات', !/path: '\/platform'/.test(appJs));
  ok('اللوحة لا تبني مبدّل فروع ولا فصول',
    !shell.includes('switcher') && !shell.includes('activeBranch'));
  ok('اللوحة تستعمل عميلها ذا الرمز المستقل',
    shell.includes("from './admin-api.js'")
    && readFileSync('web/js/admin-api.js', 'utf8').includes('raqeem_admin_at') === false
    && readFileSync('web/js/admin-state.js', 'utf8').includes('raqeem_admin_at'));
  ok('جلستا المجمّع والادمن لا تتشاركان مفتاح تخزين',
    !readFileSync('web/js/state.js', 'utf8').includes('raqeem_admin_'));
  ok('الدخول الإداري يفتح تبويباً ولا يبدّل جلسة الادمن',
    readFileSync('web/js/views/admin/sections.js', 'utf8').includes('impersonate='));
  ok('عامل الخدمة يخزّن ملفات اللوحة',
    ['admin-shell.js', 'admin-api.js', 'views/admin/sections.js']
      .every(f => readFileSync('web/sw.js', 'utf8').includes(f)));
});

/* ═════════ ٢٣. الشاشة الرئيسية العامة ═════════ */
section('٢٣. الشاشة الرئيسية العامة ومحرّرها', async () => {
  const ADM = (await adminLogin()).data.accessToken;
  const stamp = Date.now().toString().slice(-6);

  /* ── القراءة عامة والتحرير محصور ── */
  const pub = await call('GET', '/api/public/landing');
  ok('الشاشة الرئيسية تُقرأ بلا مصادقة', pub.status === 200 && typeof pub.data.enabled === 'boolean');
  ok('الكتلة العامة تحمل هوية المنصة', !!pub.data.platform?.name);
  ok('التحرير مرفوض بلا مصادقة', (await call('PUT', '/api/admin/landing', { body: { landing: {} } })).status === 401);
  ok('التحرير مرفوض برمز مجمّع',
    (await call('PUT', '/api/admin/landing', { token: S.owner, body: { landing: {} } })).status === 403);
  ok('القراءة الإدارية تُرجع الافتراضي مع المحرَّر',
    (await call('GET', '/api/admin/landing', { token: ADM })).data.defaults?.hero?.title !== undefined);

  /* ── ما يُحرَّر هو ما يُعرَض ── */
  const put = await call('PUT', '/api/admin/landing', { token: ADM, body: { landing: {
    enabled: true,
    hero: { title: `عنوان ${stamp}`, subtitle: 'وصف', cta_label: 'ابدأ', cta_href: '/signup',
      secondary_label: 'دخول', secondary_href: '/login' },
    features: [{ icon: '✨', title: 'ميزة', body: 'وصف الميزة' }],
    stats: [{ label: 'مجمّع', value: '12' }],
    sections: [{ type: 'cta', title: 'جاهز؟', body: 'ابدأ', cta_label: 'حساب', cta_href: '/signup' }],
    footer: { links: [{ label: 'الأسعار', href: '/pricing' }], note: 'ملاحظة' },
    seo: { title: 'رقيم', description: 'وصف' } } } });
  ok('حفظ الشاشة الرئيسية', put.status === 200);
  const after = await call('GET', '/api/public/landing');
  ok('المحتوى المحرَّر يظهر للزائر', after.data.hero.title === `عنوان ${stamp}` && after.data.enabled === true);
  ok('المزايا والأرقام والأقسام تُحفظ',
    after.data.features.length === 1 && after.data.stats.length === 1 && after.data.sections.length === 1);
  ok('روابط التذييل تُحفظ', after.data.footer.links[0]?.href === '/pricing');

  /* ── التطهير: كتلة عامة يكتبها الادمن ويقرؤها الغريب ── */
  const evil = await call('PUT', '/api/admin/landing', { token: ADM, body: { landing: {
    enabled: true,
    hero: { title: 'ط', cta_label: 'اضغط', cta_href: 'javascript:alert(1)', image_url: 'data:text/html,x' },
    footer: { links: [{ label: 'سيء', href: 'javascript:x' }, { label: 'حسن', href: '/pricing' }] },
    features: Array.from({ length: 40 }, (_, i) => ({ icon: '★', title: `م${i}`, body: 'ب' })),
    sections: Array.from({ length: 40 }, () => ({ type: 'text', title: 'ق', body: 'ن' })) } } });
  const L = evil.data.landing;
  ok('رابط javascript: يُجرَّد من زر الواجهة', L.hero.cta_href === '');
  ok('رابط data: يُجرَّد من الصورة', L.hero.image_url === '');
  ok('رابط javascript: يُسقط من التذييل ويبقى السليم',
    L.footer.links.length === 1 && L.footer.links[0].href === '/pricing');
  ok('عدد المزايا محدود', L.features.length === 12);
  ok('عدد الأقسام محدود', L.sections.length === 8);
  ok('النص الطويل يُقصّ',
    (await call('PUT', '/api/admin/landing', { token: ADM, body: { landing: {
      enabled: true, hero: { title: 'ط'.repeat(900) } } } })).data.landing.hero.title.length <= 160);
  ok('نوع القسم محصور في المعروف',
    (await call('PUT', '/api/admin/landing', { token: ADM, body: { landing: {
      enabled: true, sections: [{ type: 'script', title: 'ق', body: 'ن' }] } } }))
      .data.landing.sections[0].type === 'text');

  /* ── الإطفاء يعيد «/» إلى شاشة الدخول ── */
  await call('PUT', '/api/admin/landing', { token: ADM, body: { landing: { enabled: false } } });
  ok('الإطفاء يظهر في المسار العام', (await call('GET', '/api/public/landing')).data.enabled === false);
  /* ثم تُعاد للنشر: هي الحال الافتراضية للمنصة */
  await call('PUT', '/api/admin/landing', { token: ADM, body: { landing: { enabled: true } } });
  ok('التحرير يُسجَّل في سجل المنصة',
    (await call('GET', '/api/admin/logs?entity=landing', { token: ADM })).data.items.length > 0);

  /* ── الواجهة: «/» للزائر و«/login» للدخول ── */
  const { readFileSync } = await import('node:fs');
  const appJs = readFileSync('web/js/app.js', 'utf8');
  const land = readFileSync('web/js/views/landing.js', 'utf8');
  /* حال النشر وشريط الشاشات العامة انتقلا إلى وحدةٍ يشترك فيها الجميع */
  const pubShell = readFileSync('web/js/public-shell.js', 'utf8');
  ok('«/» يتفرّع على حال النشر', appJs.includes('landingPublished'));
  ok('الشاشة الرئيسية تُشحن منشورة',
    (await import('../server/core/landing.js')).DEFAULT_LANDING.enabled === true);
  ok('الجذر صفحةٌ رئيسية للزائر وللمسجَّل معاً',
    (appJs.match(/path === '\/' && await showLanding\(app\)/g) || []).length === 2);
  ok('لوحة المجمّع انتقلت إلى امتدادها',
    appJs.includes("{ path: '/dashboard'") && !/\{ path: '\/', label: 'لوحة التحكم'/.test(appJs));
  ok('الدخول ينقل إلى لوحة المجمّع لا إلى الجذر',
    appJs.includes("history.replaceState({}, '', '/dashboard')"));
  ok('التطبيق المثبَّت يقلع على اللوحة',
    JSON.parse(readFileSync('web/manifest.webmanifest', 'utf8')).start_url.startsWith('/dashboard'));
  ok('الصفحة الرئيسية تعرف المسجَّل',
    land.includes('signedIn') && land.includes("'/dashboard'"));
  ok('الرجوع الافتراضي شاشة الدخول عند التعذّر', /catch \{ landingState = false; \}/.test(pubShell));
  /* الشاشات العامة كلُّها تحمل الشريط: علامةٌ تعود إلى الجذر ومفتاحُ مظهر */
  ok('الشاشات العامة تحمل شريطاً واحداً',
    ['login', 'pricing', 'signup'].every(v =>
      readFileSync(`web/js/views/${v}.js`, 'utf8').includes('publicTop')));
  ok('شاشة الدخول تحمل اسم المنصة لا اسم مجمّع',
    readFileSync('web/js/views/login.js', 'utf8').includes("name: brand?.platform?.name"));
  /* لا تراجعَ إلى جهةٍ بعينها: التخصيص من النطاق وحده */
  ok('لا تراجع إلى جهةٍ على شاشة الدخول المشتركة',
    !/tenant = await app\.db\.get\('SELECT \* FROM tenants(?! WHERE)/.test(
      readFileSync('server/core/routes/public.js', 'utf8')));
  /* شيفرة التطبيق من الشبكة أولاً: الذاكرة أولاً تُبقي المستخدم وراء نسخة */
  ok('شيفرة التطبيق تُجلَب من الشبكة أولاً',
    /isCode/.test(readFileSync('web/sw.js', 'utf8')));

  /* ── المناطق الآمنة: الجزيرة الديناميكية تبتلع أعلى الشاشة في التطبيق المثبَّت ── */
  {
    const css = readFileSync('web/css/app.css', 'utf8');
    /* كل قاعدةٍ لشريطٍ علويّ — في كل استعلامات الوسائط — تذكر المنطقة الآمنة */
    const bars = [...css.matchAll(/(^|\})\s*(\.topbar|\.land-top|\.admin-top|\.side-head)\s*\{([^}]*)\}/gm)]
      .map(m => ({ sel: m[2], body: m[3] }));
    const blind = bars.filter(b => !b.body.includes('--safe-t'));
    ok('كل شريطٍ علويّ يحمل المنطقة الآمنة',
      bars.length >= 4 && blind.length === 0,
      blind.map(b => b.sel).join('، '));
    /* والحشوة تُضاف إلى الارتفاع لا تُطرَح منه (`border-box`) */
    ok('ارتفاع الشريط يحمل المنطقة الآمنة',
      /\.topbar\{height:calc\(var\(--top\) \+ var\(--safe-t\)\)/.test(css));
  }

  /* ── الخريطة الحقيقية ── */
  ok('الخريطة في ضبط الفرع وفي التحضير',
    readFileSync('web/js/views/org.js', 'utf8').includes('geoMap')
    && readFileSync('web/js/views/hr.js', 'utf8').includes('geoMap'));
  ok('مربّعات الخريطة مسموحةٌ في سياسة الصور وحدها',
    /img-src[^;]*tile\.openstreetmap\.org/.test(readFileSync('web/_headers', 'utf8'))
    && !/connect-src[^;]*openstreetmap/.test(readFileSync('web/_headers', 'utf8')));
  ok('الخريطة تُخفي المربّع الذي لا يصل',
    /gm-blind/.test(readFileSync('web/js/map.js', 'utf8')));

  /* ── إغلاق العهد المالية ── */
  {
    const fin = readFileSync('server/core/routes/finance.js', 'utf8');
    ok('مسارات إغلاق العهدة موجودة',
      fin.includes("'/requests/:id/settlement'") && fin.includes("'/requests/:id/settlement/approve'"));
    ok('العجز يُحتسَب من الفواتير لا يُخزَّن', /const covered = lines\.reduce/.test(fin));
    ok('الاعتماد بعجزٍ يحتاج صلاحيته', /finance\.settle_deficit/.test(fin));
    ok('صلاحية اعتماد العجز معرَّفة',
      readFileSync('server/core/permissions.js', 'utf8').includes('finance.settle_deficit'));
    ok('المرفق يُتحقَّق أنه ملفُّ الجهة', /FROM files WHERE id=\? AND tenant_id=\?/.test(fin));
    ok('العهد المفتوحة في لوحة التحكم',
      /type='custody'/.test(readFileSync('server/core/routes/data.js', 'utf8')));
  }
  /* `append` تحوّل القيمة الفارغة إلى نصّ «null» — فتُستعمل `mount` */
  ok('الدرج لا يكتب null في أسفله',
    /mount\(panel,/.test(readFileSync('web/js/util.js', 'utf8')));

  /* حدّ الكرون خمسةٌ للحساب كلِّه — وبيئة التجربة لا تزاحم الإنتاج عليه */
  {
    const wr = readFileSync('wrangler.toml', 'utf8');
    const top = (wr.match(/\[triggers\][\s\S]*?crons = \[([\s\S]*?)\]/) || [, ''])[1];
    ok('مُشغِّلات الإنتاج خمسةٌ فأقلّ',
      (top.match(/"/g) || []).length / 2 <= 5, `${(top.match(/"/g) || []).length / 2}`);
    ok('بيئة التجربة بلا مُشغِّلات', /\[env\.staging\.triggers\][\s\S]*?crons = \[\s*\]/.test(wr));
  }

  /* لا يُعرَض تفعيلُ إشعاراتٍ لا يستطيع الخادم إرسالها */
  ok('لا يُعرَض تفعيل الإشعارات وخدمة الدفع معطّلة',
    /st\?\.enabled/.test(readFileSync('web/js/push.js', 'utf8')));
  ok('مسارات الدخول تُستبدل بعد الدخول', appJs.includes("['/login', '/signup']"));
  ok('الصفحة تبني نصاً لا وسماً', !/\.innerHTML\s*=|insertAdjacentHTML/.test(land));
  ok('الصفحة العامة تُخزَّن في عامل الخدمة',
    readFileSync('web/sw.js', 'utf8').includes('/js/views/landing.js'));
  ok('محرّر الشاشة في قائمة اللوحة',
    readFileSync('web/js/admin-shell.js', 'utf8').includes("'/admin/landing'"));
  for (const [f, needle] of [['web/js/views/pricing.js', "navigate('/login')"],
    ['web/js/views/signup.js', "navigate('/login')"]]) {
    ok(`روابط الدخول في ${f.split('/').pop()} تشير إلى /login`, readFileSync(f, 'utf8').includes(needle));
  }
});

/* ═════════ ٢٤. قوالب الفصول الدراسية ═════════ */
section('٢٤. قوالب الفصول الافتراضية وفرضها', async () => {
  const ADM = (await adminLogin()).data.accessToken;
  const stamp = Date.now().toString().slice(-6);

  /* ── القراءة والصلاحية ── */
  const list = await call('GET', '/api/admin/terms', { token: ADM });
  ok('قوالب الفصول تُقرأ من اللوحة', list.status === 200 && Array.isArray(list.data.items));
  ok('القوالب مزروعة في التهيئة الأولى', list.data.items.length >= 3);
  ok('كل قالب يعرض تطبيقه القادم',
    list.data.items.every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.preview?.start_date)
      && t.preview.end_date > t.preview.start_date));
  ok('التطبيق القادم لا يقع في الماضي',
    list.data.items.every(t => t.preview.end_date >= new Date().toISOString().slice(0, 10)));
  ok('القوالب محجوبة عن رمز المجمّع',
    (await call('GET', '/api/admin/terms', { token: S.owner })).status === 403);
  ok('القوالب محجوبة بلا مصادقة', (await call('GET', '/api/admin/terms')).status === 401);

  /* ── التحقّق من المدخلات ── */
  const bad = [
    [{ code: 'ب-١', name: 'س' }, 'رمز عربي مرفوض'],
    [{ code: `X${stamp}`, name: '' }, 'اسم فارغ مرفوض']
  ];
  for (const [body, label] of bad) {
    ok(label, (await call('POST', '/api/admin/terms', { token: ADM, body })).status === 400);
  }

  const CODE = `TT${stamp}`.slice(0, 12);
  const mk = await call('POST', '/api/admin/terms', { token: ADM, body: {
    code: CODE, name: 'فصل الاختبار', start_month: 3, start_day: 5, duration_days: 90, sort_order: 9 } });
  ok('إنشاء قالب فصل', mk.status === 201 && mk.data.code === CODE);
  ok('تكرار الرمز مرفوض',
    (await call('POST', '/api/admin/terms', { token: ADM, body: {
      code: CODE, name: 'مكرر', start_month: 3, start_day: 5, duration_days: 90 } })).status === 409);
  const TID = mk.data.id;

  const clamp = await call('PATCH', `/api/admin/terms/${TID}`, { token: ADM,
    body: { start_month: 99, start_day: 0, duration_days: 9999 } });
  ok('القيم خارج المدى تُردّ للقيمة القائمة',
    clamp.data.start_month === 3 && clamp.data.start_day === 5 && clamp.data.duration_days === 90);
  ok('تحرير القالب', (await call('PATCH', `/api/admin/terms/${TID}`,
    { token: ADM, body: { name: 'فصل محرَّر' } })).data.name === 'فصل محرَّر');

  /* ── مجمّع جديد يُنشأ بالقوالب لا بالفصل المكتوب في الشيفرة ── */
  const code = `tpl${stamp}`.slice(0, 12);
  const nt = await call('POST', '/api/admin/tenants', { token: ADM, body: {
    code, name: 'مجمّع القوالب', admin_name: 'مدير', email: `t${stamp}@tpl.sa`, password: 'Admin@2026' } });
  ok('إنشاء مجمّع من القوالب', nt.status === 201);
  const NT = nt.data.tenant.id;
  const terms = (await call('GET', `/api/admin/tenants/${NT}`, { token: ADM })).data?.terms;
  if (Array.isArray(terms)) {
    ok('المجمّع الجديد أخذ كل القوالب النشطة', terms.length === list.data.items.length + 1);
    ok('فصوله مرتّبة صاعدة بلا تداخل ترتيب',
      terms.slice().sort((a, b) => a.start_date < b.start_date ? -1 : 1)
        .every((t, i, arr) => i === 0 || t.start_date > arr[i - 1].start_date));
    ok('فصل جارٍ واحد لا أكثر', terms.filter(t => t.is_current).length === 1);
    ok('لا فصل بلا رمز أو تاريخ',
      terms.every(t => t.code && /^\d{4}-\d{2}-\d{2}$/.test(t.start_date) && t.end_date > t.start_date));
  } else {
    ok('المجمّع الجديد أخذ فصول القوالب', false);
  }

  /* ── الفرض على المجمّعات القائمة ── */
  const ap = await call('POST', `/api/admin/terms/${TID}/apply`, { token: ADM, body: {} });
  ok('فرض القالب على المجمّعات', ap.status === 200 && ap.data.added.length > 0);
  ok('التقرير يطابق ما نُظر فيه',
    ap.data.considered === ap.data.added.length + ap.data.skipped.length);
  const again = await call('POST', `/api/admin/terms/${TID}/apply`, { token: ADM, body: {} });
  ok('الفرض ثانيةً يتخطّى الموجود ولا يكرّره',
    again.data.added.length === 0 && again.data.skipped.length === ap.data.considered);
  ok('سبب التخطّي مذكور', again.data.skipped.every(x => !!x.reason));
  ok('الفرض المحصور يمسّ المختار وحده',
    (await call('POST', `/api/admin/terms/${TID}/apply`,
      { token: ADM, body: { tenant_ids: [NT] } })).data.considered === 1);
  ok('الفرض على قالب غير موجود يردّ ٤٠٤',
    (await call('POST', '/api/admin/terms/999999/apply', { token: ADM, body: {} })).status === 404);
  ok('الفرض يُسجَّل في سجل المنصة',
    (await call('GET', '/api/admin/logs?entity=term_template', { token: ADM })).data.items
      .some(x => x.action === 'apply'));

  /* الفصل المفروض لا يُنصَّب جارياً: نصب فصلٍ جارٍ قرار المجمّع لا المنصة */
  const t1 = (await call('GET', '/api/terms', { token: S.owner })).data;
  const forced = t1.find(t => t.code === CODE);
  ok('الفصل المفروض أُضيف للمجمّع القائم', !!forced);
  ok('الفصل المفروض لا يُنصَّب جارياً', forced ? !forced.is_current : false);
  ok('الفصل الجاري في المجمّع لم يتغيّر', t1.filter(t => t.is_current).length === 1);

  ok('حذف القالب', (await call('DELETE', `/api/admin/terms/${TID}`, { token: ADM })).status === 200);
  ok('حذف القالب لا يمسّ فصول المجمّعات',
    (await call('GET', '/api/terms', { token: S.owner })).data.some(t => t.code === CODE));
  ok('حذف قالب غير موجود يردّ ٤٠٤',
    (await call('DELETE', `/api/admin/terms/${TID}`, { token: ADM })).status === 404);

  /* ── المصدر: القوالب لا الشيفرة، والجدول الفارغ لا يعطّل ── */
  const { readFileSync } = await import('node:fs');
  const prov = readFileSync('server/core/provision.js', 'utf8');
  const tt = readFileSync('server/core/term-templates.js', 'utf8');
  ok('الإنشاء يقرأ القوالب لا فصلاً مكتوباً', prov.includes('termsForNewTenant')
    && !prov.includes("'الفصل الحالي'"));
  ok('الجدول الفارغ يرجع للسلوك القديم فلا يتعطّل الإنشاء',
    tt.includes("if (!tpls.length)") && tt.includes("'الفصل الحالي'"));
  ok('التواريخ نسبية لا مطلقة', tt.includes('start_month') && tt.includes('duration_days'));
  ok('شاشة القوالب في قائمة اللوحة',
    readFileSync('web/js/admin-shell.js', 'utf8').includes("'/admin/terms'"));
});

/* ═════════ التشغيل ═════════ */
(async () => {
  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  تدقيق منصة رقيم — ${BASE.padEnd(39)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════╝`);
  const started = Date.now();
  for (const s of sections) {
    if (only && !s.title.includes(only)) continue;
    lines.push(`\n▸ ${s.title}`);
    try { await s.fn(); }
    catch (e) { fail++; lines.push(`  ✘ انهيار القسم — ${e.message}`); }
  }
  console.log(lines.join('\n'));
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  النتيجة: ${pass} ناجح · ${fail} فاشل · ${((Date.now() - started) / 1000).toFixed(1)} ثانية`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(fail ? 1 : 0);
})();
