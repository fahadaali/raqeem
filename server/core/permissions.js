/**
 * كتالوج الصلاحيات الموحّد (RBAC) — البند ١ من الوثيقة
 * كل مستخدم يملك "دوراً" (Role) والدور يملك مجموعة "صلاحيات" (Permissions).
 * الواجهات الأمامية تقرأ هذه القائمة لإخفاء/إظهار عناصر الشاشة (الواجهة المرنة).
 */
export const PERMISSIONS = [
  ['dashboard.view',            'عام',        'عرض لوحة التحكم'],
  ['branches.view',             'الفروع',      'عرض الفروع'],
  ['branches.manage',           'الفروع',      'إدارة الفروع'],
  ['users.view',                'المستخدمون',  'عرض المستخدمين'],
  ['users.manage',              'المستخدمون',  'إدارة المستخدمين'],
  ['roles.view',                'الصلاحيات',   'عرض الأدوار'],
  ['roles.manage',              'الصلاحيات',   'إدارة الأدوار والصلاحيات'],
  ['terms.view',                'الفصول',      'عرض الفصول الدراسية'],
  ['terms.manage',              'الفصول',      'إدارة الفصول الدراسية'],
  ['terms.close',               'الفصول',      'إغلاق وترحيل الفصل'],
  ['committees.view',           'اللجان',      'عرض اللجان'],
  ['committees.manage',         'اللجان',      'إدارة اللجان'],
  ['tasks.view',                'المهام',      'عرض مهامي'],
  ['tasks.view_all',            'المهام',      'عرض جميع المهام'],
  ['tasks.create',              'المهام',      'إنشاء مهمة'],
  ['tasks.update',              'المهام',      'تعديل المهام'],
  ['tasks.delete',              'المهام',      'حذف المهام'],
  ['tasks.assign',              'المهام',      'إسناد المهام'],
  ['templates.view',            'القوالب',     'عرض قوالب المهام'],
  ['templates.manage',          'القوالب',     'إدارة قوالب المهام'],
  ['hr.attendance.self',        'الحضور',      'تسجيل حضوري وانصرافي'],
  ['hr.attendance.view',        'الحضور',      'عرض سجلات الحضور'],
  ['hr.attendance.manage',      'الحضور',      'تعديل سجلات الحضور'],
  ['hr.employees.view',         'الموظفون',    'عرض ملفات الموظفين'],
  ['hr.employees.manage',       'الموظفون',    'إدارة ملفات الموظفين'],
  ['hr.leaves.request',         'الإجازات',    'طلب إجازة'],
  ['hr.leaves.approve',         'الإجازات',    'اعتماد الإجازات'],
  ['hr.payroll.view',           'الرواتب',     'عرض مسير الرواتب'],
  ['hr.payroll.manage',         'الرواتب',     'إنشاء واعتماد مسير الرواتب'],
  ['finance.request',           'المالية',     'رفع طلب مالي'],
  ['finance.view',              'المالية',     'عرض الطلبات المالية'],
  ['finance.approve_supervisor','المالية',     'اعتماد المشرف'],
  ['finance.approve_finance',   'المالية',     'الاعتماد المالي'],
  ['finance.manage',            'المالية',     'إدارة النظام المالي'],
  ['budgets.view',              'الميزانيات',  'عرض الميزانيات'],
  ['budgets.manage',            'الميزانيات',  'إدارة الميزانيات'],
  ['invoices.view',             'الفواتير',    'عرض الفواتير'],
  ['invoices.manage',           'الفواتير',    'إدارة الفواتير'],
  ['workflows.view',            'الاعتمادات',  'عرض مسارات الاعتماد'],
  ['workflows.manage',          'الاعتمادات',  'بناء مسارات الاعتماد'],
  ['forms.view',                'النماذج',     'عرض النماذج'],
  ['forms.manage',              'النماذج',     'بناء النماذج والتقييمات'],
  ['forms.submit',              'النماذج',     'تعبئة النماذج'],
  ['forms.results',             'النماذج',     'عرض نتائج التقييم'],
  ['kpi.view',                  'المؤشرات',    'عرض مؤشراتي'],
  ['kpi.view_all',              'المؤشرات',    'عرض مؤشرات الجميع'],
  ['chat.use',                  'التواصل',     'استخدام المحادثات السياقية'],
  ['tickets.create',            'الدعم',       'رفع تذكرة دعم'],
  ['tickets.view_all',          'الدعم',       'عرض جميع التذاكر'],
  ['tickets.manage',            'الدعم',       'معالجة التذاكر'],
  ['api.keys.manage',           'التكامل',     'إدارة مفاتيح الربط'],
  ['reports.view',              'التقارير',    'عرض التقارير'],
  ['reports.export',            'التقارير',    'تصدير وطباعة التقارير'],
  ['imports.manage',            'الاستيراد',   'استيراد البيانات الأولية'],
  ['audit.view',                'التدقيق',     'عرض سجل النشاطات'],
  ['settings.view',             'الإعدادات',   'عرض الإعدادات'],
  ['settings.manage',           'الإعدادات',   'إدارة إعدادات الجهة'],
  ['notifications.broadcast',   'الإشعارات',   'إرسال إشعارات عامة']
].map(([key, module, name]) => ({ key, module, name }));

