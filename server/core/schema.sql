-- ==========================================================================
--  منصة رقيم — مخطط قاعدة البيانات
--  بنية متعددة المستأجرين (Multi-Tenant) جاهزة للتحول إلى SaaS
--  قاعدة إلزامية: كل جدول رئيسي يحمل العمود tenant_id
--  الطوابع الزمنية تُخزَّن دائماً بصيغة UTC ISO-8601 (البند ١١)
-- ==========================================================================

PRAGMA foreign_keys = ON;

-- ─────────────────────────── ١. المستأجرون (الجهات التعليمية) ───────────────
CREATE TABLE IF NOT EXISTS tenants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  name_en         TEXT,
  logo_url        TEXT,
  primary_color   TEXT NOT NULL DEFAULT '#0F5132',
  accent_color    TEXT NOT NULL DEFAULT '#C9A227',
  timezone        TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  locale          TEXT NOT NULL DEFAULT 'ar',
  calendar_default TEXT NOT NULL DEFAULT 'hijri',   -- hijri | gregorian
  status          TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  plan            TEXT NOT NULL DEFAULT 'phase1',
  settings        TEXT NOT NULL DEFAULT '{}',
  setup_dismissed_at TEXT,                          -- إخفاء بطاقة التجهيز الأولى
  -- المرحلة الثانية (SaaS)
  custom_domain   TEXT UNIQUE,                      -- نطاق الجهة الخاص (White-labeling)
  owner_email     TEXT,
  suspended_at    TEXT,
  suspend_reason  TEXT,
  contact_name    TEXT,                             -- متابعة تجارية
  contact_phone   TEXT,
  crm_stage       TEXT,                             -- lead|onboarding|active|at_risk|churned
  crm_source      TEXT,
  limit_overrides TEXT NOT NULL DEFAULT '{}',       -- تجاوزات حدود خاصة بالجهة
  feature_overrides TEXT NOT NULL DEFAULT '{}',     -- مزايا مفعّلة/معطّلة خارج الخطة
  billing_entity  TEXT NOT NULL DEFAULT '{}',       -- المشتري: الاسم، الرقم الضريبي، العنوان، أمر الشراء
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─────────────────────────── ٢. الفروع ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  address         TEXT,
  lat             REAL,
  lng             REAL,
  geofence_radius INTEGER NOT NULL DEFAULT 50,      -- بالمتر (البند ٥)
  phone           TEXT,
  manager_user_id INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_branches_tenant ON branches(tenant_id);

-- ─────────────────────────── ٣. الصلاحيات والأدوار (RBAC) ───────────────────
CREATE TABLE IF NOT EXISTS permissions (
  key         TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  level       INTEGER NOT NULL DEFAULT 10,          -- كلما قلّ الرقم زادت السلطة
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  tenant_id      INTEGER NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);
CREATE INDEX IF NOT EXISTS ix_roleperm_tenant ON role_permissions(tenant_id);

-- ─────────────────────────── ٤. المستخدمون ──────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT,
  national_id       TEXT,
  password_hash     TEXT NOT NULL,
  role_id           INTEGER NOT NULL REFERENCES roles(id),
  primary_branch_id INTEGER REFERENCES branches(id),
  avatar_url        TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  calendar_pref     TEXT NOT NULL DEFAULT 'hijri',    -- hijri | gregorian
  theme_pref        TEXT NOT NULL DEFAULT 'light',
  notify_prefs      TEXT NOT NULL DEFAULT '{"push":true,"inapp":true,"tasks":true,"finance":true,"chat":true,"tickets":true,"hr":true}',
  must_change_pw    INTEGER NOT NULL DEFAULT 0,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,     -- مالك المنصة (المرحلة الثانية)
  totp_secret       TEXT,                           -- تحقّق بخطوتين لمالك المنصة
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  totp_backup       TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS ix_users_tenant ON users(tenant_id);

-- جدول التقاطعات: المستخدم ← الفروع المصرّح له بها (البند ٢)
CREATE TABLE IF NOT EXISTS user_branches (
  tenant_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);
