import { nowUTC } from './sql.js';
import { hashPassword } from './crypto.js';
import { PERMISSIONS, DEFAULT_ROLES } from './permissions.js';
import { seedSaaS } from './seed-saas.js';

/**
 * تعبئة البيانات التجريبية للمستأجر رقم ١ — تعمل على Node و D1 بالشيفرة نفسها.
 */
const iso = (d) => d.toISOString();
const dayStr = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

export async function seed(app, { force = false } = {}) {
  const db = app.db;
  const TODAY = new Date();

  /* ── كتالوج الصلاحيات ── */
  await db.batch(PERMISSIONS.map(p => [
    `INSERT INTO permissions(key,module,name) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET module=excluded.module, name=excluded.name`, [p.key, p.module, p.name]]));

  /* ── الجهة التعليمية (المستأجر رقم ١) ── */
  let tenant = await db.get('SELECT id FROM tenants WHERE code=?', 'RQ');
  if (!tenant) {
    const r = await db.run(
      `INSERT INTO tenants(code,name,name_en,primary_color,accent_color,timezone,locale,calendar_default,plan,settings)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      'RQ', 'مجمّع الرياض لتحفيظ القرآن الكريم', 'Riyadh Quran Complex',
      '#0F5132', '#C9A227', 'Asia/Riyadh', 'ar', 'hijri', 'phase1',
      JSON.stringify({ workday: { start: '07:30', end: '13:30', days: [0, 1, 2, 3, 4] },
        late_after_minutes: 15, absence_deduction_per_day: 1, ticket_sla_hours: 24, vat_rate: 15 }));
    tenant = { id: r.lastId };
  }
  const T = tenant.id;

  const already = await db.get('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?', T);
  if (already.c > 0 && !force) {
    /* قاعدة معبّأة مسبقاً: نكتفي بتحديث طبقة الـ SaaS فهي عمليات تكرارية آمنة */
    await seedSaaS(app, { tenantOneOwnerEmail: 'admin@riyadh-qu.sa' });
    return null;
  }

  /* ── الأدوار والصلاحيات ── */
  const roles = {};
  for (const r of DEFAULT_ROLES) {
    await db.run(`INSERT INTO roles(tenant_id,key,name,description,level,is_system) VALUES(?,?,?,?,?,?)
      ON CONFLICT(tenant_id,key) DO UPDATE SET name=excluded.name`,
      T, r.key, r.name, r.description, r.level, r.is_system);
    const row = await db.get('SELECT id FROM roles WHERE tenant_id=? AND key=?', T, r.key);
    roles[r.key] = row.id;
    await db.batch(r.permissions.map(p =>
      ['INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission_key) VALUES(?,?,?)', [T, row.id, p]]));
  }

  /* ── الفروع ── */
  const branchRows = [
    ['B01', 'الفرع الرئيسي — حي الملقا', 'طريق الملك عبدالعزيز، حي الملقا، الرياض', 24.8247, 46.6216, 80, '0112345678'],
    ['B02', 'فرع النرجس', 'حي النرجس، شمال الرياض', 24.8570, 46.6412, 60, '0112345679'],
    ['B03', 'فرع الشفا', 'حي الشفا، جنوب الرياض', 24.5701, 46.7180, 60, '0112345680'],
    ['B04', 'فرع النسيم (نسائي)', 'حي النسيم الشرقي، الرياض', 24.7420, 46.8230, 60, '0112345681']
  ];
  const branches = {};
  for (const b of branchRows) {
    await db.run(`INSERT INTO branches(tenant_id,code,name,address,lat,lng,geofence_radius,phone) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name`, T, ...b);
    branches[b[0]] = (await db.get('SELECT id FROM branches WHERE tenant_id=? AND code=?', T, b[0])).id;
  }

  /* ── الفصول الدراسية ── */
  const termRows = [
    ['T-1446-1', 'الفصل الأول ١٤٤٦هـ', dayStr(addDays(TODAY, -250)), dayStr(addDays(TODAY, -120)), 0],
    ['T-1446-2', 'الفصل الثاني ١٤٤٦هـ', dayStr(addDays(TODAY, -60)), dayStr(addDays(TODAY, 90)), 1]
  ];
  const terms = {};
  for (const t of termRows) {
    await db.run(`INSERT INTO terms(tenant_id,code,name,start_date,end_date,status,is_current) VALUES(?,?,?,?,?,'open',?)
      ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name`, T, ...t);
    terms[t[0]] = (await db.get('SELECT id FROM terms WHERE tenant_id=? AND code=?', T, t[0])).id;
  }
  const PREV = terms['T-1446-1'], CUR = terms['T-1446-2'];

  /* ── المستخدمون ── */
  const people = [
    ['مدير المجمّع — عبدالله الشهري', 'admin@riyadh-qu.sa', 'owner', 'B01', ['B01', 'B02', 'B03', 'B04'], 'Admin@123'],
    ['مدير الفرع الرئيسي — سعد القحطاني', 'branch1@riyadh-qu.sa', 'branch_manager', 'B01', ['B01', 'B02'], 'Branch@123'],
    ['مدير فرع الشفا — ماجد العتيبي', 'branch3@riyadh-qu.sa', 'branch_manager', 'B03', ['B03'], 'Branch@123'],
    ['المشرف التربوي — خالد الدوسري', 'supervisor@riyadh-qu.sa', 'supervisor', 'B01', ['B01', 'B02'], 'Super@123'],
    ['المحاسب — فهد المطيري', 'finance@riyadh-qu.sa', 'finance', 'B01', ['B01', 'B02', 'B03', 'B04'], 'Finance@123'],
    ['الموارد البشرية — نورة السالم', 'hr@riyadh-qu.sa', 'hr', 'B01', ['B01', 'B02', 'B03', 'B04'], 'Hr@123456'],
    ['رئيس لجنة الاختبارات — يوسف الحربي', 'committee@riyadh-qu.sa', 'committee_lead', 'B01', ['B01'], 'Lead@123'],
    ['المعلم — محمد العنزي', 'teacher@riyadh-qu.sa', 'teacher', 'B01', ['B01'], 'Teach@123'],
    ['المعلم — إبراهيم الزهراني', 'teacher2@riyadh-qu.sa', 'teacher', 'B02', ['B02'], 'Teach@123'],
    ['المعلمة — هيا الرشيد', 'teacher3@riyadh-qu.sa', 'teacher', 'B04', ['B04'], 'Teach@123'],
    ['موظف الاستقبال — تركي الغامدي', 'employee@riyadh-qu.sa', 'employee', 'B01', ['B01'], 'Emp@1234'],
    ['الدعم الفني — أنس البقمي', 'support@riyadh-qu.sa', 'support', 'B01', ['B01', 'B02', 'B03', 'B04'], 'Support@123'],
    ['المدقق الداخلي — صالح الأحمدي', 'auditor@riyadh-qu.sa', 'auditor', 'B01', ['B01', 'B02', 'B03', 'B04'], 'Audit@123']
  ];
  const users = {};
  for (const [i, [name, email, roleKey, primary, list, pw]] of people.entries()) {
    await db.run(
      `INSERT INTO users(tenant_id,name,email,phone,password_hash,role_id,primary_branch_id,status,calendar_pref)
       VALUES(?,?,?,?,?,?,?,'active','hijri') ON CONFLICT(tenant_id,email) DO UPDATE SET name=excluded.name`,
      T, name, email, '05' + String(50000000 + i * 111111), await hashPassword(pw), roles[roleKey], branches[primary]);
    const u = await db.get('SELECT id FROM users WHERE tenant_id=? AND email=?', T, email);
    users[email] = u.id;
    await db.batch(list.map(b => ['INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)', [T, u.id, branches[b]]]));
  }
  await db.batch([
    ['UPDATE branches SET manager_user_id=? WHERE tenant_id=? AND code=?', [users['branch1@riyadh-qu.sa'], T, 'B01']],
    ['UPDATE branches SET manager_user_id=? WHERE tenant_id=? AND code=?', [users['branch3@riyadh-qu.sa'], T, 'B03']]
  ]);

  /* ── ملفات الموظفين ── */
  const empRows = [
    ['admin@riyadh-qu.sa', 'EMP-001', 'مدير عام', 'الإدارة العليا', 'B01', 22000, 4000],
    ['branch1@riyadh-qu.sa', 'EMP-002', 'مدير فرع', 'الإدارة', 'B01', 15000, 2500],
    ['branch3@riyadh-qu.sa', 'EMP-003', 'مدير فرع', 'الإدارة', 'B03', 14000, 2500],
    ['supervisor@riyadh-qu.sa', 'EMP-004', 'مشرف تربوي', 'الإشراف', 'B01', 12000, 2000],
    ['finance@riyadh-qu.sa', 'EMP-005', 'محاسب أول', 'المالية', 'B01', 11000, 1800],
    ['hr@riyadh-qu.sa', 'EMP-006', 'أخصائي موارد بشرية', 'الموارد البشرية', 'B01', 10500, 1800],
    ['committee@riyadh-qu.sa', 'EMP-007', 'رئيس لجنة', 'اللجان', 'B01', 9500, 1500],
    ['teacher@riyadh-qu.sa', 'EMP-008', 'معلم تحفيظ', 'التعليم', 'B01', 8000, 1200],
    ['teacher2@riyadh-qu.sa', 'EMP-009', 'معلم تحفيظ', 'التعليم', 'B02', 8000, 1200],
    ['teacher3@riyadh-qu.sa', 'EMP-010', 'معلمة تحفيظ', 'التعليم', 'B04', 8000, 1200],
    ['employee@riyadh-qu.sa', 'EMP-011', 'موظف استقبال', 'الإدارة', 'B01', 6000, 900],
    ['support@riyadh-qu.sa', 'EMP-012', 'أخصائي دعم فني', 'تقنية المعلومات', 'B01', 9000, 1400],
    ['auditor@riyadh-qu.sa', 'EMP-013', 'مدقق داخلي', 'الرقابة', 'B01', 10000, 1600]
  ];
  await db.batch(empRows.map(([email, no, title, dept, br, basic, allow], i) => [
    `INSERT INTO employees(tenant_id,branch_id,user_id,employee_no,job_title,department,hire_date,basic_salary,allowances,bank_iban)
     VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET job_title=excluded.job_title`,
    [T, branches[br], users[email], no, title, dept, dayStr(addDays(TODAY, -(400 + i * 30))), basic, allow, 'SA' + (4400000000000000000 + i)]]));

  /* ── اللجان ── */
  const comRows = [
    ['اللجنة التعليمية', 'متابعة الخطط الدراسية وجودة التحفيظ', 'B01', 'supervisor@riyadh-qu.sa', '#0F5132'],
    ['لجنة الاختبارات', 'إعداد وتنفيذ اختبارات نهاية الفصل', 'B01', 'committee@riyadh-qu.sa', '#C9A227'],
    ['اللجنة المالية', 'مراجعة الميزانيات والمصروفات', 'B01', 'finance@riyadh-qu.sa', '#1D4ED8'],
    ['لجنة الأنشطة', 'المسابقات والبرامج الإثرائية', 'B02', 'branch1@riyadh-qu.sa', '#9333EA'],
    ['لجنة السلامة', 'سلامة المباني وخطط الإخلاء', 'B03', 'branch3@riyadh-qu.sa', '#DC2626']
  ];
  const committees = [];
  for (const [name, desc, br, lead, color] of comRows) {
    const r = await db.run('INSERT INTO committees(tenant_id,branch_id,term_id,name,description,lead_user_id,color) VALUES(?,?,?,?,?,?,?)',
      T, branches[br], CUR, name, desc, users[lead], color);
    committees.push(r.lastId);
    await db.batch([
      ['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)', [T, r.lastId, users[lead], 'رئيس اللجنة']],
      ['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)', [T, r.lastId, users['teacher@riyadh-qu.sa'], 'عضو']],
      ['INSERT OR IGNORE INTO committee_members(tenant_id,committee_id,user_id,role_in) VALUES(?,?,?,?)', [T, r.lastId, users['employee@riyadh-qu.sa'], 'عضو']]
    ]);
  }

  /* ── قوالب المهام ── */
  const templates = [
    ['قالب لجنة الاختبارات', 'المهام النمطية لتجهيز اختبارات نهاية الفصل', 'الاختبارات', [
      { title: 'اعتماد جدول الاختبارات', offset_days: 0, duration_days: 3, priority: 'high', weight: 3 },
      { title: 'طباعة كراسات الأسئلة', offset_days: 3, duration_days: 4, priority: 'high', weight: 2 },
      { title: 'توزيع لجان المراقبة', offset_days: 5, duration_days: 2, priority: 'medium', weight: 2 },
      { title: 'رصد النتائج في المنصة', offset_days: 10, duration_days: 5, priority: 'urgent', weight: 3 },
      { title: 'رفع تقرير نتائج الفصل', offset_days: 16, duration_days: 3, priority: 'high', weight: 3 }]],
    ['قالب بداية الفصل الدراسي', 'تجهيزات انطلاق الفصل', 'عام', [
      { title: 'تحديث بيانات الطلاب والحلقات', offset_days: 0, duration_days: 5, priority: 'high', weight: 3 },
      { title: 'توزيع المعلمين على الحلقات', offset_days: 2, duration_days: 3, priority: 'high', weight: 3 },
      { title: 'تجهيز المصاحف والوسائل', offset_days: 3, duration_days: 4, priority: 'medium', weight: 2 },
      { title: 'اجتماع تعريفي لأولياء الأمور', offset_days: 7, duration_days: 1, priority: 'medium', weight: 1 }]],
    ['قالب الجرد المالي', 'إجراءات إقفال العهد والجرد', 'مالي', [
      { title: 'حصر العهد لدى الموظفين', offset_days: 0, duration_days: 5, priority: 'high', weight: 3 },
      { title: 'مطابقة الفواتير مع المصروفات', offset_days: 5, duration_days: 5, priority: 'urgent', weight: 3 },
      { title: 'إعداد تقرير الجرد النهائي', offset_days: 10, duration_days: 4, priority: 'high', weight: 3 }]]
  ];
  await db.batch(templates.map(([name, desc, cat, items]) =>
    ['INSERT INTO task_templates(tenant_id,name,description,category,items,created_by) VALUES(?,?,?,?,?,?)',
      [T, name, desc, cat, JSON.stringify(items), users['admin@riyadh-qu.sa']]]));

  /* ── المهام ── */
  const titles = [
    'اعتماد خطة الحلقات للفصل الحالي', 'مراجعة تقارير المعلمين الأسبوعية',
    'تجهيز قاعة الاختبارات الرئيسية', 'حصر احتياج الفرع من المصاحف',
    'رفع تقرير الحضور الشهري', 'متابعة صيانة أجهزة التكييف',
    'إعداد كشف حوافز المتميزين', 'تحديث بيانات أولياء الأمور',
    'تنفيذ مسابقة الحفظ الشهرية', 'مراجعة عقود المعلمين المنتهية',
    'تدقيق فواتير القرطاسية', 'إعداد خطة الإخلاء التدريبية',
    'رصد نتائج المستوى الأول', 'توثيق محاضر اجتماعات اللجنة',
    'إغلاق عهدة الفرع للفصل السابق', 'تفعيل حساب المعلمين الجدد'
  ];
  const statuses = ['todo', 'in_progress', 'review', 'done', 'blocked'];
  const assignees = Object.values(users);
  const brCycle = ['B01', 'B01', 'B02', 'B03', 'B01'];
  const TASK_SQL = `INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,status,priority,assignee_id,created_by,start_date,due_date,completed_at,progress,weight,order_index)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const taskIds = [];
  for (const [i, title] of titles.entries()) {
    const st = statuses[i % statuses.length];
    const start = addDays(TODAY, -30 + i * 3);
    const due = addDays(start, 5 + (i % 8));
    const r = await db.run(TASK_SQL, T, branches[brCycle[i % 5]], CUR, committees[i % committees.length], title,
      'مهمة ضمن خطة اللجنة للفصل الدراسي الحالي. يرجى تحديث نسبة الإنجاز أولاً بأول.',
      st, ['low', 'medium', 'high', 'urgent'][i % 4], assignees[i % assignees.length], users['admin@riyadh-qu.sa'],
      dayStr(start), dayStr(due), st === 'done' ? iso(due) : null,
      st === 'done' ? 100 : st === 'review' ? 80 : st === 'in_progress' ? 45 : 0, 1 + (i % 3), i);
    taskIds.push(r.lastId);
  }
  await db.batch([
    ['INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)', [T, taskIds[2], taskIds[0], 'FS']],
    ['INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)', [T, taskIds[3], taskIds[1], 'FS']],
    ['INSERT OR IGNORE INTO task_dependencies(tenant_id,task_id,depends_on_id,type) VALUES(?,?,?,?)', [T, taskIds[12], taskIds[2], 'FS']]
  ]);
  await db.batch(Array.from({ length: 6 }, (_, i) => [TASK_SQL, [
    T, branches.B01, PREV, committees[0], `[الفصل السابق] ${titles[i]}`, 'سجل مؤرشف للفصل المنصرم.',
    'done', 'medium', assignees[i % assignees.length], users['admin@riyadh-qu.sa'],
    dayStr(addDays(TODAY, -200)), dayStr(addDays(TODAY, -190)), iso(addDays(TODAY, -190)), 100, 1, i]]));

  /* ── الحضور ── */
  const staff = ['teacher@riyadh-qu.sa', 'teacher2@riyadh-qu.sa', 'employee@riyadh-qu.sa', 'supervisor@riyadh-qu.sa', 'finance@riyadh-qu.sa'];
  const ATT_SQL = `INSERT OR IGNORE INTO attendance(tenant_id,branch_id,term_id,user_id,date,check_in_at,check_out_at,in_lat,in_lng,in_distance,status,minutes_worked)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
  const attStmts = [];
  for (let d = 20; d >= 1; d--) {
    const date = addDays(TODAY, -d);
    if ([5, 6].includes(date.getDay())) continue;
    staff.forEach((email, k) => {
      const roll = (d + k) % 10;
      if (roll === 0) return attStmts.push([ATT_SQL, [T, branches.B01, CUR, users[email], dayStr(date), null, null, null, null, null, 'absent', 0]]);
      if (roll === 1) return attStmts.push([ATT_SQL, [T, branches.B01, CUR, users[email], dayStr(date), null, null, null, null, null, 'leave', 0]]);
      const late = roll === 2;
      const inAt = new Date(date); inAt.setUTCHours(4, late ? 45 : 25, 0, 0);
      const outAt = new Date(date); outAt.setUTCHours(10, 35, 0, 0);
      attStmts.push([ATT_SQL, [T, branches.B01, CUR, users[email], dayStr(date), iso(inAt), iso(outAt),
        24.8247 + (Math.random() - 0.5) * 0.0004, 46.6216 + (Math.random() - 0.5) * 0.0004,
        Math.round(Math.random() * 40), late ? 'late' : 'present', Math.round((outAt - inAt) / 60000)]]);
    });
  }
  for (let i = 0; i < attStmts.length; i += 50) await db.batch(attStmts.slice(i, i + 50));

  /* ── المالية ── */
  const stepsStd = JSON.stringify([
    { name: 'اعتماد المشرف', role_key: 'supervisor', permission: 'finance.approve_supervisor' },
    { name: 'الاعتماد المالي', role_key: 'finance', permission: 'finance.approve_finance' }]);
  const stepsBig = JSON.stringify([
    { name: 'اعتماد المشرف', role_key: 'supervisor', permission: 'finance.approve_supervisor' },
    { name: 'الاعتماد المالي', role_key: 'finance', permission: 'finance.approve_finance' },
    { name: 'اعتماد مدير الجهة', role_key: 'owner', permission: 'finance.manage' }]);
  const w1 = (await db.run('INSERT INTO workflows(tenant_id,name,doc_type,steps,is_active) VALUES(?,?,?,?,1)', T, 'مسار المصروفات الاعتيادية', 'expense', stepsStd)).lastId;
  const w2 = (await db.run('INSERT INTO workflows(tenant_id,name,doc_type,steps,is_active) VALUES(?,?,?,?,1)', T, 'مسار العهد المالية', 'custody', stepsStd)).lastId;
  await db.run('INSERT INTO workflows(tenant_id,name,doc_type,steps,is_active) VALUES(?,?,?,?,1)', T, 'مسار المشتريات الكبرى (فوق ٢٠٬٠٠٠)', 'purchase', stepsBig);

  const b1 = (await db.run('INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount,spent) VALUES(?,?,?,?,?,?,?)',
    T, branches.B01, CUR, 'ميزانية التشغيل — الفرع الرئيسي', 'تشغيل', 250000, 48750)).lastId;
  await db.batch([
    ['INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount,spent) VALUES(?,?,?,?,?,?,?)', [T, branches.B02, CUR, 'ميزانية الأنشطة — فرع النرجس', 'أنشطة', 80000, 12300]],
    ['INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount,spent) VALUES(?,?,?,?,?,?,?)', [T, branches.B03, CUR, 'ميزانية الصيانة — فرع الشفا', 'صيانة', 60000, 25400]]
  ]);

  const reqs = [
    ['شراء ٢٠٠ مصحف للفرع الرئيسي', 'expense', 18500, 'employee@riyadh-qu.sa', 2, 'approved'],
    ['عهدة قرطاسية لجنة الاختبارات', 'custody', 4200, 'committee@riyadh-qu.sa', 1, 'in_review'],
    ['صيانة مكيفات القاعة الكبرى', 'expense', 12750, 'branch1@riyadh-qu.sa', 0, 'pending'],
    ['حوافز المعلمين المتميزين', 'expense', 26000, 'supervisor@riyadh-qu.sa', 1, 'in_review'],
    ['تعويض مصاريف مسابقة الحفظ', 'reimbursement', 3100, 'teacher@riyadh-qu.sa', 0, 'pending'],
    ['طباعة كراسات الاختبار', 'purchase', 9800, 'committee@riyadh-qu.sa', 2, 'approved'],
    ['شراء أجهزة حاسب للإدارة', 'purchase', 31000, 'branch1@riyadh-qu.sa', 0, 'rejected']
  ];
  const reqIds = [];
  for (const [i, [title, type, amount, requester, step, st]] of reqs.entries()) {
    const r = await db.run(
      `INSERT INTO finance_requests(tenant_id,branch_id,term_id,number,type,title,description,amount,requester_id,workflow_id,budget_id,current_step,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      T, branches.B01, CUR, `FR-${1001 + i}`, type, title,
      'طلب مالي مرفوع عبر المنصة ضمن دورة الاعتمادات المعتمدة.', amount, users[requester],
      type === 'custody' ? w2 : w1, b1, step, st);
    reqIds.push(r.lastId);
    const AP = `INSERT INTO finance_approvals(tenant_id,request_id,step_index,step_name,role_key,approver_id,action,note,acted_at) VALUES(?,?,?,?,?,?,?,?,?)`;
    const rows = [];
    if (step >= 1) rows.push([AP, [T, r.lastId, 0, 'اعتماد المشرف', 'supervisor', users['supervisor@riyadh-qu.sa'], 'approve', 'مطابق للخطة', iso(addDays(TODAY, -5))]]);
    if (step >= 2) rows.push([AP, [T, r.lastId, 1, 'الاعتماد المالي', 'finance', users['finance@riyadh-qu.sa'], 'approve', 'يوجد رصيد كافٍ في الميزانية', iso(addDays(TODAY, -3))]]);
    if (st === 'rejected') rows.push([AP, [T, r.lastId, 0, 'اعتماد المشرف', 'supervisor', users['supervisor@riyadh-qu.sa'], 'reject', 'يُرجى إعادة التسعير من ثلاثة موردين', iso(addDays(TODAY, -2))]]);
    if (rows.length) await db.batch(rows);
  }
  const INV = `INSERT INTO invoices(tenant_id,branch_id,term_id,request_id,number,vendor,amount,vat,total,date,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
  await db.batch([
    [INV, [T, branches.B01, CUR, reqIds[0], 'INV-2201', 'دار الرشد للنشر', 16086.96, 2413.04, 18500, dayStr(addDays(TODAY, -6)), 'recorded', users['finance@riyadh-qu.sa']]],
    [INV, [T, branches.B01, CUR, reqIds[5], 'INV-2202', 'مطابع الرياض', 8521.74, 1278.26, 9800, dayStr(addDays(TODAY, -4)), 'recorded', users['finance@riyadh-qu.sa']]]
  ]);

  /* ── النماذج والتقييم ── */
  const evalSchema = { fields: [
    { id: 'f1', type: 'rating', label: 'الالتزام بالحضور والانضباط', max: 5, weight: 20, required: true },
    { id: 'f2', type: 'rating', label: 'جودة التلاوة والتصحيح', max: 5, weight: 25, required: true },
    { id: 'f3', type: 'rating', label: 'إدارة الحلقة والتفاعل', max: 5, weight: 25, required: true },
    { id: 'f4', type: 'rating', label: 'متابعة تقارير الطلاب', max: 5, weight: 15, required: true },
    { id: 'f5', type: 'select', label: 'التوصية', options: ['ترقية', 'استمرار', 'تدريب إضافي'], weight: 15, required: true },
    { id: 'f6', type: 'textarea', label: 'ملاحظات المشرف', required: false },
    { id: 'f7', type: 'date', label: 'تاريخ الزيارة الصفية', required: true }] };
  const surveySchema = { fields: [
    { id: 's1', type: 'text', label: 'اسم ولي الأمر', required: true },
    { id: 's2', type: 'select', label: 'الفرع', options: ['الملقا', 'النرجس', 'الشفا', 'النسيم'], required: true },
    { id: 's3', type: 'rating', label: 'رضاك عن مستوى الحلقة', max: 5, weight: 50, required: true },
    { id: 's4', type: 'rating', label: 'رضاك عن التواصل مع المعلم', max: 5, weight: 50, required: true },
    { id: 's5', type: 'textarea', label: 'مقترحاتك', required: false }] };
  const f1 = (await db.run('INSERT INTO forms(tenant_id,title,description,type,schema_json,target_role,created_by) VALUES(?,?,?,?,?,?,?)',
    T, 'نموذج تقييم أداء المعلم', 'يُعبأ من قبل المشرف التربوي في نهاية كل شهر', 'evaluation',
    JSON.stringify(evalSchema), 'teacher', users['admin@riyadh-qu.sa'])).lastId;
  await db.run('INSERT INTO forms(tenant_id,title,description,type,schema_json,target_role,created_by) VALUES(?,?,?,?,?,?,?)',
    T, 'استبانة رضا أولياء الأمور', 'استبانة فصلية لقياس رضا أولياء الأمور', 'survey',
    JSON.stringify(surveySchema), null, users['admin@riyadh-qu.sa']);

  await db.batch([['teacher@riyadh-qu.sa', 4.6], ['teacher2@riyadh-qu.sa', 4.1], ['teacher3@riyadh-qu.sa', 4.8], ['employee@riyadh-qu.sa', 3.9]]
    .map(([email, avg], i) => [
      `INSERT INTO form_submissions(tenant_id,branch_id,term_id,form_id,subject_user_id,submitted_by,answers,score,max_score,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [T, branches.B01, CUR, f1, users[email], users['supervisor@riyadh-qu.sa'],
        JSON.stringify({ f1: Math.round(avg), f2: Math.round(avg), f3: Math.round(avg), f4: Math.round(avg),
          f5: 'استمرار', f6: 'أداء جيد بشكل عام.', f7: dayStr(addDays(TODAY, -10 - i)) }),
        Number((avg * 20).toFixed(1)), 100, iso(addDays(TODAY, -10 - i))]]));

  /* ── التذاكر ── */
  const tickets = [
    ['لا يمكنني تسجيل الحضور من الجوال', 'يظهر لي خطأ "خارج النطاق" رغم وجودي داخل الفرع.', 'attendance', 'high', 'in_progress', 'teacher@riyadh-qu.sa', 'support@riyadh-qu.sa', -8, 1],
    ['طلب صلاحية عرض التقارير المالية', 'أحتاج صلاحية عرض تقارير الفرع للمراجعة الشهرية.', 'permissions', 'medium', 'open', 'branch1@riyadh-qu.sa', null, -2, 0],
    ['خطأ عند رفع صورة الفاتورة', 'الملف بصيغة HEIC ولا يتم قبوله.', 'technical', 'urgent', 'resolved', 'finance@riyadh-qu.sa', 'support@riyadh-qu.sa', -30, 1],
    ['تعديل بيانات موظف', 'تغيير رقم الآيبان لأحد المعلمين.', 'hr', 'low', 'closed', 'hr@riyadh-qu.sa', 'support@riyadh-qu.sa', -70, 1],
    ['المنصة بطيئة عند فتح مخطط جانت', 'التحميل يستغرق أكثر من ١٥ ثانية على الجوال.', 'performance', 'high', 'open', 'committee@riyadh-qu.sa', null, -40, 0]
  ];
  for (const [i, [subject, body, cat, pri, st, reqEmail, assignee, hoursAgo, escalated]] of tickets.entries()) {
    const created = new Date(TODAY.getTime() + hoursAgo * 3600000);
    const due = new Date(created.getTime() + 24 * 3600000);
    const r = await db.run(
      `INSERT INTO tickets(tenant_id,branch_id,number,subject,body,category,priority,status,requester_id,assignee_id,sla_hours,sla_due_at,first_response_at,escalated,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      T, branches.B01, `TK-${2001 + i}`, subject, body, cat, pri, st, users[reqEmail],
      assignee ? users[assignee] : null, 24, iso(due),
      assignee ? iso(new Date(created.getTime() + 3600000)) : null, escalated, iso(created));
    if (assignee) await db.run('INSERT INTO ticket_replies(tenant_id,ticket_id,user_id,body,is_internal,created_at) VALUES(?,?,?,?,?,?)',
      T, r.lastId, users[assignee], 'تم استلام التذكرة وجارٍ العمل عليها، شكراً لتواصلك.', 0, iso(new Date(created.getTime() + 3600000)));
  }

  /* ── محادثة سياقية ── */
  const conv = (await db.run('INSERT INTO conversations(tenant_id,context_type,context_id,title) VALUES(?,?,?,?)',
    T, 'task', taskIds[0], 'اعتماد خطة الحلقات للفصل الحالي')).lastId;
  await db.batch([
    ...[users['admin@riyadh-qu.sa'], users['supervisor@riyadh-qu.sa'], users['teacher@riyadh-qu.sa']]
      .map(u => ['INSERT OR IGNORE INTO conversation_members(tenant_id,conversation_id,user_id) VALUES(?,?,?)', [T, conv, u]]),
    ['INSERT INTO messages(tenant_id,conversation_id,user_id,body,created_at) VALUES(?,?,?,?,?)', [T, conv, users['supervisor@riyadh-qu.sa'], 'تم رفع الخطة المبدئية، بانتظار ملاحظاتكم.', iso(addDays(TODAY, -3))]],
    ['INSERT INTO messages(tenant_id,conversation_id,user_id,body,created_at) VALUES(?,?,?,?,?)', [T, conv, users['admin@riyadh-qu.sa'], 'اعتمدت الخطة مع تعديل توقيت الحلقة الثالثة.', iso(addDays(TODAY, -2))]],
    ['INSERT INTO messages(tenant_id,conversation_id,user_id,body,created_at) VALUES(?,?,?,?,?)', [T, conv, users['teacher@riyadh-qu.sa'], 'تمام، سأحدّث جدول الحلقة اليوم بإذن الله.', iso(addDays(TODAY, -1))]]
  ]);

  /* ── إشعارات وسجل تدقيق ابتدائي ── */
  await db.batch([
    ['admin@riyadh-qu.sa', 'finance.pending', 'finance', 'طلب مالي بانتظار اعتمادك', 'صيانة مكيفات القاعة الكبرى — ١٢٬٧٥٠ ر.س', '/finance', 0],
    ['admin@riyadh-qu.sa', 'ticket.escalated', 'tickets', 'تصعيد تذكرة دعم', 'تجاوزت التذكرة TK-2003 مدة اتفاقية مستوى الخدمة', '/tickets', 0],
    ['teacher@riyadh-qu.sa', 'task.assigned', 'tasks', 'أُسندت إليك مهمة جديدة', 'رصد نتائج المستوى الأول — تستحق خلال ٥ أيام', '/tasks', 0],
    ['supervisor@riyadh-qu.sa', 'task.overdue', 'tasks', 'مهمة متأخرة', 'مراجعة عقود المعلمين المنتهية تجاوزت تاريخ الاستحقاق', '/tasks', 1]
  ].map(([email, type, cat, title, body, url, read], i) => [
    'INSERT INTO notifications(tenant_id,user_id,type,category,title,body,url,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [T, users[email], type, cat, title, body, url, read, iso(addDays(TODAY, -i))]]));

  const auditRows = [
    ['supervisor@riyadh-qu.sa', 'supervisor', 'update', 'task', '13', 'المشرف (خالد الدوسري) قام بتعديل حالة المهمة (رصد نتائج المستوى الأول) إلى "قيد المراجعة"'],
    ['finance@riyadh-qu.sa', 'finance', 'approve', 'finance_request', '1', 'المحاسب (فهد المطيري) اعتمد الطلب المالي FR-1001 بمبلغ ١٨٬٥٠٠ ر.س'],
    ['admin@riyadh-qu.sa', 'owner', 'create', 'user', '9', 'مدير المجمّع أنشأ حساب المعلم (إبراهيم الزهراني)'],
    ['hr@riyadh-qu.sa', 'hr', 'export', 'report', 'attendance', 'الموارد البشرية صدّرت تقرير الحضور الشهري بصيغة Excel']
  ];
  const names = Object.fromEntries((await db.all('SELECT id, name FROM users WHERE tenant_id=?', T)).map(u => [u.id, u.name]));
  await db.batch(auditRows.map(([email, role, action, entity, eid, summary], i) => [
    'INSERT INTO audit_logs(tenant_id,user_id,user_name,role_key,action,entity,entity_id,summary,ip,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [T, users[email], names[users[email]], role, action, entity, eid, summary, '10.0.0.' + (10 + i), iso(addDays(TODAY, -i))]]));

  /* ── إغلاق الفصل السابق (يفعّل مُشغّلات التجميد) ── */
  await db.run(`UPDATE terms SET status='closed', closed_at=?, closed_by=? WHERE id=? AND tenant_id=?`,
    nowUTC(), users['admin@riyadh-qu.sa'], PREV, T);

  /* ── طبقة الـ SaaS: الخطط وإعدادات المنصة ومالكها (المرحلة الثانية) ── */
  await seedSaaS(app, { tenantOneOwnerEmail: 'admin@riyadh-qu.sa' });

  return T;
}