export const ALL_KEYS = PERMISSIONS.map(p => p.key);

const BASE = ['dashboard.view', 'tasks.view', 'hr.attendance.self', 'hr.leaves.request',
  'chat.use', 'tickets.create', 'kpi.view', 'forms.submit', 'settings.view'];

/** الأدوار الافتراضية لكل جهة تعليمية جديدة */
export const DEFAULT_ROLES = [
  {
    key: 'owner', name: 'مدير الجهة التعليمية', level: 1, is_system: 1,
    description: 'صلاحية عليا على كامل المجمّع وجميع الفروع',
    permissions: ALL_KEYS
  },
  {
    key: 'branch_manager', name: 'مدير فرع', level: 2, is_system: 1,
    description: 'إدارة كاملة لفرع واحد أو أكثر',
    permissions: [...BASE, 'branches.view', 'users.view', 'terms.view', 'committees.view',
      'committees.manage', 'tasks.view_all', 'tasks.create', 'tasks.update', 'tasks.delete',
      'tasks.assign', 'templates.view', 'templates.manage', 'hr.attendance.view',
      'hr.employees.view', 'hr.leaves.approve', 'finance.request', 'finance.view',
      'finance.approve_supervisor', 'budgets.view', 'invoices.view', 'workflows.view',
      'forms.view', 'forms.results', 'kpi.view_all', 'tickets.view_all', 'reports.view',
      'reports.export', 'audit.view']
  },
  {
    key: 'supervisor', name: 'مشرف', level: 3, is_system: 1,
    description: 'متابعة اللجان والمهام واعتماد الطلبات في مرحلته',
    permissions: [...BASE, 'branches.view', 'users.view', 'terms.view', 'committees.view',
      'tasks.view_all', 'tasks.create', 'tasks.update', 'tasks.assign', 'templates.view',
      'hr.attendance.view', 'hr.leaves.approve', 'finance.request', 'finance.view',
      'finance.approve_supervisor', 'forms.view', 'forms.results', 'kpi.view_all',
      'tickets.view_all', 'reports.view', 'reports.export']
  },
  {
    key: 'finance', name: 'المحاسب / المدير المالي', level: 3, is_system: 1,
    description: 'الاعتماد المالي وإدارة الفواتير والميزانيات والرواتب',
    permissions: [...BASE, 'branches.view', 'users.view', 'terms.view', 'finance.request',
      'finance.view', 'finance.approve_finance', 'finance.manage', 'budgets.view',
      'budgets.manage', 'invoices.view', 'invoices.manage', 'workflows.view',
      'hr.payroll.view', 'hr.payroll.manage', 'hr.employees.view', 'reports.view',
      'reports.export', 'imports.manage']
  },
  {
    key: 'hr', name: 'الموارد البشرية', level: 3, is_system: 1,
    description: 'ملفات الموظفين والحضور والإجازات ومسير الرواتب',
    permissions: [...BASE, 'branches.view', 'users.view', 'users.manage', 'terms.view',
      'hr.attendance.view', 'hr.attendance.manage', 'hr.employees.view',
      'hr.employees.manage', 'hr.leaves.approve', 'hr.payroll.view', 'hr.payroll.manage',
      'forms.view', 'forms.results', 'kpi.view_all', 'reports.view', 'reports.export',
      'imports.manage']
  },
  {
    key: 'committee_lead', name: 'رئيس لجنة', level: 4, is_system: 1,
    description: 'إدارة مهام لجنته ومتابعة أعضائها',
    permissions: [...BASE, 'committees.view', 'tasks.view_all', 'tasks.create',
      'tasks.update', 'tasks.assign', 'templates.view', 'forms.view', 'forms.results',
      'kpi.view_all', 'reports.view']
  },
  {
    key: 'teacher', name: 'معلم', level: 5, is_system: 1,
    description: 'تنفيذ المهام وتسجيل الحضور — لا يرى القوائم المالية',
    permissions: [...BASE, 'tasks.update']
  },
  {
    key: 'employee', name: 'موظف', level: 5, is_system: 1,
    description: 'موظف إداري — مهام وحضور وطلبات',
    permissions: [...BASE, 'tasks.update', 'finance.request']
  },
  {
    key: 'support', name: 'الدعم الفني', level: 4, is_system: 1,
    description: 'معالجة تذاكر الدعم والرد عليها',
    permissions: [...BASE, 'tickets.view_all', 'tickets.manage', 'users.view', 'branches.view']
  },
  {
    key: 'auditor', name: 'المدقق / الرقابة', level: 2, is_system: 1,
    description: 'اطّلاع فقط على كافة السجلات وسجل التدقيق',
    permissions: ['dashboard.view', 'branches.view', 'users.view', 'terms.view',
      'committees.view', 'tasks.view_all', 'finance.view', 'budgets.view', 'invoices.view',
      'workflows.view', 'forms.view', 'forms.results', 'kpi.view_all', 'hr.attendance.view',
      'hr.employees.view', 'hr.payroll.view', 'tickets.view_all', 'reports.view',
      'reports.export', 'audit.view', 'settings.view']
  }
];

export default { PERMISSIONS, ALL_KEYS, DEFAULT_ROLES };
