/**
 * تدقيق وظيفي عميق — يتحقق من سلوك كل بند في وثيقة المتطلبات فعلياً
 * لا يكتفي برموز الاستجابة بل يتحقق من صحة الحسابات والقيود والعزل.
 * يعمل على أي بيئة تشغيل (Node أو Cloudflare Workers) عبر متغير BASE.
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const only = process.env.ONLY || '';
let pass = 0, fail = 0;
const lines = [];
const S = {};

async function call(method, url, { token, body, raw, headers = {} } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: isForm ? body : (body !== undefined ? JSON.stringify(body) : undefined)
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), res };
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, res };
}
const login = (email, password) => call('POST', '/api/auth/login', { body: { email, password } });

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

  ok('الجلسة تحمل كتالوج الصلاحيات', S.s_owner.permissions.length >= 60);
  ok('مدير الجهة يملك كل الصلاحيات', S.s_owner.permissions.length === 60);
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
  ok('رفض مفتاح خاطئ', (await call('GET', '/api/v1/teachers', { token: 'noor_rq_zzz.bad' })).status === 401);

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
    const r = await call('GET', '/api/v1/branches', { token: API });
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
    `سالم التميمي,salem.${stamp}@test.sa,0501112223,teacher,B01,Noor@2026\n` +
    'بريد خاطئ,not-an-email,0501112224,teacher,B01,Noor@2026\n' +
    `دور مجهول,ok1.${stamp}@test.sa,0501112225,ghost,B01,Noor@2026\n` +
    `فرع مجهول,ok2.${stamp}@test.sa,0501112226,teacher,ZZZ,Noor@2026\n` +
    `مكرر,salem.${stamp}@test.sa,0501112227,teacher,B01,Noor@2026\n` +
    `كلمة قصيرة,ok3.${stamp}@test.sa,0501112228,teacher,B01,123\n` +
    ',,0501112229,teacher,B01,Noor@2026\n';
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
  ok('كتالوج الصلاحيات مُجمَّع حسب الوحدة', perms.list.length === 60 && Object.keys(perms.grouped).length > 10);

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
  /* ── لوحة مالك المنصة محصورة بمالكها ── */
  ok('لوحة المالك محجوبة عن المعلم',
    (await call('GET', '/api/platform/overview', { token: S.teacher })).status === 403);
  ok('لوحة المالك محجوبة عن مدير الفرع',
    (await call('GET', '/api/platform/tenants', { token: S.branch_manager })).status === 403);

  const ov = await call('GET', '/api/platform/overview', { token: S.owner });
  ok('مالك المنصة يرى لوحته', ov.status === 200 && ov.data.tenants_total >= 1);
  ok('اللوحة تحسب الإيراد الشهري المتكرر', typeof ov.data.mrr === 'number');
  ok('اللوحة تُظهر تعطُّل طبقة الـ SaaS ابتدائياً', ov.data.platform.saas_enabled === false);

  /* ── التسجيل الذاتي مغلق ما لم يُفتح ── */
  ok('التسجيل الذاتي مرفوض والطبقة معطّلة',
    (await call('POST', '/api/public/signup', { body: { code: 'ZZ1', tenant_name: 'x', admin_name: 'y',
      email: 'z@z.sa', password: 'Abcd@1234' } })).status === 403);

  const settings = await call('PUT', '/api/platform/settings', {
    token: S.owner, body: { saas_enabled: true, signup_enabled: true } });
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
  ok('الجهة الجديدة مجهّزة بأدوارها كاملة', nlog.data.permissions.length === 60);
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
  ok('الفاتورة تحمل رقماً متسلسلاً', /^NOOR-\d{4}-\d{5}$/.test(inv.number), inv.number);
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

  const pending = await call('GET', '/api/platform/payments?status=pending', { token: S.owner });
  ok('إشعار السداد يظهر لمالك المنصة', pending.data.some(p => p.reference === 'TRX-VERIFY'));
  const payId = pending.data.find(p => p.reference === 'TRX-VERIFY').id;
  const confirm = await call('POST', `/api/platform/payments/${payId}/confirm`, { token: S.owner });
  ok('اعتماد السداد يسدّد الفاتورة', confirm.status === 200 && confirm.data.invoice.status === 'paid');
  ok('لا يمكن اعتماد الإشعار مرتين',
    (await call('POST', `/api/platform/payments/${payId}/confirm`, { token: S.owner })).status === 400);
  ok('الرصيد المستحق صفر بعد السداد',
    (await call('GET', '/api/billing/invoices', { token: S.newOwner })).data.balance.due === 0);

  /* ── إيقاف التجديد واستئنافه ── */
  ok('إيقاف التجديد التلقائي',
    (await call('POST', '/api/billing/cancel', { token: S.newOwner })).data.subscription.cancel_at_period_end === true);
  ok('استئناف التجديد التلقائي',
    (await call('POST', '/api/billing/resume', { token: S.newOwner })).data.subscription.cancel_at_period_end === false);

  /* ── إيقاف الجهة إدارياً ── */
  const susp = await call('PATCH', `/api/platform/tenants/${S.newTenantId}`, {
    token: S.owner, body: { status: 'suspended', suspend_reason: 'تدقيق' } });
  ok('إيقاف الجهة من لوحة المالك', susp.status === 200 && susp.data.status === 'suspended');
  const blocked = await call('POST', '/api/tasks', { token: S.newOwner, body: { title: 'مهمة أثناء الإيقاف' } });
  ok('الجهة الموقوفة لا تستطيع الكتابة',
    blocked.status === 402 && blocked.data.error.code === 'SUBSCRIPTION_INACTIVE', JSON.stringify(blocked.data));
  ok('الجهة الموقوفة تبقى قادرة على القراءة',
    (await call('GET', '/api/tasks', { token: S.newOwner })).status === 200);
  ok('الجهة الموقوفة تصل لشاشة السداد',
    (await call('GET', '/api/billing', { token: S.newOwner })).status === 200);
  ok('لا يمكن إيقاف الجهة رقم ١',
    (await call('PATCH', '/api/platform/tenants/1', { token: S.owner, body: { status: 'suspended' } })).status === 400);
  ok('إعادة تفعيل الجهة',
    (await call('PATCH', `/api/platform/tenants/${S.newTenantId}`, { token: S.owner, body: { status: 'active' } })).data.status === 'active');
  ok('الكتابة تعود بعد التفعيل',
    (await call('POST', '/api/tasks', { token: S.newOwner, body: { title: 'مهمة بعد التفعيل' } })).status === 201);

  /* ── إدارة الخطط ── */
  const newPlan = await call('POST', '/api/platform/plans', { token: S.owner, body: {
    code: 'verify-plan', name: 'خطة التدقيق', price_monthly: 99, price_yearly: 990,
    max_branches: 2, max_users: 20, max_storage_mb: 1024, is_public: false,
    perks: ['ميزة أولى', 'ميزة ثانية'] } });
  ok('إنشاء خطة جديدة', newPlan.status === 201);
  ok('الخطة غير المعروضة لا تظهر للعموم',
    !(await call('GET', '/api/public/plans')).data.plans.some(p => p.code === 'verify-plan'));
  ok('تحرير الخطة',
    (await call('PATCH', `/api/platform/plans/${newPlan.data.id}`, { token: S.owner, body: { price_monthly: 149 } })).data.price_monthly === 149);
  ok('رفض تكرار رمز الخطة',
    (await call('POST', '/api/platform/plans', { token: S.owner, body: { code: 'verify-plan', name: 'x' } })).status === 409);
  ok('حذف خطة بلا مشتركين',
    (await call('DELETE', `/api/platform/plans/${newPlan.data.id}`, { token: S.owner })).status === 200);
  const growthPlan = (await call('GET', '/api/platform/plans', { token: S.owner })).data.find(p => p.code === 'growth');
  ok('منع حذف خطة مرتبطة بجهات',
    (await call('DELETE', `/api/platform/plans/${growthPlan.id}`, { token: S.owner })).status === 409);

  /* ── الدخول الإداري للمساندة ── */
  const imp = await call('POST', `/api/platform/tenants/${S.newTenantId}/impersonate`, { token: S.owner });
  ok('الدخول الإداري يصدر جلسة للجهة', imp.status === 200 && !!imp.accessToken === false && !!imp.data.accessToken);
  const impSession = await call('GET', '/api/auth/me', { token: imp.data.accessToken });
  ok('جلسة المساندة داخل نطاق الجهة المستهدفة', impSession.data.tenant.id === S.newTenantId);
  ok('الدخول الإداري مسجَّل في سجل الجهة',
    (await call('GET', '/api/audit', { token: imp.data.accessToken })).data.items
      .some(a => String(a.summary).includes('دخول إداري')));

  /* ── سجل المنصة مقفل ── */
  const logs = await call('GET', '/api/platform/logs', { token: S.owner });
  ok('سجل المنصة يسجّل عمليات المالك', logs.data.total > 0);
  ok('السجل يوثّق الإيقاف والتفعيل',
    logs.data.items.some(l => l.action === 'suspend') && logs.data.items.some(l => l.action === 'resume'));
  ok('السجل يوثّق الدخول الإداري', logs.data.items.some(l => l.action === 'impersonate'));
  ok('سجل المنصة محجوب عن غير المالك',
    (await call('GET', '/api/platform/logs', { token: S.newOwner })).status === 403);

  /* ── طلبات التسجيل بالمراجعة اليدوية ── */
  await call('PUT', '/api/platform/settings', { token: S.owner, body: { signup_needs_review: true } });
  const review = await call('POST', '/api/public/signup', { body: {
    code: 'R' + stamp, tenant_name: 'جهة بانتظار المراجعة', admin_name: 'مدير',
    email: `review${stamp}@verify.sa`, password: 'Verify@2026', plan_code: 'starter' } });
  ok('طلب التسجيل ينتظر المراجعة', review.status === 201 && review.data.status === 'pending_review');
  ok('الجهة لا تُنشأ قبل الاعتماد',
    (await login(`review${stamp}@verify.sa`, 'Verify@2026')).status === 401);
  const reqs = await call('GET', '/api/platform/signups?status=pending', { token: S.owner });
  ok('الطلب يظهر لمالك المنصة', reqs.data.some(r => r.id === review.data.request_id));
  const approved = await call('POST', `/api/platform/signups/${review.data.request_id}/approve`, { token: S.owner });
  ok('اعتماد الطلب يجهّز الجهة', approved.status === 201 && !!approved.data.tenant.id);
  ok('الجهة المعتمَدة تستطيع الدخول',
    (await login(`review${stamp}@verify.sa`, 'Verify@2026')).status === 200);
  await call('PUT', '/api/platform/settings', { token: S.owner, body: { signup_needs_review: false } });

  /* ── مالكو المنصة ── */
  const admins = await call('GET', '/api/platform/admins', { token: S.owner });
  ok('قائمة مالكي المنصة', admins.data.length >= 1);
  ok('لا يمكن سحب صلاحية المالك الوحيد',
    (await call('DELETE', `/api/platform/admins/${S.u_owner.id}`, { token: S.owner })).status === 400);

  /* ── دورة الاشتراكات: انتهاء التجربة ← فاتورة ← مهلة ← إيقاف الكتابة ── */
  await call('PUT', '/api/platform/settings', { token: S.owner, body: { grace_days: 0 } });
  const LC = 'L' + stamp;
  const LMAIL = `cycle${stamp}@verify.sa`;
  const lifeTenant = await call('POST', '/api/platform/tenants', { token: S.owner, body: {
    code: LC, name: 'جهة دورة الاشتراك', admin_name: 'مدير الدورة', email: LMAIL,
    password: 'Verify@2026', plan_code: 'growth', cycle: 'monthly' } });
  ok('إنشاء جهة من لوحة المالك', lifeTenant.status === 201);
  const LT = lifeTenant.data.tenant.id;
  const lifeOwner = (await login(LMAIL, 'Verify@2026')).data.accessToken;

  /* تجربة تنتهي اليوم — سيناريو إداري مشروع، لا باب خلفي */
  await call('POST', `/api/platform/tenants/${LT}/plan`, {
    token: S.owner, body: { plan_code: 'growth', cycle: 'monthly', status: 'trialing', trial_days: 0 } });
  ok('التجربة المنتهية اليوم قبل التشغيل',
    (await call('GET', '/api/billing', { token: lifeOwner })).data.subscription.status === 'trialing');

  const cycle1 = await call('POST', '/api/platform/jobs/subscriptions/run', { token: S.owner });
  ok('تشغيل دورة الاشتراكات يدوياً', cycle1.status === 200);
  ok('الدورة حوّلت التجربة المنتهية', cycle1.data.result.trials.converted >= 1, JSON.stringify(cycle1.data.result));

  const afterTrial = (await call('GET', '/api/billing', { token: lifeOwner })).data;
  ok('انتهاء التجربة يحوّل الاشتراك لمتأخر السداد', afterTrial.subscription.status === 'past_due');
  ok('انتهاء التجربة يُصدر فاتورة تلقائياً', afterTrial.balance.invoices === 1 && afterTrial.balance.due > 0);
  ok('المنصة تبقى قابلة للكتابة داخل مهلة السداد أو تمنعها بوضوح',
    [201, 402].includes((await call('POST', '/api/tasks', { token: lifeOwner, body: { title: 'مهمة أثناء المهلة' } })).status));

  const cycle2 = await call('POST', '/api/platform/jobs/subscriptions/run', { token: S.owner });
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
  const settle = await call('POST', `/api/platform/invoices/${lateInv.id}/mark-paid`, { token: S.owner });
  ok('اعتماد السداد من لوحة المالك', settle.status === 200 && settle.data.status === 'paid');
  ok('السداد يعيد الاشتراك للعمل',
    (await call('GET', '/api/billing', { token: lifeOwner })).data.subscription.status === 'active');
  ok('الكتابة تعود بعد السداد',
    (await call('POST', '/api/tasks', { token: lifeOwner, body: { title: 'مهمة بعد السداد' } })).status === 201);

  ok('إلغاء فاتورة مسددة ممنوع',
    (await call('POST', `/api/platform/invoices/${lateInv.id}/void`, { token: S.owner })).status === 400);
  await call('PUT', '/api/platform/settings', { token: S.owner, body: { grace_days: 7 } });
  await call('DELETE', `/api/platform/tenants/${LT}?confirm=${LC}`, { token: S.owner });

  /* ── محو جهة بالكامل ── */
  ok('المحو يتطلّب تأكيد الرمز',
    (await call('DELETE', `/api/platform/tenants/${S.newTenantId}`, { token: S.owner })).status === 400);
  const purge = await call('DELETE', `/api/platform/tenants/${S.newTenantId}?confirm=${CODE}`, { token: S.owner });
  ok('محو الجهة ينجح بالتأكيد الصحيح', purge.status === 200 && purge.data.purged.users >= 1);
  ok('المحو يشمل سجل تدقيق الجهة', purge.data.purged.audit_logs > 0);
  ok('الجهة الممحوّة لم تعد موجودة',
    (await call('GET', `/api/platform/tenants/${S.newTenantId}`, { token: S.owner })).status === 404);
  ok('مستخدمو الجهة الممحوّة لم يعودوا يدخلون', (await login(MAIL, 'Verify@2026')).status === 401);
  ok('أثر المحو محفوظ في سجل المنصة',
    (await call('GET', '/api/platform/logs', { token: S.owner })).data.items
      .some(l => l.action === 'delete' && l.entity === 'tenant'));
  ok('لا يمكن محو الجهة رقم ١',
    (await call('DELETE', '/api/platform/tenants/1?confirm=RQ', { token: S.owner })).status === 400);

  /* ── سجل التدقيق يبقى مقفلاً بعد كل ذلك ── */
  ok('سجل تدقيق الجهة الأولى ما زال محمياً',
    (await call('GET', '/api/audit', { token: S.owner })).data.total > 0);

  /* ── إعادة الطبقة إلى وضع المرحلة الأولى ── */
  const off = await call('PUT', '/api/platform/settings', {
    token: S.owner, body: { saas_enabled: false, signup_enabled: false } });
  ok('إمكان إعادة المنصة لوضع المستأجر الواحد', off.data.saas_enabled === 0);
  ok('التسجيل الذاتي يُغلق فوراً',
    (await call('POST', '/api/public/signup', { body: { code: 'ZZ9', tenant_name: 'x', admin_name: 'y',
      email: 'zz9@z.sa', password: 'Abcd@1234' } })).status === 403);
});

/* ═════════ التشغيل ═════════ */
(async () => {
  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  تدقيق منصة نور — ${BASE.padEnd(39)}║`);
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