CREATE INDEX IF NOT EXISTS ix_userbranch_tenant ON user_branches(tenant_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_rt_user ON refresh_tokens(user_id);

-- ─────────────────────────── ٥. الفصول الدراسية / الفترات ───────────────────
CREATE TABLE IF NOT EXISTS terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | closed | archived
  is_current  INTEGER NOT NULL DEFAULT 0,
  closed_at   TEXT,
  closed_by   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_terms_tenant ON terms(tenant_id);

CREATE TABLE IF NOT EXISTS term_rollovers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  from_term_id  INTEGER NOT NULL REFERENCES terms(id),
  to_term_id    INTEGER NOT NULL REFERENCES terms(id),
  options       TEXT NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  created_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT
);

-- ─────────────────────────── ٦. اللجان والمهام ──────────────────────────────
CREATE TABLE IF NOT EXISTS committees (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER REFERENCES branches(id),
  term_id      INTEGER REFERENCES terms(id),
  name         TEXT NOT NULL,
  description  TEXT,
  lead_user_id INTEGER REFERENCES users(id),
  color        TEXT NOT NULL DEFAULT '#0F5132',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_committees_tenant ON committees(tenant_id, branch_id, term_id);

CREATE TABLE IF NOT EXISTS committee_members (
  tenant_id    INTEGER NOT NULL,
  committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in      TEXT NOT NULL DEFAULT 'عضو',
  PRIMARY KEY (committee_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  items       TEXT NOT NULL DEFAULT '[]',  -- [{title,description,offset_days,duration_days,priority,weight}]
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_templates_tenant ON task_templates(tenant_id);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER REFERENCES branches(id),
  term_id      INTEGER REFERENCES terms(id),
  committee_id INTEGER REFERENCES committees(id),
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'todo',   -- todo|in_progress|review|done|blocked
  priority     TEXT NOT NULL DEFAULT 'medium', -- low|medium|high|urgent
  assignee_id  INTEGER REFERENCES users(id),
  created_by   INTEGER REFERENCES users(id),
  start_date   TEXT,
  due_date     TEXT,
  completed_at TEXT,
  progress     INTEGER NOT NULL DEFAULT 0,
  weight       INTEGER NOT NULL DEFAULT 1,
  order_index  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_tasks_scope ON tasks(tenant_id, branch_id, term_id);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(tenant_id, assignee_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  tenant_id     INTEGER NOT NULL,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'FS',
  PRIMARY KEY (task_id, depends_on_id)
);

-- ─────────────────────────── ٧. الموارد البشرية والحضور ─────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     INTEGER REFERENCES branches(id),
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_no   TEXT,
  job_title     TEXT,
  department    TEXT,
  contract_type TEXT DEFAULT 'دوام كامل',
  hire_date     TEXT,
  contract_end  TEXT,
  basic_salary  REAL NOT NULL DEFAULT 0,
  allowances    REAL NOT NULL DEFAULT 0,
  bank_iban     TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_employees_tenant ON employees(tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     INTEGER REFERENCES branches(id),
  term_id       INTEGER REFERENCES terms(id),
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,                       -- YYYY-MM-DD (بتوقيت الجهة)
  check_in_at   TEXT,
  check_out_at  TEXT,
  in_lat REAL, in_lng REAL, in_distance REAL,
  out_lat REAL, out_lng REAL, out_distance REAL,
  status        TEXT NOT NULL DEFAULT 'present',     -- present|late|absent|leave
  minutes_worked INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, user_id, date)
);
CREATE INDEX IF NOT EXISTS ix_att_scope ON attendance(tenant_id, branch_id, date);

CREATE TABLE IF NOT EXISTS leaves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id   INTEGER,
  term_id     INTEGER,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'annual',
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  days        REAL NOT NULL DEFAULT 1,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected
  approved_by INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS advances (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id  INTEGER,
  term_id    INTEGER,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     REAL NOT NULL,
  remaining  REAL NOT NULL DEFAULT 0,
  installments INTEGER NOT NULL DEFAULT 1,
  reason     TEXT,
  date       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER,
  term_id      INTEGER,
  year         INTEGER NOT NULL,
  month        INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|paid
  total        REAL NOT NULL DEFAULT 0,
  generated_by INTEGER,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL,
  payroll_run_id    INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL,
  basic             REAL NOT NULL DEFAULT 0,
  allowances        REAL NOT NULL DEFAULT 0,
  absence_deduction REAL NOT NULL DEFAULT 0,
  late_deduction    REAL NOT NULL DEFAULT 0,
  advance_deduction REAL NOT NULL DEFAULT 0,
  other_deduction   REAL NOT NULL DEFAULT 0,
  net               REAL NOT NULL DEFAULT 0,
  details           TEXT NOT NULL DEFAULT '{}'
);

-- ─────────────────────────── ٨. النظام المالي ودورة الاعتمادات ──────────────
CREATE TABLE IF NOT EXISTS workflows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  doc_type   TEXT NOT NULL DEFAULT 'expense',   -- expense|custody|purchase|reimbursement
  steps      TEXT NOT NULL DEFAULT '[]',        -- [{name,role_key,min_amount,max_amount}]
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- الميزانية تُخصَّص على مستويين: الفرع واللجنة.
-- اللجنة تصرف كما يصرف الفرع — لها خطّتها وبندها — فبقاء التخصيص على الفرع
-- وحده كان يخلط صرف اللجان في وعاءٍ واحد فلا يُعرف نصيب كلٍّ منها.
-- والحقلان مستقلّان: بندٌ لفرعٍ بلا لجنة، أو للجنةٍ عابرةٍ للفروع، أو لهما معاً.
CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER,
  committee_id INTEGER REFERENCES committees(id),
  term_id      INTEGER,
  name         TEXT NOT NULL,
  category     TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  spent        REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_budgets_scope ON budgets(tenant_id, branch_id, committee_id, term_id);

CREATE TABLE IF NOT EXISTS finance_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER REFERENCES branches(id),
  term_id      INTEGER REFERENCES terms(id),
  number       TEXT,
  type         TEXT NOT NULL DEFAULT 'expense',
  title        TEXT NOT NULL,
  description  TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'SAR',
  requester_id INTEGER NOT NULL REFERENCES users(id),
  workflow_id  INTEGER REFERENCES workflows(id),
  budget_id    INTEGER REFERENCES budgets(id),
  current_step INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|in_review|approved|rejected|paid
  -- إغلاق العهدة: ما غُطّي بفواتير، وما بقي عجزاً، ومن اعتمد الإغلاق
  settle_status   TEXT,                          -- open|submitted|settled
  settled_amount  REAL NOT NULL DEFAULT 0,       -- مجموع الفواتير المرفوعة
  settle_note     TEXT,
  settled_by      INTEGER REFERENCES users(id),
  settled_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_fin_scope ON finance_requests(tenant_id, branch_id, term_id, status);
CREATE INDEX IF NOT EXISTS ix_fin_settle ON finance_requests(tenant_id, type, settle_status);

CREATE TABLE IF NOT EXISTS finance_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  request_id  INTEGER NOT NULL REFERENCES finance_requests(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,
  step_name   TEXT,
  role_key    TEXT,
  approver_id INTEGER,
  action      TEXT,                              -- approve|reject
  note        TEXT,
  acted_at    TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id  INTEGER,
  term_id    INTEGER,
  request_id INTEGER REFERENCES finance_requests(id) ON DELETE SET NULL,
  number     TEXT,
  vendor     TEXT,
  description TEXT,                               -- بيان الفاتورة: ما اشتُري
  amount     REAL NOT NULL DEFAULT 0,
  vat        REAL NOT NULL DEFAULT 0,
  total      REAL NOT NULL DEFAULT 0,
  date       TEXT,
  file_id    INTEGER,
  status     TEXT NOT NULL DEFAULT 'recorded',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─────────────────────────── ٩. الملفات (تخزين معزول بمعرّف الجهة) ──────────
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     INTEGER,
  storage_key   TEXT NOT NULL,   -- tenants/{tenant_id}/...
  original_name TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  context       TEXT,
  uploaded_by   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_files_tenant ON files(tenant_id);

-- ─────────────────────────── ١٠. النماذج والتقييم ───────────────────────────
CREATE TABLE IF NOT EXISTS forms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL DEFAULT 'evaluation', -- evaluation|survey|form
  schema_json TEXT NOT NULL DEFAULT '{"fields":[]}',  -- بنية JSONB مرنة (البند ٧)
  target_role TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id       INTEGER,
  term_id         INTEGER,
  form_id         INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  subject_user_id INTEGER,
  submitted_by    INTEGER,
  answers         TEXT NOT NULL DEFAULT '{}',
  score           REAL,
  max_score       REAL,
  submitted_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_subs_scope ON form_submissions(tenant_id, form_id, subject_user_id);

CREATE TABLE IF NOT EXISTS kpis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        INTEGER NOT NULL,
  branch_id        INTEGER,
  term_id          INTEGER,
  user_id          INTEGER,
  committee_id     INTEGER,
  period           TEXT NOT NULL,     -- YYYY-MM أو 'term'
  tasks_total      INTEGER NOT NULL DEFAULT 0,
  tasks_done       INTEGER NOT NULL DEFAULT 0,
  tasks_overdue    INTEGER NOT NULL DEFAULT 0,
  completion_rate  REAL NOT NULL DEFAULT 0,
  attendance_rate  REAL NOT NULL DEFAULT 0,
  eval_avg         REAL NOT NULL DEFAULT 0,
  score            REAL NOT NULL DEFAULT 0,
  computed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, user_id, committee_id, term_id, period)
);

-- ─────────────────────────── ١١. التواصل السياقي والتذاكر ───────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER,
  context_type TEXT NOT NULL,   -- task|finance_request|invoice|ticket|committee|direct
  context_id   INTEGER NOT NULL,
  title        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, context_type, context_id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  tenant_id       INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TEXT,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  attachments     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(tenant_id, conversation_id, id);

CREATE TABLE IF NOT EXISTS tickets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id         INTEGER,
  number            TEXT,
  subject           TEXT NOT NULL,
  body              TEXT,
  category          TEXT NOT NULL DEFAULT 'general',
  priority          TEXT NOT NULL DEFAULT 'medium',
  status            TEXT NOT NULL DEFAULT 'open',    -- open|in_progress|resolved|closed
  requester_id      INTEGER NOT NULL REFERENCES users(id),
  assignee_id       INTEGER REFERENCES users(id),
  sla_hours         INTEGER NOT NULL DEFAULT 24,
  sla_due_at        TEXT,
  first_response_at TEXT,
  escalated         INTEGER NOT NULL DEFAULT 0,
  escalated_at      TEXT,
  vendor_escalated  INTEGER NOT NULL DEFAULT 0,     -- مُصعَّدة إلى مزوّد المنصة
  vendor_escalated_at TEXT,
  vendor_status     TEXT,                           -- open|answered|closed
  vendor_reply      TEXT,
  vendor_replied_at TEXT,
  closed_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_tickets_scope ON tickets(tenant_id, status);

CREATE TABLE IF NOT EXISTS ticket_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL,
  body        TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─────────────────────────── ١٢. التكامل ومفاتيح الربط ──────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  rate_limit   INTEGER NOT NULL DEFAULT 120,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─────────────────────────── ١٣. الإشعارات المتكاملة ────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',  -- tasks|finance|chat|tickets|hr|system
  title      TEXT NOT NULL,
  body       TEXT,
  url        TEXT,
  icon       TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  is_read    INTEGER NOT NULL DEFAULT 0,
  read_at    TEXT,
  pushed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(tenant_id, user_id, is_read, id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  platform     TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_push_user ON push_subscriptions(tenant_id, user_id);

-- ─────────────────────────── ١٤. سجلات التدقيق (Append-Only) ────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  branch_id  INTEGER,
  user_id    INTEGER,
  user_name  TEXT,
  role_key   TEXT,
  action     TEXT NOT NULL,       -- create|update|delete|login|approve|export...
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  summary    TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_scope ON audit_logs(tenant_id, created_at);

-- سجلات التدقيق غير قابلة للتعديل أو الحذف إطلاقاً (البند ١٤)
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: سجلات التدقيق غير قابلة للتعديل'); END;
-- الحذف ممنوع ما دامت الجهة قائمة. الاستثناء الوحيد هو محو الجهة بالكامل
-- (حق المحو في نظام حماية البيانات الشخصية) حيث تُحذف السجلات تبعاً لجهتها،
-- ويبقى أثر المحو نفسه مسجّلاً في platform_logs غير القابل للتعديل.
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_logs
WHEN (SELECT COUNT(*) FROM tenants WHERE id = OLD.tenant_id) > 0
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: سجلات التدقيق غير قابلة للحذف'); END;

-- ─────────────────────────── ١٥. الاستيراد وطوابير المعالجة ─────────────────
CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id   INTEGER,
  type        TEXT NOT NULL,     -- users|employees|branches|tasks|budgets|advances
  file_name   TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
  total_rows  INTEGER NOT NULL DEFAULT 0,
  ok_rows     INTEGER NOT NULL DEFAULT 0,
  error_rows  INTEGER NOT NULL DEFAULT 0,
  errors      TEXT NOT NULL DEFAULT '[]',
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result       TEXT,
  error        TEXT,
  run_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_jobs_pending ON job_queue(status, run_at);

-- ─────────────────────────── ١٦. الإعدادات لكل جهة ──────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  tenant_id INTEGER NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ══════════════════════════════════════════════════════════════════════════
--  تجميد الفصول المغلقة (Immutability) — البند ٣ من الوثيقة
--  أي سجل يحمل term_id لفصل مغلق/مؤرشف يُمنع تعديله أو حذفه أو الإضافة إليه
-- ══════════════════════════════════════════════════════════════════════════
CREATE TRIGGER IF NOT EXISTS trg_tasks_term_lock_u BEFORE UPDATE ON tasks
WHEN OLD.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = OLD.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_term_lock_d BEFORE DELETE ON tasks
WHEN OLD.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = OLD.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_term_lock_i BEFORE INSERT ON tasks
WHEN NEW.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = NEW.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_att_term_lock_u BEFORE UPDATE ON attendance
WHEN OLD.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = OLD.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_att_term_lock_i BEFORE INSERT ON attendance
WHEN NEW.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = NEW.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_fin_term_lock_u BEFORE UPDATE ON finance_requests
WHEN OLD.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = OLD.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_fin_term_lock_i BEFORE INSERT ON finance_requests
WHEN NEW.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = NEW.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_inv_term_lock_u BEFORE UPDATE ON invoices
WHEN OLD.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = OLD.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

CREATE TRIGGER IF NOT EXISTS trg_inv_term_lock_i BEFORE INSERT ON invoices
WHEN NEW.term_id IS NOT NULL
 AND (SELECT status FROM terms WHERE id = NEW.term_id) IN ('closed','archived')
BEGIN SELECT RAISE(ABORT, 'TERM_CLOSED'); END;

-- ═══════════════════════════════════════════════════════════════════════════
--  المرحلة الثانية (Phase 2) — طبقة الـ SaaS
--  التسجيل الآلي · خطط الأسعار والاشتراكات · نظام الفوترة · لوحة مالك المنصة
--  كل ما سبق كان مؤجَّلاً عمداً في المرحلة الأولى حسب المقدمة الاستراتيجية.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────── ١٦. خطط الأسعار والاشتراكات ───────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  name_en        TEXT,
  tagline        TEXT,
  description    TEXT,
  price_monthly  REAL NOT NULL DEFAULT 0,
  price_yearly   REAL NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'SAR',
  trial_days     INTEGER NOT NULL DEFAULT 14,
  max_branches   INTEGER,          -- NULL = بلا حد
  max_users      INTEGER,
  max_storage_mb INTEGER,
  features       TEXT NOT NULL DEFAULT '[]',   -- JSON: مفاتيح المزايا المفعّلة
  perks          TEXT NOT NULL DEFAULT '[]',   -- JSON: نقاط تسويقية تُعرض في صفحة الأسعار
  is_public      INTEGER NOT NULL DEFAULT 1,   -- تظهر في صفحة الأسعار العامة
  is_active      INTEGER NOT NULL DEFAULT 1,
  highlight      INTEGER NOT NULL DEFAULT 0,   -- «الأكثر اختياراً»
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id            INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id              INTEGER NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL DEFAULT 'trialing',  -- trialing|active|past_due|canceled|expired
  cycle                TEXT NOT NULL DEFAULT 'monthly',   -- monthly|yearly
  trial_ends_at        TEXT,
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at          TEXT,
  grace_until          TEXT,        -- مهلة السداد قبل الإيقاف
  credit_balance       REAL NOT NULL DEFAULT 0,   -- رصيد مُرحَّل من التناسب
  coupon_id            INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_until         TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_subs_status ON subscriptions(status, current_period_end);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  number          TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'open',   -- open|paid|void|uncollectible
  plan_code       TEXT,
  plan_name       TEXT,
  cycle           TEXT,
  period_start    TEXT,
  period_end      TEXT,
  subtotal        REAL NOT NULL DEFAULT 0,
  discount        REAL NOT NULL DEFAULT 0,
  vat_rate        REAL NOT NULL DEFAULT 15,
  vat_amount      REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'SAR',
  issued_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  due_at          TEXT,
  paid_at         TEXT,
  void_reason     TEXT,
  notes           TEXT,
  -- توسعة الفوترة
  doc_type        TEXT NOT NULL DEFAULT 'invoice',  -- invoice | credit_note
  parent_id       INTEGER REFERENCES subscription_invoices(id) ON DELETE SET NULL,
  credit_applied  REAL NOT NULL DEFAULT 0,          -- رصيد مُرحَّل خُصم من هذه الفاتورة
  proration       TEXT,                             -- JSON: تفصيل حساب التناسب
  coupon_code     TEXT,
  po_number       TEXT,                             -- أمر الشراء (الجهات الحكومية)
  buyer           TEXT NOT NULL DEFAULT '{}',       -- JSON: بيانات المشتري وقت الإصدار
  -- الفاتورة الإلكترونية (ZATCA)
  zatca_uuid      TEXT,
  zatca_qr        TEXT,                             -- TLV بترميز Base64
  zatca_hash      TEXT,
  zatca_prev_hash TEXT,
  zatca_xml_key   TEXT
);
CREATE INDEX IF NOT EXISTS ix_subinv_tenant ON subscription_invoices(tenant_id, issued_at);
CREATE INDEX IF NOT EXISTS ix_subinv_status ON subscription_invoices(status, due_at);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   INTEGER NOT NULL REFERENCES subscription_invoices(id) ON DELETE CASCADE,
  amount       REAL NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'SAR',
  method       TEXT NOT NULL DEFAULT 'bank_transfer',  -- bank_transfer|card|cash|manual
  reference    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',        -- pending|confirmed|rejected
  file_id      INTEGER REFERENCES files(id) ON DELETE SET NULL,   -- إيصال التحويل
  gateway        TEXT,                              -- manual|moyasar|tap|…
  gateway_ref    TEXT,
  gateway_status TEXT,
  declared_by  INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_subpay_invoice ON subscription_payments(invoice_id);

-- ─────────────────── ١٧. التسجيل الآلي للجهات الجديدة ───────────────────
CREATE TABLE IF NOT EXISTS signups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL,                  -- الرمز المطلوب للجهة (يصبح tenants.code)
  tenant_name    TEXT NOT NULL,
  admin_name     TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  plan_code      TEXT NOT NULL,
  cycle          TEXT NOT NULL DEFAULT 'monthly',
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|verified|provisioned|rejected
  verify_hash    TEXT,
  password_hash  TEXT NOT NULL,
  tenant_id      INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  reject_reason  TEXT,
  ip             TEXT,
  user_agent     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at    TEXT,
  provisioned_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_signups_status ON signups(status, created_at);

-- ──────────────────── ١٨. إعدادات المنصة وسجلّ مالكها ────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  platform_name      TEXT NOT NULL DEFAULT 'منصة رقيم',
  platform_name_en   TEXT DEFAULT 'Raqeem Platform',
  tagline            TEXT DEFAULT 'منصة الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم',
  support_email      TEXT DEFAULT 'support@raqeem.sa',
  support_phone      TEXT,
  saas_enabled       INTEGER NOT NULL DEFAULT 0,   -- تفعيل طبقة SaaS في الواجهات العامة
  signup_enabled     INTEGER NOT NULL DEFAULT 0,   -- فتح التسجيل الآلي
  signup_needs_review INTEGER NOT NULL DEFAULT 0,  -- مراجعة يدوية قبل التفعيل
  default_plan_code  TEXT NOT NULL DEFAULT 'growth',
  trial_days         INTEGER NOT NULL DEFAULT 14,
  grace_days         INTEGER NOT NULL DEFAULT 7,   -- مهلة السداد بعد الاستحقاق
  vat_rate           REAL NOT NULL DEFAULT 15,
  currency           TEXT NOT NULL DEFAULT 'SAR',
  vat_number         TEXT,
  cr_number          TEXT,
  bank_details       TEXT NOT NULL DEFAULT '{}',   -- JSON: اسم البنك، الآيبان، المستفيد
  invoice_prefix     TEXT NOT NULL DEFAULT 'RQM',
  invoice_seq        INTEGER NOT NULL DEFAULT 0,
  seller_address     TEXT NOT NULL DEFAULT '{}',   -- JSON: الشارع، الحي، المدينة، الرمز البريدي
  zatca_enabled      INTEGER NOT NULL DEFAULT 0,   -- توليد رمز QR وملف XML للفواتير
  payment_gateway    TEXT NOT NULL DEFAULT 'manual',
  gateway_config     TEXT NOT NULL DEFAULT '{}',
  maps_google_key    TEXT,                         -- مفتاح Map Tiles API — بدونه تعمل الخريطة على الطبقة المفتوحة
  require_2fa_admins INTEGER NOT NULL DEFAULT 0,   -- إلزام مالكي المنصة بالتحقق بخطوتين
  health_idle_days   INTEGER NOT NULL DEFAULT 14,  -- عتبة «جهة خاملة»
  upsell_threshold   INTEGER NOT NULL DEFAULT 80,  -- نسبة الاستهلاك التي تفتح فرصة ترقية
  landing            TEXT NOT NULL DEFAULT '{}',   -- JSON: محتوى الشاشة الرئيسية العامة
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- سجلّ عمليات مالك المنصة — مقفل ومنفصل عن سجلات الجهات (Append-only)
CREATE TABLE IF NOT EXISTS platform_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER REFERENCES users(id),
  actor_name TEXT,
  tenant_id  INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  summary    TEXT,
  meta       TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_platform_logs ON platform_logs(created_at);

CREATE TRIGGER IF NOT EXISTS trg_plog_no_update BEFORE UPDATE ON platform_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: سجل المنصة غير قابل للتعديل'); END;
CREATE TRIGGER IF NOT EXISTS trg_plog_no_delete BEFORE DELETE ON platform_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: سجل المنصة غير قابل للحذف'); END;

-- ═══════════════════════════════════════════════════════════════════════════
--  توسعة لوحة مالك المنصة — أربعة مستويات
--  ١) تفعيل مزايا الخطط · لقطات المؤشرات · سجل الوظائف · التناسب
--  ٢) صحة الجهات · البث والإعلانات · الدعم الموحّد · ملاحظات الجهة
--  ٣) الفاتورة الإلكترونية (ZATCA) · تحقّق بخطوتين · مراقبة الدخول
--  ٤) الكوبونات · الإشعارات الدائنة · بوابات الدفع · تجاوزات الحدود
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────── ١٩. لقطات مؤشرات المنصة (نمو وتسرّب) ───────────────
CREATE TABLE IF NOT EXISTS platform_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date               TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD
  tenants_total      INTEGER NOT NULL DEFAULT 0,
  tenants_active     INTEGER NOT NULL DEFAULT 0,
  tenants_suspended  INTEGER NOT NULL DEFAULT 0,
  subs_trialing      INTEGER NOT NULL DEFAULT 0,
  subs_active        INTEGER NOT NULL DEFAULT 0,
  subs_past_due      INTEGER NOT NULL DEFAULT 0,
  subs_canceled      INTEGER NOT NULL DEFAULT 0,
  subs_expired       INTEGER NOT NULL DEFAULT 0,
  mrr                REAL NOT NULL DEFAULT 0,
  arr                REAL NOT NULL DEFAULT 0,
  arpu               REAL NOT NULL DEFAULT 0,
  users_total        INTEGER NOT NULL DEFAULT 0,
  branches_total     INTEGER NOT NULL DEFAULT 0,
  storage_mb         REAL NOT NULL DEFAULT 0,
  revenue_collected  REAL NOT NULL DEFAULT 0,     -- تراكمي
  outstanding_due    REAL NOT NULL DEFAULT 0,
  new_tenants        INTEGER NOT NULL DEFAULT 0,  -- خلال اليوم
  churned_tenants    INTEGER NOT NULL DEFAULT 0,
  trials_converted   INTEGER NOT NULL DEFAULT 0,
  active_tenants_7d  INTEGER NOT NULL DEFAULT 0,  -- جهات بها نشاط خلال ٧ أيام
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_pmetrics_date ON platform_metrics(date);

