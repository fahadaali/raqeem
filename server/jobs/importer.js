import bcrypt from 'bcryptjs';
import db, { nowUTC } from '../db/index.js';
import { auditSystem } from '../middleware/audit.js';
import { notifyUsers } from '../lib/notify.js';

/**
 * استيراد البيانات الأولية (البند ١٢)
 * — نصوص تحقق تفحص كل حقل قبل الإدخال
 * — تقارير أخطاء مرئية تحدد رقم الصف وسبب الرفض
 * — المعالجة عبر طابور خلفي حتى لا تتجمد الواجهة
 */
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const isDate = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim());
const isNum = (v) => v === '' || v === null || v === undefined || !Number.isNaN(Number(String(v).replace(/,/g, '')));
const num = (v) => Number(String(v ?? '0').replace(/,/g, '')) || 0;

export const IMPORT_TYPES = {
  users: {
    label: 'المستخدمون والمعلمون',
    description: 'استيراد قوائم الموظفين والمعلمين وإنشاء حساباتهم وتسكينهم في فروعهم',
    columns: [
      { key: 'name', header: 'الاسم الكامل', required: true },
      { key: 'email', header: 'البريد الإلكتروني', required: true, hint: 'يجب أن يكون فريداً' },
      { key: 'phone', header: 'الجوال' },
      { key: 'role_key', header: 'الدور', required: true, hint: 'teacher / employee / supervisor / finance / hr' },
      { key: 'branch_code', header: 'رمز الفرع', required: true, hint: 'مثل B01' },
      { key: 'password', header: 'كلمة المرور المبدئية', hint: '٨ أحرف فأكثر — تُولّد آلياً إن تُركت فارغة' }
    ],
    sample: [{ name: 'محمد بن أحمد', email: 'm.ahmed@example.sa', phone: '0551234567', role_key: 'teacher', branch_code: 'B01', password: 'Noor@2026' }]
  },
  employees: {
    label: 'ملفات الموظفين والرواتب',
    description: 'استيراد المسميات الوظيفية والرواتب الأساسية والبدلات وأرقام الآيبان',
    columns: [
      { key: 'email', header: 'البريد الإلكتروني للموظف', required: true },
      { key: 'employee_no', header: 'الرقم الوظيفي' },
      { key: 'job_title', header: 'المسمى الوظيفي' },
      { key: 'department', header: 'الإدارة/القسم' },
      { key: 'hire_date', header: 'تاريخ المباشرة', hint: 'YYYY-MM-DD' },
      { key: 'basic_salary', header: 'الراتب الأساسي' },
      { key: 'allowances', header: 'البدلات' },
      { key: 'bank_iban', header: 'رقم الآيبان' }
    ],
    sample: [{ email: 'm.ahmed@example.sa', employee_no: 'EMP-120', job_title: 'معلم تحفيظ', department: 'التعليم', hire_date: '2024-09-01', basic_salary: 8000, allowances: 1200, bank_iban: 'SA0000000000000000' }]
  },
  branches: {
    label: 'الفروع',
    description: 'استيراد الفروع مع إحداثياتها ونطاق تسجيل الحضور',
    columns: [
      { key: 'code', header: 'رمز الفرع', required: true },
      { key: 'name', header: 'اسم الفرع', required: true },
      { key: 'address', header: 'العنوان' },
      { key: 'lat', header: 'خط العرض', hint: 'مثال 24.8247' },
      { key: 'lng', header: 'خط الطول', hint: 'مثال 46.6216' },
      { key: 'geofence_radius', header: 'نطاق التحضير (متر)' },
      { key: 'phone', header: 'الهاتف' }
    ],
    sample: [{ code: 'B05', name: 'فرع العليا', address: 'حي العليا', lat: 24.6944, lng: 46.6853, geofence_radius: 60, phone: '0112223334' }]
  },
  tasks: {
    label: 'المهام',
    description: 'استيراد خطة مهام جاهزة وتوزيعها على المنسوبين',
    columns: [
      { key: 'title', header: 'عنوان المهمة', required: true },
      { key: 'description', header: 'الوصف' },
      { key: 'assignee_email', header: 'بريد المكلّف' },
      { key: 'branch_code', header: 'رمز الفرع' },
      { key: 'committee_name', header: 'اسم اللجنة' },
      { key: 'priority', header: 'الأولوية', hint: 'low / medium / high / urgent' },
      { key: 'start_date', header: 'تاريخ البداية', hint: 'YYYY-MM-DD' },
      { key: 'due_date', header: 'تاريخ الاستحقاق', hint: 'YYYY-MM-DD' }
    ],
    sample: [{ title: 'جرد المصاحف', description: 'حصر شامل', assignee_email: 'm.ahmed@example.sa', branch_code: 'B01', committee_name: 'اللجنة التعليمية', priority: 'high', start_date: '2026-09-01', due_date: '2026-09-10' }]
  },
  budgets: {
    label: 'الميزانيات',
    description: 'استيراد بنود الميزانية لكل فرع',
    columns: [
      { key: 'name', header: 'اسم البند', required: true },
      { key: 'category', header: 'التصنيف' },
      { key: 'amount', header: 'المبلغ المعتمد', required: true },
      { key: 'branch_code', header: 'رمز الفرع' }
    ],
    sample: [{ name: 'ميزانية القرطاسية', category: 'تشغيل', amount: 45000, branch_code: 'B01' }]
  },
  advances: {
    label: 'العهد والسلف المالية',
    description: 'استيراد أرصدة العهد والسلف القائمة على الموظفين',
    columns: [
      { key: 'email', header: 'بريد الموظف', required: true },
      { key: 'amount', header: 'المبلغ', required: true },
      { key: 'reason', header: 'البيان' },
      { key: 'date', header: 'التاريخ', hint: 'YYYY-MM-DD' },
      { key: 'installments', header: 'عدد الأقساط' }
    ],
    sample: [{ email: 'm.ahmed@example.sa', amount: 3000, reason: 'عهدة تشغيلية', date: '2026-08-01', installments: 3 }]
  }
};

