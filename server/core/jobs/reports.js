import { scoped, currentTerm } from '../scope.js';
import { toHijri } from '../hijri.js';
import { isMissingSchema } from '../sql.js';

/**
 * محرك التقارير (البند ١٣): استعلامات محسّنة ومخصّصة للتقارير الثقيلة،
 * مع لوحة فلاتر متقدمة (التاريخ، الفرع، المستخدم، الحالة).
 */
const F = {
  dateRange: [{ key: 'from', label: 'من تاريخ', type: 'date' }, { key: 'to', label: 'إلى تاريخ', type: 'date' }],
  branch: { key: 'branch_id', label: 'الفرع', type: 'branch' },
  term: { key: 'term_id', label: 'الفصل الدراسي', type: 'term' },
  user: { key: 'user_id', label: 'المستخدم', type: 'user' }
};

const money = (n) => Number(n || 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS_AR = { todo: 'لم تبدأ', in_progress: 'قيد التنفيذ', review: 'قيد المراجعة', done: 'مكتملة', blocked: 'متوقفة' };
const PRIORITY_AR = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية', urgent: 'عاجلة' };
const ATT_AR = { present: 'حاضر', late: 'متأخر', absent: 'غائب', leave: 'إجازة' };
const FIN_AR = { pending: 'بانتظار الاعتماد', in_review: 'قيد الاعتماد', approved: 'معتمد', rejected: 'مرفوض', paid: 'مصروف' };
const LEAVE_AR = { annual: 'سنوية', sick: 'مرضية', emergency: 'اضطرارية', unpaid: 'بدون راتب' };

/**
 * مستويات تجميع إنجاز المهام — أربعةٌ يجمعها تقريرٌ واحد.
 *
 * كلُّ مستوىً يقول كيف يُشتقّ اسمُ المجموعة وأيَّ جدولٍ يحتاج، فيبقى الاستعلام
 * واحداً وتتبدّل قطعتان منه فقط. و«المجمّع» ثابتٌ لا جدول له: المستأجر مضمونٌ
 * أصلاً في حارس العزل، فالتجميع عليه يجمع الصفوف كلَّها في سطر.
 */
const TASK_GROUPS = {
  tenant:    { header: 'النطاق',   select: `'المجمّع كلّه'`,              join: '' },
  branch:    { header: 'الفرع',    select: `COALESCE(b.name,'بلا فرع')`,  join: 'LEFT JOIN branches b ON b.id=t.branch_id' },
  committee: { header: 'اللجنة',   select: `COALESCE(c.name,'بلا لجنة')`, join: 'LEFT JOIN committees c ON c.id=t.committee_id' },
  user:      { header: 'المنسوب',  select: `COALESCE(u.name,'غير مُسند')`, join: 'LEFT JOIN users u ON u.id=t.assignee_id' }
};

export const REPORTS = {
  tasks: {
    label: 'تقرير المهام واللجان', module: 'المهام', permission: 'reports.view',
    description: 'حالة تنفيذ المهام موزعة على الفروع واللجان والمكلّفين',
    filters: [F.term, F.branch, F.user, ...F.dateRange, { key: 'status', label: 'الحالة', type: 'select', options: Object.entries(STATUS_AR).map(([v, l]) => ({ value: v, label: l })) }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 't' });
      let sql = `SELECT t.title, c.name committee, b.name branch, u.name assignee, t.status, t.priority,
          t.start_date, t.due_date, t.progress
        FROM tasks t LEFT JOIN committees c ON c.id=t.committee_id LEFT JOIN branches b ON b.id=t.branch_id
        LEFT JOIN users u ON u.id=t.assignee_id WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.term_id) { sql += ' AND t.term_id=?'; p.push(f.term_id); }
      if (f.branch_id) { sql += ' AND t.branch_id=?'; p.push(f.branch_id); }
      if (f.user_id) { sql += ' AND t.assignee_id=?'; p.push(f.user_id); }
      if (f.status) { sql += ' AND t.status=?'; p.push(f.status); }
      if (f.from) { sql += ' AND (t.due_date>=? OR t.start_date>=?)'; p.push(f.from, f.from); }
      if (f.to) { sql += ' AND (t.due_date<=? OR t.start_date<=?)'; p.push(f.to, f.to); }
      sql += ' ORDER BY t.due_date, t.id';
      const rows = (await app.db.all(sql, ...p)).map(r => ({
        ...r, status: STATUS_AR[r.status] || r.status, priority: PRIORITY_AR[r.priority] || r.priority,
        progress: `${r.progress}%`
      }));
      const done = rows.filter(r => r.status === 'مكتملة').length;
      return {
        columns: [
          { key: 'title', header: 'المهمة', width: 34 }, { key: 'committee', header: 'اللجنة' },
          { key: 'branch', header: 'الفرع' }, { key: 'assignee', header: 'المكلّف' },
          { key: 'status', header: 'الحالة' }, { key: 'priority', header: 'الأولوية' },
          { key: 'start_date', header: 'البداية' }, { key: 'due_date', header: 'الاستحقاق' },
          { key: 'progress', header: 'الإنجاز' }
        ],
        rows,
        summary: [
          { label: 'إجمالي المهام', value: rows.length },
          { label: 'المكتملة', value: done },
          { label: 'نسبة الإنجاز', value: rows.length ? `${Math.round(done * 100 / rows.length)}%` : '—' }
        ]
      };
    }
  },

  /* ─────────────── إنجاز المهام على مستوياته الأربعة ───────────────
   *
   * تقريرٌ واحد لا أربعة: المستوى مُبدِّلٌ في لوحة التصفية — المجمّع كلُّه، أو
   * موزَّعاً على الفروع، أو على اللجان، أو على المنسوبين. والأعمدةُ واحدةٌ في
   * المستويات كلِّها فيُقرأ الجدولُ بالعادة نفسها، ويُصدَّر إلى إكسل بالبنية
   * نفسها، ولا يحتاج من يقارن مستوىً بمستوى أن يقارن جدولين مختلفين.
   *
   * ونسبة الإنجاز موزونةٌ لا عدديّة: مهمّةٌ وزنُها خمسةٌ أنجزت نصفها ليست
   * كمهمّةٍ وزنُها واحد أنجزت نصفها. والعدديّة («المكتملة») بجانبها لمن يريد
   * العدّ المجرّد.
   */
  tasks_progress: {
    label: 'إنجاز المهام', module: 'المهام', permission: 'reports.view',
    description: 'نِسَب الإنجاز والمتأخرات — على مستوى المجمّع أو الفروع أو اللجان أو المنسوبين',
    filters: [
      { key: 'group_by', label: 'مستوى التقرير', type: 'group', default: 'branch',
        options: [
          { value: 'tenant', label: 'المجمّع كلّه' }, { value: 'branch', label: 'حسب الفرع' },
          { value: 'committee', label: 'حسب اللجنة' }, { value: 'user', label: 'حسب المنسوب' }
        ] },
      F.term, F.branch, F.user, ...F.dateRange
    ],
    async run(app, ctx, f) {
      const g = TASK_GROUPS[f.group_by] || TASK_GROUPS.branch;
      const sc = scoped(ctx, { alias: 't' });
      const today = new Date().toISOString().slice(0, 10);

      let sql = `SELECT ${g.select} AS grp,
          COUNT(*) AS total,
          SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN t.status IN ('in_progress','review') THEN 1 ELSE 0 END) AS doing,
          SUM(CASE WHEN t.status='todo' THEN 1 ELSE 0 END) AS todo,
          SUM(CASE WHEN t.status='blocked' THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
          SUM(t.weight) AS w_total,
          SUM(t.weight * t.progress) AS w_progress
        FROM tasks t ${g.join} WHERE ${sc.where}`;
      const p = [today, ...sc.params];
      if (f.term_id) { sql += ' AND t.term_id=?'; p.push(f.term_id); }
      if (f.branch_id) { sql += ' AND t.branch_id=?'; p.push(f.branch_id); }
      if (f.user_id) { sql += ' AND t.assignee_id=?'; p.push(f.user_id); }
      /* المدى يقع على الاستحقاق أو البداية — فالمهمّة تدخل الفترة بأيّهما وقع فيها */
      if (f.from) { sql += ' AND (t.due_date>=? OR t.start_date>=?)'; p.push(f.from, f.from); }
      if (f.to) { sql += ' AND (t.due_date<=? OR t.start_date<=?)'; p.push(f.to, f.to); }
      sql += ' GROUP BY grp ORDER BY total DESC, grp';

      const raw = await app.db.all(sql, ...p);
      const pctOf = (num, den) => (den > 0 ? `${Math.round((num * 100) / den)}%` : '—');
      const rows = raw.map(r => ({
        grp: r.grp,
        total: r.total,
        done: r.done,
        doing: r.doing,
        todo: r.todo,
        blocked: r.blocked,
        overdue: r.overdue,
        /* الموزونة: مجموع (الوزن × الإنجاز) على مجموع (الوزن × ١٠٠) */
        progress: pctOf(r.w_progress, (r.w_total || 0) * 100),
        completed: pctOf(r.done, r.total)
      }));

      const sum = (k) => raw.reduce((s, r) => s + (r[k] || 0), 0);
      const wTotal = sum('w_total') * 100;
      return {
        columns: [
          { key: 'grp', header: g.header, width: 30 },
          { key: 'total', header: 'إجمالي المهام' }, { key: 'done', header: 'مكتملة' },
          { key: 'doing', header: 'قيد التنفيذ' }, { key: 'todo', header: 'لم تبدأ' },
          { key: 'blocked', header: 'متوقفة' }, { key: 'overdue', header: 'متأخرة' },
          { key: 'progress', header: 'نسبة الإنجاز' }, { key: 'completed', header: 'نسبة المكتمل' }
        ],
        rows,
        summary: [
          { label: 'إجمالي المهام', value: sum('total') },
          { label: 'المكتملة', value: sum('done') },
          { label: 'المتأخرة', value: sum('overdue') },
          { label: 'نسبة الإنجاز', value: wTotal > 0 ? `${Math.round((sum('w_progress') * 100) / wTotal)}%` : '—' }
        ]
      };
    }
  },

  /*
   * المتأخرات وحدها في تقرير: قائمةُ الإنجاز أعلاه تقول «كم»، وهذه تقول «أيُّها»
   * ومَن يتولّاها وكم مضى على استحقاقها — وهي التي تُطبع لاجتماع المتابعة.
   */
  tasks_overdue: {
    label: 'المهام المتأخرة والمتعثّرة', module: 'المهام', permission: 'reports.view',
    description: 'ما تجاوز استحقاقه ولم يكتمل، مرتّباً بالأطول تأخّراً — ومعه المتوقّف',
    filters: [F.term, F.branch, F.user,
      { key: 'scope', label: 'النطاق', type: 'group', default: 'overdue',
        options: [
          { value: 'overdue', label: 'المتأخرة فقط' },
          { value: 'blocked', label: 'المتوقفة فقط' },
          { value: 'both', label: 'المتأخرة والمتوقفة' }
        ] }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 't' });
      const today = new Date().toISOString().slice(0, 10);
      const mode = ['overdue', 'blocked', 'both'].includes(f.scope) ? f.scope : 'overdue';
      const lateCond = `(t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < ?)`;
      const cond = mode === 'overdue' ? lateCond
        : mode === 'blocked' ? `t.status='blocked'`
          : `(${lateCond} OR t.status='blocked')`;

      let sql = `SELECT t.title, c.name AS committee, b.name AS branch, u.name AS assignee,
          t.status, t.priority, t.due_date, t.progress,
          CAST(julianday(?) - julianday(t.due_date) AS INTEGER) AS days_late
        FROM tasks t
        LEFT JOIN committees c ON c.id=t.committee_id
        LEFT JOIN branches b ON b.id=t.branch_id
        LEFT JOIN users u ON u.id=t.assignee_id
        WHERE ${sc.where} AND ${cond}`;
      const p = [today, ...sc.params];
      if (mode !== 'blocked') p.push(today);          /* شرط التأخّر يحمل تاريخ اليوم */
      if (f.term_id) { sql += ' AND t.term_id=?'; p.push(f.term_id); }
      if (f.branch_id) { sql += ' AND t.branch_id=?'; p.push(f.branch_id); }
      if (f.user_id) { sql += ' AND t.assignee_id=?'; p.push(f.user_id); }
      sql += ' ORDER BY days_late DESC, t.due_date';

      const raw = await app.db.all(sql, ...p);
      const rows = raw.map(r => ({
        title: r.title, committee: r.committee || '—', branch: r.branch || '—',
        assignee: r.assignee || 'غير مُسند',
        status: STATUS_AR[r.status] || r.status,
        priority: PRIORITY_AR[r.priority] || r.priority,
        due_date: r.due_date || '—',
        days_late: r.days_late > 0 ? r.days_late : '—',
        progress: `${r.progress}%`
      }));
      const late = raw.filter(r => r.days_late > 0);
      return {
        columns: [
          { key: 'title', header: 'المهمة', width: 34 }, { key: 'assignee', header: 'المكلّف' },
          { key: 'committee', header: 'اللجنة' }, { key: 'branch', header: 'الفرع' },
          { key: 'status', header: 'الحالة' }, { key: 'priority', header: 'الأولوية' },
          { key: 'due_date', header: 'الاستحقاق' }, { key: 'days_late', header: 'أيام التأخّر' },
          { key: 'progress', header: 'الإنجاز' }
        ],
        rows,
        summary: [
          { label: 'عدد المهام', value: raw.length },
          { label: 'المتأخرة فعلاً', value: late.length },
          { label: 'المتوقفة', value: raw.filter(r => r.status === 'blocked').length },
          { label: 'أطول تأخّر', value: late.length ? `${Math.max(...late.map(r => r.days_late))} يوم` : '—' }
        ]
      };
    }
  },

  /*
   * ملخّصُ الحضور لا سجلُّه: تقرير الحضور أعلاه سطرٌ لكل يوم، وهذا سطرٌ لكل
   * منسوب — وهو الذي يُقرأ حين يُسأل «من يتأخّر؟» لا «ماذا جرى يوم كذا؟».
   * ودقائق التأخّر تُجمع من عمودها المستجدّ، فإن لم يُطبَّق المخطط بعد سقط
   * العمود وحده وبقي التقرير.
   */
  attendance_summary: {
    label: 'ملخّص الحضور والتأخّر', module: 'الموارد البشرية', permission: 'hr.attendance.view',
    description: 'سطرٌ لكل منسوب: أيام حضوره وتأخّره وغيابه ومجموع دقائق تأخّره خلال الفترة',
    filters: [F.branch, F.user, ...F.dateRange],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'a' });
      const build = (lateCol) => {
        let sql = `SELECT u.name AS employee, e.employee_no, b.name AS branch,
            COUNT(*) AS days,
            SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status='late' THEN 1 ELSE 0 END) AS late,
            SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status='leave' THEN 1 ELSE 0 END) AS on_leave,
            SUM(a.minutes_worked) AS minutes,
            ${lateCol} AS late_minutes
          FROM attendance a JOIN users u ON u.id=a.user_id
          LEFT JOIN employees e ON e.user_id=a.user_id AND e.tenant_id=a.tenant_id
          LEFT JOIN branches b ON b.id=a.branch_id
          WHERE ${sc.where}`;
        const p = [...sc.params];
        if (f.branch_id) { sql += ' AND a.branch_id=?'; p.push(f.branch_id); }
        if (f.user_id) { sql += ' AND a.user_id=?'; p.push(f.user_id); }
        if (f.from) { sql += ' AND a.date>=?'; p.push(f.from); }
        if (f.to) { sql += ' AND a.date<=?'; p.push(f.to); }
        return [sql + ' GROUP BY a.user_id ORDER BY late DESC, absent DESC, u.name', p];
      };

      let raw;
      try {
        const [sql, p] = build('SUM(COALESCE(a.late_minutes,0))');
        raw = await app.db.all(sql, ...p);
      } catch (e) {
        if (!isMissingSchema(e)) throw e;
        const [sql, p] = build('0');
        raw = await app.db.all(sql, ...p);
      }

      const hours = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '—');
      const rows = raw.map(r => ({
        employee: r.employee, employee_no: r.employee_no || '—', branch: r.branch || '—',
        days: r.days, present: r.present, late: r.late, absent: r.absent, on_leave: r.on_leave,
        late_minutes: r.late_minutes || 0,
        hours: hours(r.minutes),
        rate: r.days ? `${Math.round(((r.present + r.late) * 100) / r.days)}%` : '—'
      }));
      const sum = (k) => raw.reduce((s, r) => s + (r[k] || 0), 0);
      return {
        columns: [
          { key: 'employee', header: 'المنسوب', width: 28 }, { key: 'employee_no', header: 'الرقم الوظيفي' },
          { key: 'branch', header: 'الفرع' }, { key: 'days', header: 'أيام مسجّلة' },
          { key: 'present', header: 'حاضر' }, { key: 'late', header: 'متأخر' },
          { key: 'absent', header: 'غائب' }, { key: 'on_leave', header: 'إجازة' },
          { key: 'late_minutes', header: 'دقائق التأخّر' }, { key: 'hours', header: 'ساعات العمل' },
          { key: 'rate', header: 'نسبة الحضور' }
        ],
        rows,
        summary: [
          { label: 'عدد المنسوبين', value: raw.length },
          { label: 'أيام التأخّر', value: sum('late') },
          { label: 'أيام الغياب', value: sum('absent') },
          { label: 'مجموع دقائق التأخّر', value: sum('late_minutes') }
        ]
      };
    }
  },

  leaves: {
    label: 'تقرير الإجازات', module: 'الموارد البشرية', permission: 'hr.leaves.approve',
    description: 'طلبات الإجازات وأيامها وحالات اعتمادها لكل منسوب',
    filters: [F.branch, F.user, ...F.dateRange,
      { key: 'status', label: 'الحالة', type: 'select',
        options: [{ value: 'pending', label: 'بانتظار الاعتماد' }, { value: 'approved', label: 'معتمدة' }, { value: 'rejected', label: 'مرفوضة' }] },
      { key: 'type', label: 'النوع', type: 'select',
        options: Object.entries(LEAVE_AR).map(([v, l]) => ({ value: v, label: l })) }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'l' });
      let sql = `SELECT u.name AS employee, b.name AS branch, l.type, l.start_date, l.end_date,
          l.days, l.status, l.reason, ap.name AS approver
        FROM leaves l JOIN users u ON u.id=l.user_id
        LEFT JOIN branches b ON b.id=l.branch_id LEFT JOIN users ap ON ap.id=l.approved_by
        WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.branch_id) { sql += ' AND l.branch_id=?'; p.push(f.branch_id); }
      if (f.user_id) { sql += ' AND l.user_id=?'; p.push(f.user_id); }
      if (f.status) { sql += ' AND l.status=?'; p.push(f.status); }
      if (f.type) { sql += ' AND l.type=?'; p.push(f.type); }
      /* الإجازة تدخل الفترة بتقاطعها معها لا بابتدائها فيها */
      if (f.from) { sql += ' AND l.end_date>=?'; p.push(f.from); }
      if (f.to) { sql += ' AND l.start_date<=?'; p.push(f.to); }
      const raw = await app.db.all(sql + ' ORDER BY l.start_date DESC', ...p);
      const ST = { pending: 'بانتظار الاعتماد', approved: 'معتمدة', rejected: 'مرفوضة' };
      const approved = raw.filter(r => r.status === 'approved');
      return {
        columns: [
          { key: 'employee', header: 'المنسوب', width: 26 }, { key: 'branch', header: 'الفرع' },
          { key: 'type', header: 'النوع' }, { key: 'start_date', header: 'من' },
          { key: 'end_date', header: 'إلى' }, { key: 'days', header: 'الأيام' },
          { key: 'status', header: 'الحالة' }, { key: 'approver', header: 'المعتمِد' },
          { key: 'reason', header: 'السبب', width: 30 }
        ],
        rows: raw.map(r => ({
          employee: r.employee, branch: r.branch || '—', type: LEAVE_AR[r.type] || r.type,
          start_date: r.start_date, end_date: r.end_date, days: r.days,
          status: ST[r.status] || r.status, approver: r.approver || '—', reason: r.reason || '—'
        })),
        summary: [
          { label: 'عدد الطلبات', value: raw.length },
          { label: 'المعتمدة', value: approved.length },
          { label: 'أيام معتمدة', value: approved.reduce((s, r) => s + (r.days || 0), 0) },
          { label: 'بانتظار الاعتماد', value: raw.filter(r => r.status === 'pending').length }
        ]
      };
    }
  },

  /*
   * كشفُ المنسوبين بلا رواتب: الراتب له تقريرُه المحروس بصلاحيته، وهذا يُطبع
   * للتنظيم الإداري ويُطّلع عليه أوسع، فلا يُحمَّل ما يضيّق دائرة قارئيه.
   */
  employees: {
    label: 'كشف المنسوبين والعقود', module: 'الموارد البشرية', permission: 'hr.employees.view',
    description: 'المنسوبون ووظائفهم وفروعهم وعقودهم — ومن قارب عقده على الانتهاء',
    filters: [F.branch,
      { key: 'status', label: 'الحالة', type: 'select',
        options: [{ value: 'active', label: 'على رأس العمل' }, { value: 'inactive', label: 'موقوف' }] },
      { key: 'contract', label: 'العقود', type: 'group', default: '',
        options: [{ value: '', label: 'الجميع' }, { value: 'ending', label: 'ينتهي خلال ٦٠ يوماً' }, { value: 'ended', label: 'منتهٍ' }] }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'e' });
      const today = new Date().toISOString().slice(0, 10);
      const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
      let sql = `SELECT e.employee_no, u.name AS employee, r.name AS role, e.job_title, e.department,
          b.name AS branch, e.contract_type, e.hire_date, e.contract_end, e.status, e.remote_allowed,
          u.phone, u.email
        FROM employees e JOIN users u ON u.id=e.user_id
        LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN branches b ON b.id=e.branch_id
        WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.branch_id) { sql += ' AND e.branch_id=?'; p.push(f.branch_id); }
      if (f.status) { sql += ' AND e.status=?'; p.push(f.status); }
      if (f.contract === 'ending') { sql += ' AND e.contract_end IS NOT NULL AND e.contract_end BETWEEN ? AND ?'; p.push(today, soon); }
      if (f.contract === 'ended') { sql += ' AND e.contract_end IS NOT NULL AND e.contract_end < ?'; p.push(today); }
      const raw = await app.db.all(sql + ' ORDER BY b.name, u.name', ...p);
      return {
        columns: [
          { key: 'employee_no', header: 'الرقم الوظيفي' }, { key: 'employee', header: 'المنسوب', width: 26 },
          { key: 'role', header: 'الدور' }, { key: 'job_title', header: 'المسمى الوظيفي' },
          { key: 'department', header: 'القسم' }, { key: 'branch', header: 'الفرع' },
          { key: 'contract_type', header: 'نوع التعاقد' }, { key: 'hire_date', header: 'المباشرة' },
          { key: 'contract_end', header: 'نهاية العقد' }, { key: 'workplace', header: 'مكان العمل' },
          { key: 'status', header: 'الحالة' }, { key: 'phone', header: 'الجوال' }
        ],
        rows: raw.map(r => ({
          employee_no: r.employee_no || '—', employee: r.employee, role: r.role || '—',
          job_title: r.job_title || '—', department: r.department || '—', branch: r.branch || '—',
          contract_type: r.contract_type || '—', hire_date: r.hire_date || '—',
          contract_end: r.contract_end || 'غير محدد',
          workplace: r.remote_allowed ? 'عن بُعد' : 'من مقرّ الفرع',
          status: r.status === 'active' ? 'على رأس العمل' : 'موقوف',
          phone: r.phone || '—'
        })),
        summary: [
          { label: 'عدد المنسوبين', value: raw.length },
          { label: 'على رأس العمل', value: raw.filter(r => r.status === 'active').length },
          { label: 'عقود تنتهي خلال ٦٠ يوماً', value: raw.filter(r => r.contract_end && r.contract_end >= today && r.contract_end <= soon).length },
          { label: 'عقود منتهية', value: raw.filter(r => r.contract_end && r.contract_end < today).length }
        ]
      };
    }
  },

  attendance: {
    label: 'تقرير الحضور والانصراف', module: 'الموارد البشرية', permission: 'hr.attendance.view',
    description: 'سجل الحضور اليومي مع حالات التأخير والغياب والإجازات',
    filters: [F.branch, F.user, ...F.dateRange, { key: 'status', label: 'الحالة', type: 'select', options: Object.entries(ATT_AR).map(([v, l]) => ({ value: v, label: l })) }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'a' });
      let sql = `SELECT a.date, u.name employee, e.employee_no, b.name branch, a.status,
          a.check_in_at, a.check_out_at, a.minutes_worked, a.in_distance
        FROM attendance a JOIN users u ON u.id=a.user_id
        LEFT JOIN employees e ON e.user_id=a.user_id AND e.tenant_id=a.tenant_id
        LEFT JOIN branches b ON b.id=a.branch_id WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.branch_id) { sql += ' AND a.branch_id=?'; p.push(f.branch_id); }
      if (f.user_id) { sql += ' AND a.user_id=?'; p.push(f.user_id); }
      if (f.status) { sql += ' AND a.status=?'; p.push(f.status); }
      if (f.from) { sql += ' AND a.date>=?'; p.push(f.from); }
      if (f.to) { sql += ' AND a.date<=?'; p.push(f.to); }
      sql += ' ORDER BY a.date DESC, u.name';
      const raw = await app.db.all(sql, ...p);
      const t = (v) => v ? new Date(v).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }) : '—';
      const rows = raw.map(r => ({
        date: r.date, employee: r.employee, employee_no: r.employee_no || '—', branch: r.branch || '—',
        status: ATT_AR[r.status] || r.status, check_in: t(r.check_in_at), check_out: t(r.check_out_at),
        hours: r.minutes_worked ? `${Math.floor(r.minutes_worked / 60)}:${String(r.minutes_worked % 60).padStart(2, '0')}` : '—',
        distance: r.in_distance != null ? `${r.in_distance} م` : '—'
      }));
      const by = raw.reduce((s, r) => { s[r.status] = (s[r.status] || 0) + 1; return s; }, {});
      return {
        columns: [
          { key: 'date', header: 'التاريخ' }, { key: 'employee', header: 'الموظف', width: 26 },
          { key: 'employee_no', header: 'الرقم الوظيفي' }, { key: 'branch', header: 'الفرع' },
          { key: 'status', header: 'الحالة' }, { key: 'check_in', header: 'الحضور' },
          { key: 'check_out', header: 'الانصراف' }, { key: 'hours', header: 'ساعات العمل' },
          { key: 'distance', header: 'المسافة' }
        ],
        rows,
        summary: [
          { label: 'حاضر', value: by.present || 0 }, { label: 'متأخر', value: by.late || 0 },
          { label: 'غائب', value: by.absent || 0 }, { label: 'إجازة', value: by.leave || 0 }
        ]
      };
    }
  },

  finance: {
    label: 'تقرير الطلبات المالية والاعتمادات', module: 'المالية', permission: 'finance.view',
    description: 'الطلبات المالية وحالات اعتمادها والمبالغ المصروفة',
    filters: [F.term, F.branch, ...F.dateRange, { key: 'status', label: 'الحالة', type: 'select', options: Object.entries(FIN_AR).map(([v, l]) => ({ value: v, label: l })) }, { key: 'type', label: 'النوع', type: 'select', options: [{ value: 'expense', label: 'مصروف' }, { value: 'custody', label: 'عهدة' }, { value: 'purchase', label: 'شراء' }, { value: 'reimbursement', label: 'تعويض' }] }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'r' });
      let sql = `SELECT r.number, r.title, r.type, b.name branch, u.name requester, r.amount, r.status,
          r.created_at, bd.name budget
        FROM finance_requests r JOIN users u ON u.id=r.requester_id
        LEFT JOIN branches b ON b.id=r.branch_id LEFT JOIN budgets bd ON bd.id=r.budget_id
        WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.term_id) { sql += ' AND r.term_id=?'; p.push(f.term_id); }
      if (f.branch_id) { sql += ' AND r.branch_id=?'; p.push(f.branch_id); }
      if (f.status) { sql += ' AND r.status=?'; p.push(f.status); }
      if (f.type) { sql += ' AND r.type=?'; p.push(f.type); }
      if (f.from) { sql += ' AND date(r.created_at)>=?'; p.push(f.from); }
      if (f.to) { sql += ' AND date(r.created_at)<=?'; p.push(f.to); }
      sql += ' ORDER BY r.created_at DESC';
      const raw = await app.db.all(sql, ...p);
      const TYPE_AR = { expense: 'مصروف', custody: 'عهدة', purchase: 'شراء', reimbursement: 'تعويض' };
      const rows = raw.map(r => ({
        number: r.number, title: r.title, type: TYPE_AR[r.type] || r.type, branch: r.branch || '—',
        requester: r.requester, amount: money(r.amount), status: FIN_AR[r.status] || r.status,
        date: r.created_at.slice(0, 10), budget: r.budget || '—'
      }));
      const approved = raw.filter(r => ['approved', 'paid'].includes(r.status));
      return {
        columns: [
          { key: 'number', header: 'رقم الطلب' }, { key: 'title', header: 'البيان', width: 32 },
          { key: 'type', header: 'النوع' }, { key: 'branch', header: 'الفرع' },
          { key: 'requester', header: 'مقدّم الطلب' }, { key: 'amount', header: 'المبلغ (ر.س)' },
          { key: 'status', header: 'الحالة' }, { key: 'date', header: 'التاريخ' }, { key: 'budget', header: 'بند الميزانية' }
        ],
        rows,
        summary: [
          { label: 'عدد الطلبات', value: raw.length },
          { label: 'إجمالي المطلوب', value: money(raw.reduce((s, r) => s + r.amount, 0)) + ' ر.س' },
          { label: 'المعتمد فعلياً', value: money(approved.reduce((s, r) => s + r.amount, 0)) + ' ر.س' }
        ]
      };
    }
  },

  budgets: {
    label: 'تقرير الميزانيات والمنصرف', module: 'المالية', permission: 'budgets.view',
    description: 'مقارنة المعتمد بالمنصرف لكل بند ميزانية',
    filters: [F.term, F.branch],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'b' });
      let sql = `SELECT b.name, b.category, br.name branch, b.amount, b.spent, (b.amount-b.spent) remaining,
          CASE WHEN b.amount>0 THEN ROUND(b.spent*100.0/b.amount,1) ELSE 0 END pct
        FROM budgets b LEFT JOIN branches br ON br.id=b.branch_id WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.term_id) { sql += ' AND b.term_id=?'; p.push(f.term_id); }
      if (f.branch_id) { sql += ' AND b.branch_id=?'; p.push(f.branch_id); }
      const raw = await app.db.all(sql + ' ORDER BY b.name', ...p);
      return {
        columns: [
          { key: 'name', header: 'بند الميزانية', width: 30 }, { key: 'category', header: 'التصنيف' },
          { key: 'branch', header: 'الفرع' }, { key: 'amount', header: 'المعتمد (ر.س)' },
          { key: 'spent', header: 'المنصرف (ر.س)' }, { key: 'remaining', header: 'المتبقي (ر.س)' },
          { key: 'pct', header: 'نسبة الاستهلاك' }
        ],
        rows: raw.map(r => ({ ...r, branch: r.branch || 'عام', amount: money(r.amount), spent: money(r.spent), remaining: money(r.remaining), pct: `${r.pct}%` })),
        summary: [
          { label: 'إجمالي المعتمد', value: money(raw.reduce((s, r) => s + r.amount, 0)) + ' ر.س' },
          { label: 'إجمالي المنصرف', value: money(raw.reduce((s, r) => s + r.spent, 0)) + ' ر.س' },
          { label: 'المتبقي', value: money(raw.reduce((s, r) => s + r.remaining, 0)) + ' ر.س' }
        ]
      };
    }
  },

  payroll: {
    label: 'تقرير مسير الرواتب', module: 'الموارد البشرية', permission: 'hr.payroll.view',
    description: 'تفاصيل الرواتب والاستقطاعات لكل موظف',
    filters: [{ key: 'payroll_run_id', label: 'المسير', type: 'payroll' }],
    async run(app, ctx, f) {
      let sql = `SELECT u.name employee, e.employee_no, e.job_title, i.basic, i.allowances,
          i.absence_deduction, i.late_deduction, i.advance_deduction, i.net, pr.year, pr.month
        FROM payroll_items i JOIN payroll_runs pr ON pr.id=i.payroll_run_id
        JOIN users u ON u.id=i.user_id
        LEFT JOIN employees e ON e.user_id=i.user_id AND e.tenant_id=i.tenant_id
        WHERE i.tenant_id=?`;
      const p = [ctx.tenantId];
      if (f.payroll_run_id) { sql += ' AND i.payroll_run_id=?'; p.push(f.payroll_run_id); }
      else { sql += ' AND pr.id=(SELECT MAX(id) FROM payroll_runs WHERE tenant_id=?)'; p.push(ctx.tenantId); }
      const raw = await app.db.all(sql + ' ORDER BY u.name', ...p);
      return {
        columns: [
          { key: 'employee', header: 'الموظف', width: 28 }, { key: 'employee_no', header: 'الرقم الوظيفي' },
          { key: 'job_title', header: 'المسمى' }, { key: 'basic', header: 'الأساسي' },
          { key: 'allowances', header: 'البدلات' }, { key: 'absence_deduction', header: 'خصم الغياب' },
          { key: 'late_deduction', header: 'خصم التأخير' }, { key: 'advance_deduction', header: 'خصم السلف' },
          { key: 'net', header: 'الصافي (ر.س)' }
        ],
        rows: raw.map(r => ({ ...r, employee_no: r.employee_no || '—', job_title: r.job_title || '—',
          basic: money(r.basic), allowances: money(r.allowances), absence_deduction: money(r.absence_deduction),
          late_deduction: money(r.late_deduction), advance_deduction: money(r.advance_deduction), net: money(r.net) })),
        summary: [
          { label: 'عدد الموظفين', value: raw.length },
          { label: 'إجمالي الصافي', value: money(raw.reduce((s, r) => s + r.net, 0)) + ' ر.س' },
          { label: 'الفترة', value: raw[0] ? `${raw[0].month}/${raw[0].year}` : '—' }
        ]
      };
    }
  },

  kpi: {
    label: 'تقرير مؤشرات الأداء', module: 'التقييم', permission: 'kpi.view_all',
    description: 'نسب إنجاز المهام والحضور ومتوسط التقييم لكل منسوب',
    filters: [F.term, F.branch],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 'k' });
      let sql = `SELECT u.name employee, b.name branch, k.tasks_total, k.tasks_done, k.tasks_overdue,
          k.completion_rate, k.attendance_rate, k.eval_avg, k.score
        FROM kpis k JOIN users u ON u.id=k.user_id LEFT JOIN branches b ON b.id=k.branch_id
        WHERE ${sc.where} AND k.period='term' AND k.user_id IS NOT NULL`;
      const p = [...sc.params];
      if (f.term_id) { sql += ' AND k.term_id=?'; p.push(f.term_id); }
      if (f.branch_id) { sql += ' AND k.branch_id=?'; p.push(f.branch_id); }
      const raw = await app.db.all(sql + ' ORDER BY k.score DESC', ...p);
      return {
        columns: [
          { key: 'employee', header: 'المنسوب', width: 28 }, { key: 'branch', header: 'الفرع' },
          { key: 'tasks_total', header: 'إجمالي المهام' }, { key: 'tasks_done', header: 'المنجزة' },
          { key: 'tasks_overdue', header: 'المتأخرة' }, { key: 'completion_rate', header: 'نسبة الإنجاز' },
          { key: 'attendance_rate', header: 'نسبة الحضور' }, { key: 'eval_avg', header: 'متوسط التقييم' },
          { key: 'score', header: 'المؤشر العام' }
        ],
        rows: raw.map(r => ({ ...r, branch: r.branch || '—', completion_rate: `${r.completion_rate}%`,
          attendance_rate: `${r.attendance_rate}%`, eval_avg: r.eval_avg ? r.eval_avg.toFixed(1) : '—',
          score: r.score.toFixed(1) })),
        summary: [
          { label: 'عدد المنسوبين', value: raw.length },
          { label: 'متوسط الإنجاز', value: raw.length ? `${Math.round(raw.reduce((s, r) => s + r.completion_rate, 0) / raw.length)}%` : '—' },
          { label: 'متوسط المؤشر', value: raw.length ? (raw.reduce((s, r) => s + r.score, 0) / raw.length).toFixed(1) : '—' }
        ]
      };
    }
  },

  tickets: {
    label: 'تقرير تذاكر الدعم الفني', module: 'الدعم', permission: 'tickets.view_all',
    description: 'التذاكر وحالاتها والتزامها باتفاقية مستوى الخدمة',
    filters: [...F.dateRange, { key: 'status', label: 'الحالة', type: 'select', options: [{ value: 'open', label: 'مفتوحة' }, { value: 'in_progress', label: 'قيد المعالجة' }, { value: 'resolved', label: 'تم حلها' }, { value: 'closed', label: 'مغلقة' }] }],
    async run(app, ctx, f) {
      const sc = scoped(ctx, { alias: 't' });
      let sql = `SELECT t.number, t.subject, t.category, t.priority, t.status, u.name requester,
          a.name assignee, t.created_at, t.sla_due_at, t.escalated, t.first_response_at
        FROM tickets t JOIN users u ON u.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id
        WHERE ${sc.where}`;
      const p = [...sc.params];
      if (f.status) { sql += ' AND t.status=?'; p.push(f.status); }
      if (f.from) { sql += ' AND date(t.created_at)>=?'; p.push(f.from); }
      if (f.to) { sql += ' AND date(t.created_at)<=?'; p.push(f.to); }
      const raw = await app.db.all(sql + ' ORDER BY t.created_at DESC', ...p);
      const ST = { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم حلها', closed: 'مغلقة' };
      return {
        columns: [
          { key: 'number', header: 'رقم التذكرة' }, { key: 'subject', header: 'الموضوع', width: 32 },
          { key: 'category', header: 'التصنيف' }, { key: 'priority', header: 'الأهمية' },
          { key: 'status', header: 'الحالة' }, { key: 'requester', header: 'مُقدّم الطلب' },
          { key: 'assignee', header: 'المسؤول' }, { key: 'date', header: 'تاريخ الرفع' },
          { key: 'sla', header: 'اتفاقية الخدمة' }
        ],
        rows: raw.map(r => ({
          number: r.number, subject: r.subject, category: r.category,
          priority: PRIORITY_AR[r.priority] || r.priority, status: ST[r.status] || r.status,
          requester: r.requester, assignee: r.assignee || '—', date: r.created_at.slice(0, 10),
          sla: r.escalated ? 'مُصعّدة' : (r.first_response_at ? 'ملتزمة' : 'بانتظار الرد')
        })),
        summary: [
          { label: 'إجمالي التذاكر', value: raw.length },
          { label: 'المفتوحة', value: raw.filter(r => ['open', 'in_progress'].includes(r.status)).length },
          { label: 'المُصعّدة', value: raw.filter(r => r.escalated).length }
        ]
      };
    }
  },

  audit: {
    label: 'تقرير سجل النشاطات والتدقيق', module: 'الحوكمة', permission: 'audit.view',
    description: 'من قام بماذا ومتى — سجل غير قابل للتعديل امتثالاً للأنظمة',
    filters: [...F.dateRange, F.user, { key: 'action', label: 'الإجراء', type: 'select', options: [{ value: 'create', label: 'إنشاء' }, { value: 'update', label: 'تعديل' }, { value: 'delete', label: 'حذف' }, { value: 'approve', label: 'اعتماد' }, { value: 'reject', label: 'رفض' }, { value: 'login', label: 'دخول' }, { value: 'export', label: 'تصدير' }] }],
    async run(app, ctx, f) {
      let sql = 'SELECT created_at, user_name, role_key, action, entity, summary, ip FROM audit_logs WHERE tenant_id=?';
      const p = [ctx.tenantId];
      if (f.user_id) { sql += ' AND user_id=?'; p.push(f.user_id); }
      if (f.action) { sql += ' AND action=?'; p.push(f.action); }
      if (f.from) { sql += ' AND created_at>=?'; p.push(f.from); }
      if (f.to) { sql += ' AND created_at<=?'; p.push(f.to + 'T23:59:59Z'); }
      const raw = await app.db.all(sql + ' ORDER BY id DESC LIMIT 5000', ...p);
      const ACT = { create: 'إنشاء', update: 'تعديل', delete: 'حذف', approve: 'اعتماد', reject: 'رفض', login: 'دخول', export: 'تصدير' };
      return {
        columns: [
          { key: 'when', header: 'التاريخ والوقت', width: 26 }, { key: 'user_name', header: 'المستخدم' },
          { key: 'action', header: 'الإجراء' }, { key: 'entity', header: 'العنصر' },
          { key: 'summary', header: 'التفصيل', width: 50 }, { key: 'ip', header: 'العنوان' }
        ],
        rows: raw.map(r => ({
          when: `${toHijri(r.created_at)} — ${new Date(r.created_at).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}`,
          user_name: r.user_name || 'النظام', action: ACT[r.action] || r.action,
          entity: r.entity, summary: r.summary, ip: r.ip || '—'
        })),
        summary: [{ label: 'عدد العمليات', value: raw.length }]
      };
    }
  }
};

export async function runReport(app, ctx, key, filters = {}) {
  const def = REPORTS[key];
  if (!def) throw new Error('تقرير غير معروف');
  const clean = {};
  for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== null && v !== undefined) clean[k] = v;
  if (!clean.term_id && def.filters.some(f => f.key === 'term_id')) {
    const t = await currentTerm(app, ctx.tenantId); if (t) clean.term_id = t.id;
  }
  const out = await def.run(app, ctx, clean);

  const labelOf = async (k, v) => {
    if (k === 'branch_id') return (await app.db.get('SELECT name FROM branches WHERE id=?', v))?.name || v;
    if (k === 'term_id') return (await app.db.get('SELECT name FROM terms WHERE id=?', v))?.name || v;
    if (k === 'user_id') return (await app.db.get('SELECT name FROM users WHERE id=?', v))?.name || v;
    const fd = def.filters.find(f => f.key === k);
    return fd?.options?.find(o => String(o.value) === String(v))?.label || v;
  };
  const applied = [];
  for (const [k, v] of Object.entries(clean)) {
    applied.push({ label: def.filters.find(f => f.key === k)?.label || k, value: await labelOf(k, v) });
  }
  return { ...out, applied_filters: applied };
}