-- ─────────────── ٢٠. سجل تشغيل الوظائف الدورية ───────────────
CREATE TABLE IF NOT EXISTS job_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',   -- running|success|failed
  trigger      TEXT NOT NULL DEFAULT 'cron',      -- cron|manual|system
  actor_id     INTEGER REFERENCES users(id),
  actor_name   TEXT,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  duration_ms  INTEGER,
  result       TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobruns ON job_runs(job, started_at);

-- ─────────────── ٢١. إعلانات المنصة والبث ───────────────
CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  body          TEXT,
  url           TEXT,
  severity      TEXT NOT NULL DEFAULT 'info',      -- info|warn|critical
  audience      TEXT NOT NULL DEFAULT 'all',       -- all|plan|status|tenant
  audience_value TEXT,
  banner        INTEGER NOT NULL DEFAULT 0,        -- شريط ثابت في واجهة الجهات
  push          INTEGER NOT NULL DEFAULT 1,        -- إرسال إشعار دفع أيضاً
  starts_at     TEXT,
  ends_at       TEXT,
  sent_at       TEXT,
  recipients    INTEGER NOT NULL DEFAULT 0,
  tenants_count INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_announce_window ON announcements(banner, starts_at, ends_at);

-- ─────────────── ٢٢. ملاحظات الجهة (متابعة تجارية خفيفة) ───────────────
CREATE TABLE IF NOT EXISTS tenant_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id),
  author_name TEXT,
  body        TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_tnotes ON tenant_notes(tenant_id, created_at);