/** يطابق ترويسة الملف مع الأعمدة المعرفة (يقبل الترويسة العربية أو المفتاح الإنجليزي) */
function mapHeader(def, headerRow) {
  const norm = (s) => String(s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const map = {};
  headerRow.forEach((h, i) => {
    const nh = norm(h);
    const col = def.columns.find(c => norm(c.header) === nh || c.key.toLowerCase() === nh);
    if (col) map[col.key] = i;
  });
  return map;
}

export function validateRows(ctx, type, rows) {
  const def = IMPORT_TYPES[type];
  const header = rows[0] || [];
  const map = mapHeader(def, header);
  const missing = def.columns.filter(c => c.required && map[c.key] === undefined);
  if (missing.length) {
    return {
      total: 0, valid_rows: [], columns: def.columns,
      errors: [{ row: 1, field: 'الترويسة', message: `أعمدة مفقودة في الملف: ${missing.map(m => m.header).join('، ')}` }]
    };
  }

  const errors = [];
  const valid = [];
  const seen = new Set();
  const branches = db.prepare('SELECT code FROM branches WHERE tenant_id=?').all(ctx.tenantId).map(b => b.code.toLowerCase());
  const roles = db.prepare('SELECT key FROM roles WHERE tenant_id=?').all(ctx.tenantId).map(r => r.key);
  const existingEmails = new Set(db.prepare('SELECT lower(email) e FROM users WHERE tenant_id=?').all(ctx.tenantId).map(u => u.e));

  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.every(c => String(c ?? '').trim() === '')) continue;
    const rec = {};
    for (const c of def.columns) rec[c.key] = String(raw[map[c.key]] ?? '').trim();
    const rowNo = i + 1;
    const add = (field, message) => errors.push({ row: rowNo, field, message, value: rec[field] || '' });
    let ok = true;

    for (const c of def.columns) {
      if (c.required && !rec[c.key]) { add(c.key, `الحقل "${c.header}" إلزامي وفارغ`); ok = false; }
    }
    if (!ok) continue;

    if (['users', 'employees', 'advances'].includes(type)) {
      if (!isEmail(rec.email)) { add('email', 'صيغة البريد الإلكتروني غير صحيحة'); ok = false; }
      else {
        const e = rec.email.toLowerCase();
        if (type === 'users') {
          if (existingEmails.has(e)) { add('email', 'البريد مسجّل مسبقاً في المنصة'); ok = false; }
          else if (seen.has(e)) { add('email', 'البريد مكرر داخل الملف نفسه'); ok = false; }
          seen.add(e);
        } else if (!existingEmails.has(e)) { add('email', 'لا يوجد مستخدم بهذا البريد في المنصة'); ok = false; }
      }
    }
    if (type === 'users') {
      if (!roles.includes(rec.role_key)) { add('role_key', `دور غير معروف — المتاح: ${roles.join('، ')}`); ok = false; }
      if (!branches.includes(String(rec.branch_code).toLowerCase())) { add('branch_code', 'رمز الفرع غير موجود'); ok = false; }
      if (rec.password && rec.password.length < 8) { add('password', 'كلمة المرور يجب أن تكون ٨ أحرف فأكثر'); ok = false; }
    }
    if (type === 'branches') {
      if (seen.has(rec.code.toLowerCase())) { add('code', 'رمز الفرع مكرر داخل الملف'); ok = false; }
      seen.add(rec.code.toLowerCase());
      if (branches.includes(rec.code.toLowerCase())) { add('code', 'رمز الفرع مستخدم مسبقاً'); ok = false; }
      for (const k of ['lat', 'lng', 'geofence_radius']) if (rec[k] && !isNum(rec[k])) { add(k, 'القيمة يجب أن تكون رقماً'); ok = false; }
    }
    if (['employees', 'budgets', 'advances'].includes(type)) {
      for (const k of ['basic_salary', 'allowances', 'amount', 'installments']) {
        if (rec[k] !== undefined && rec[k] !== '' && !isNum(rec[k])) { add(k, 'القيمة يجب أن تكون رقماً'); ok = false; }
      }
    }
    for (const k of ['hire_date', 'date', 'start_date', 'due_date']) {
      if (rec[k] && !isDate(rec[k])) { add(k, 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD'); ok = false; }
    }
    if (type === 'tasks' && rec.priority && !['low', 'medium', 'high', 'urgent'].includes(rec.priority)) {
      add('priority', 'الأولوية يجب أن تكون: low أو medium أو high أو urgent'); ok = false;
    }
    if (ok) valid.push({ _row: rowNo, ...rec });
  }

  return { total: rows.length - 1, valid_rows: valid, errors, columns: def.columns, preview: valid.slice(0, 20) };
}

/** المعالجة الفعلية داخل الطابور الخلفي */
export async function runImport({ batchId, tenantId, userId, type, rows, branchId }) {
  db.prepare("UPDATE import_batches SET status='running' WHERE id=?").run(batchId);
  let ok = 0;
  const errors = [];
  const branchByCode = Object.fromEntries(
    db.prepare('SELECT id, lower(code) c FROM branches WHERE tenant_id=?').all(tenantId).map(b => [b.c, b.id]));
  const roleByKey = Object.fromEntries(
    db.prepare('SELECT id, key FROM roles WHERE tenant_id=?').all(tenantId).map(r => [r.key, r.id]));
  const userByEmail = () => Object.fromEntries(
    db.prepare('SELECT id, lower(email) e FROM users WHERE tenant_id=?').all(tenantId).map(u => [u.e, u.id]));
  const term = db.prepare('SELECT id FROM terms WHERE tenant_id=? AND is_current=1').get(tenantId);

  const chunk = 100;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    try {
      db.transaction(() => {
        const emails = userByEmail();
        for (const r of slice) {
          try {
            if (type === 'users') {
              const pw = r.password || `Noor@${Math.random().toString(36).slice(2, 8)}`;
              const uid = db.prepare(`INSERT INTO users(tenant_id,name,email,phone,password_hash,role_id,primary_branch_id,must_change_pw)
                VALUES(?,?,?,?,?,?,?,1)`).run(tenantId, r.name, r.email.toLowerCase(), r.phone || null,
                bcrypt.hashSync(pw, 10), roleByKey[r.role_key], branchByCode[r.branch_code.toLowerCase()]).lastInsertRowid;
              db.prepare('INSERT OR IGNORE INTO user_branches(tenant_id,user_id,branch_id) VALUES(?,?,?)')
                .run(tenantId, uid, branchByCode[r.branch_code.toLowerCase()]);
            } else if (type === 'employees') {
              const uid = emails[r.email.toLowerCase()];
              db.prepare(`INSERT INTO employees(tenant_id,branch_id,user_id,employee_no,job_title,department,hire_date,basic_salary,allowances,bank_iban)
                VALUES(?,(SELECT primary_branch_id FROM users WHERE id=?),?,?,?,?,?,?,?,?)
                ON CONFLICT(tenant_id,user_id) DO UPDATE SET employee_no=excluded.employee_no,
                  job_title=excluded.job_title, department=excluded.department, hire_date=excluded.hire_date,
                  basic_salary=excluded.basic_salary, allowances=excluded.allowances, bank_iban=excluded.bank_iban`)
                .run(tenantId, uid, uid, r.employee_no || null, r.job_title || null, r.department || null,
                  r.hire_date || null, num(r.basic_salary), num(r.allowances), r.bank_iban || null);
            } else if (type === 'branches') {
              db.prepare(`INSERT INTO branches(tenant_id,code,name,address,lat,lng,geofence_radius,phone)
                VALUES(?,?,?,?,?,?,?,?)`).run(tenantId, r.code, r.name, r.address || null,
                r.lat ? num(r.lat) : null, r.lng ? num(r.lng) : null, num(r.geofence_radius) || 50, r.phone || null);
            } else if (type === 'tasks') {
              const bid = r.branch_code ? branchByCode[r.branch_code.toLowerCase()] : branchId;
              const com = r.committee_name
                ? db.prepare('SELECT id FROM committees WHERE tenant_id=? AND name=?').get(tenantId, r.committee_name)?.id
                : null;
              db.prepare(`INSERT INTO tasks(tenant_id,branch_id,term_id,committee_id,title,description,priority,assignee_id,created_by,start_date,due_date)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(tenantId, bid || null, term?.id || null, com || null,
                r.title, r.description || null, r.priority || 'medium',
                r.assignee_email ? emails[r.assignee_email.toLowerCase()] || null : null,
                userId, r.start_date || null, r.due_date || null);
            } else if (type === 'budgets') {
              db.prepare('INSERT INTO budgets(tenant_id,branch_id,term_id,name,category,amount) VALUES(?,?,?,?,?,?)')
                .run(tenantId, r.branch_code ? branchByCode[r.branch_code.toLowerCase()] : branchId,
                  term?.id || null, r.name, r.category || 'عام', num(r.amount));
            } else if (type === 'advances') {
              const uid = emails[r.email.toLowerCase()];
              db.prepare(`INSERT INTO advances(tenant_id,branch_id,term_id,user_id,amount,remaining,installments,reason,date,status)
                VALUES(?,?,?,?,?,?,?,?,?, 'approved')`).run(tenantId, branchId, term?.id || null, uid,
                num(r.amount), num(r.amount), num(r.installments) || 1, r.reason || null,
                r.date || new Date().toISOString().slice(0, 10));
            }
            ok++;
          } catch (e) {
            errors.push({ row: r._row, field: '-', message: String(e.message).slice(0, 200) });
          }
        }
      })();
    } catch (e) {
      errors.push({ row: '-', field: '-', message: `فشل معالجة دفعة: ${e.message}` });
    }
  }

  const prev = db.prepare('SELECT errors, error_rows FROM import_batches WHERE id=?').get(batchId);
  const allErrors = [...JSON.parse(prev.errors || '[]'), ...errors].slice(0, 300);
  db.prepare(`UPDATE import_batches SET status=?, ok_rows=?, error_rows=?, errors=?, finished_at=? WHERE id=?`)
    .run(errors.length && !ok ? 'failed' : 'done', ok, prev.error_rows + errors.length,
      JSON.stringify(allErrors), nowUTC(), batchId);

  auditSystem({ tenantId, action: 'create', entity: 'import_batch', entityId: batchId,
    summary: `اكتمل استيراد ${IMPORT_TYPES[type].label}: ${ok} سجل ناجح، ${errors.length} خطأ` });
  await notifyUsers(tenantId, [userId], {
    type: 'import.done', category: 'system',
    title: errors.length ? 'اكتمل الاستيراد مع بعض الأخطاء' : 'اكتمل استيراد البيانات بنجاح',
    body: `${IMPORT_TYPES[type].label}: تم إدخال ${ok} سجل${errors.length ? ` وتعذّر ${errors.length}` : ''}`,
    url: '/imports'
  });
  return { ok, errors: errors.length };
}