-- ─────────────── ٢٣. محاولات الدخول (مراقبة أمنية عبر المنصة) ───────────────
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  tenant_id  INTEGER,
  user_id    INTEGER,
  success    INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_login_attempts ON login_attempts(created_at);
CREATE INDEX IF NOT EXISTS ix_login_attempts_email ON login_attempts(email, created_at);

-- ─────────────── ٢٤. الكوبونات والخصومات ───────────────
CREATE TABLE IF NOT EXISTS coupons (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'percent',   -- percent|fixed
  value            REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'SAR',
  duration         TEXT NOT NULL DEFAULT 'once',      -- once|forever|months
  duration_months  INTEGER,
  applies_to       TEXT NOT NULL DEFAULT '[]',        -- JSON: رموز الخطط (فارغ = الكل)
  max_redemptions  INTEGER,
  redemptions      INTEGER NOT NULL DEFAULT 0,
  valid_from       TEXT,
  valid_until      TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id  INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES subscription_invoices(id) ON DELETE SET NULL,
  amount_off REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_coupon_red ON coupon_redemptions(coupon_id, tenant_id);

-- ─────────────── ٢٥. هويّة مالكي المنصة (منفصلة عن المستأجرين) ───────────────
-- جدول مستقل بلا tenant_id: فاستحالة ظهور مالك المنصة في قوائم مستخدمي مجمّع،
-- أو حذفه تِبعاً لحذف مجمّع، تصير خاصيةً بنيويةً لا اتفاقاً يُنسى.
-- أسماء أعمدة totp_* تطابق users عمداً كي تعمل عليها دوال security.js نفسها.
CREATE TABLE IF NOT EXISTS platform_admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_backup   TEXT,
  last_login_at TEXT,
  created_by    INTEGER REFERENCES platform_admins(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_admins_email ON platform_admins(lower(email));

-- جلسات الادمن مستقلة: refresh_tokens لا تصلح لأن tenant_id فيها NOT NULL
-- و user_id مربوط بـ users ON DELETE CASCADE.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_admin_sessions ON admin_sessions(admin_id, revoked);

-- ═══ ٢٦. قوالب الفصول الدراسية (عامة: لا tenant_id) ═══════════════════════
-- تواريخ نسبية لا مطلقة (شهر/يوم البداية + المدّة)، فيصلح القالب لكل سنة دون تحرير.
CREATE TABLE IF NOT EXISTS term_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,                 -- رمز الفصل داخل المجمّع (T-1 …)
  name          TEXT NOT NULL,
  start_month   INTEGER NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_day     INTEGER NOT NULL CHECK (start_day BETWEEN 1 AND 31),
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 366),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_term_templates_code ON term_templates(code);
CREATE INDEX IF NOT EXISTS ix_term_templates_active ON term_templates(is_active, sort_order);
