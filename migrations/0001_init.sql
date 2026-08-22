-- ════════════════════════════════════════════════════════════════
--  منصة رقيم — مخطط قاعدة البيانات على Cloudflare D1
--  ⚠ مولَّد آلياً من server/core/schema.sql — لا تُعدّله يدوياً.
--    أعد توليده بـ:  npm run cf:build:migrations
-- ════════════════════════════════════════════════════════════════
PRAGMA foreign_keys = ON;

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
  calendar_default TEXT NOT NULL DEFAULT 'hijri',   
  status          TEXT NOT NULL DEFAULT 'active',   
  plan            TEXT NOT NULL DEFAULT 'phase1',
  settings        TEXT NOT NULL DEFAULT '{}',
  
  custom_domain   TEXT UNIQUE,                      
  owner_email     TEXT,
  suspended_at    TEXT,
  suspend_reason  TEXT,
  contact_name    TEXT,                             
  contact_phone   TEXT,
  crm_stage       TEXT,                             
  crm_source      TEXT,
  limit_overrides TEXT NOT NULL DEFAULT '{}',       
  feature_overrides TEXT NOT NULL DEFAULT '{}',     
  billing_entity  TEXT NOT NULL DEFAULT '{}',       
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  address         TEXT,
  lat             REAL,
  lng             REAL,
  geofence_radius INTEGER NOT NULL DEFAULT 50,      
  phone           TEXT,
  manager_user_id INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS ix_branches_tenant ON branches(tenant_id);

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
  level       INTEGER NOT NULL DEFAULT 10,          
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
  status            TEXT NOT NULL DEFAULT 'active',   
  calendar_pref     TEXT NOT NULL DEFAULT 'hijri',    
  theme_pref        TEXT NOT NULL DEFAULT 'light',
  notify_prefs      TEXT NOT NULL DEFAULT '{"push":true,"inapp":true,"tasks":true,"finance":true,"chat":true,"tickets":true,"hr":true}',
  must_change_pw    INTEGER NOT NULL DEFAULT 0,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,     
  totp_secret       TEXT,                           
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  totp_backup       TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS ix_users_tenant ON users(tenant_id);

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

CREATE TABLE IF NOT EXISTS terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',   
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
  status        TEXT NOT NULL DEFAULT 'queued', 
  created_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT
);

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
  items       TEXT NOT NULL DEFAULT '[]',  
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
  status       TEXT NOT NULL DEFAULT 'todo',   
  priority     TEXT NOT NULL DEFAULT 'medium', 
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
  date          TEXT NOT NULL,                       
  check_in_at   TEXT,
  check_out_at  TEXT,
  in_lat REAL, in_lng REAL, in_distance REAL,
  out_lat REAL, out_lng REAL, out_distance REAL,
  status        TEXT NOT NULL DEFAULT 'present',     
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
  status      TEXT NOT NULL DEFAULT 'pending',   
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
  status       TEXT NOT NULL DEFAULT 'draft',  
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

CREATE TABLE IF NOT EXISTS workflows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  doc_type   TEXT NOT NULL DEFAULT 'expense',   
  steps      TEXT NOT NULL DEFAULT '[]',        
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER,
  term_id   INTEGER,
  name      TEXT NOT NULL,
  category  TEXT,
  amount    REAL NOT NULL DEFAULT 0,
  spent     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

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
  status       TEXT NOT NULL DEFAULT 'pending', 
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_fin_scope ON finance_requests(tenant_id, branch_id, term_id, status);

CREATE TABLE IF NOT EXISTS finance_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  request_id  INTEGER NOT NULL REFERENCES finance_requests(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,
  step_name   TEXT,
  role_key    TEXT,
  approver_id INTEGER,
  action      TEXT,                              
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
  amount     REAL NOT NULL DEFAULT 0,
  vat        REAL NOT NULL DEFAULT 0,
  total      REAL NOT NULL DEFAULT 0,
  date       TEXT,
  file_id    INTEGER,
  status     TEXT NOT NULL DEFAULT 'recorded',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     INTEGER,
  storage_key   TEXT NOT NULL,   
  original_name TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  context       TEXT,
  uploaded_by   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_files_tenant ON files(tenant_id);

CREATE TABLE IF NOT EXISTS forms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL DEFAULT 'evaluation', 
  schema_json TEXT NOT NULL DEFAULT '{"fields":[]}',  
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
  period           TEXT NOT NULL,     
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

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    INTEGER,
  context_type TEXT NOT NULL,   
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
  status            TEXT NOT NULL DEFAULT 'open',    
  requester_id      INTEGER NOT NULL REFERENCES users(id),
  assignee_id       INTEGER REFERENCES users(id),
  sla_hours         INTEGER NOT NULL DEFAULT 24,
  sla_due_at        TEXT,
  first_response_at TEXT,
  escalated         INTEGER NOT NULL DEFAULT 0,
  escalated_at      TEXT,
  vendor_escalated  INTEGER NOT NULL DEFAULT 0,     
  vendor_escalated_at TEXT,
  vendor_status     TEXT,                           
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

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',  
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  branch_id  INTEGER,
  user_id    INTEGER,
  user_name  TEXT,
  role_key   TEXT,
  action     TEXT NOT NULL,       
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

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: سجلات التدقيق غير قابلة للتعديل'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_logs
WHEN (SELECT COUNT(*) FROM tenants WHERE id = OLD.tenant_id) > 0
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: سجلات التدقيق غير قابلة للحذف'); END;

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id   INTEGER,
  type        TEXT NOT NULL,     
  file_name   TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',  
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
  status       TEXT NOT NULL DEFAULT 'queued',  
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
  max_branches   INTEGER,          
  max_users      INTEGER,
  max_storage_mb INTEGER,
  features       TEXT NOT NULL DEFAULT '[]',   
  perks          TEXT NOT NULL DEFAULT '[]',   
  is_public      INTEGER NOT NULL DEFAULT 1,   
  is_active      INTEGER NOT NULL DEFAULT 1,
  highlight      INTEGER NOT NULL DEFAULT 0,   
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id            INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id              INTEGER NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL DEFAULT 'trialing',  
  cycle                TEXT NOT NULL DEFAULT 'monthly',   
  trial_ends_at        TEXT,
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at          TEXT,
  grace_until          TEXT,        
  credit_balance       REAL NOT NULL DEFAULT 0,   
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
  status          TEXT NOT NULL DEFAULT 'open',   
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
  
  doc_type        TEXT NOT NULL DEFAULT 'invoice',  
  parent_id       INTEGER REFERENCES subscription_invoices(id) ON DELETE SET NULL,
  credit_applied  REAL NOT NULL DEFAULT 0,          
  proration       TEXT,                             
  coupon_code     TEXT,
  po_number       TEXT,                             
  buyer           TEXT NOT NULL DEFAULT '{}',       
  
  zatca_uuid      TEXT,
  zatca_qr        TEXT,                             
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
  method       TEXT NOT NULL DEFAULT 'bank_transfer',  
  reference    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',        
  file_id      INTEGER REFERENCES files(id) ON DELETE SET NULL,   
  gateway        TEXT,                              
  gateway_ref    TEXT,
  gateway_status TEXT,
  declared_by  INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_subpay_invoice ON subscription_payments(invoice_id);

CREATE TABLE IF NOT EXISTS signups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL,                  
  tenant_name    TEXT NOT NULL,
  admin_name     TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  plan_code      TEXT NOT NULL,
  cycle          TEXT NOT NULL DEFAULT 'monthly',
  status         TEXT NOT NULL DEFAULT 'pending', 
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

CREATE TABLE IF NOT EXISTS platform_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  platform_name      TEXT NOT NULL DEFAULT 'منصة رقيم',
  platform_name_en   TEXT DEFAULT 'Raqeem Platform',
  tagline            TEXT DEFAULT 'منصة الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم',
  support_email      TEXT DEFAULT 'support@raqeem.sa',
  support_phone      TEXT,
  saas_enabled       INTEGER NOT NULL DEFAULT 0,   
  signup_enabled     INTEGER NOT NULL DEFAULT 0,   
  signup_needs_review INTEGER NOT NULL DEFAULT 0,  
  default_plan_code  TEXT NOT NULL DEFAULT 'growth',
  trial_days         INTEGER NOT NULL DEFAULT 14,
  grace_days         INTEGER NOT NULL DEFAULT 7,   
  vat_rate           REAL NOT NULL DEFAULT 15,
  currency           TEXT NOT NULL DEFAULT 'SAR',
  vat_number         TEXT,
  cr_number          TEXT,
  bank_details       TEXT NOT NULL DEFAULT '{}',   
  invoice_prefix     TEXT NOT NULL DEFAULT 'RQM',
  invoice_seq        INTEGER NOT NULL DEFAULT 0,
  seller_address     TEXT NOT NULL DEFAULT '{}',   
  zatca_enabled      INTEGER NOT NULL DEFAULT 0,   
  payment_gateway    TEXT NOT NULL DEFAULT 'manual',
  gateway_config     TEXT NOT NULL DEFAULT '{}',
  require_2fa_admins INTEGER NOT NULL DEFAULT 0,   
  health_idle_days   INTEGER NOT NULL DEFAULT 14,  
  upsell_threshold   INTEGER NOT NULL DEFAULT 80,  
  landing            TEXT NOT NULL DEFAULT '{}',   
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

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

CREATE TABLE IF NOT EXISTS platform_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date               TEXT NOT NULL UNIQUE,        
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
  revenue_collected  REAL NOT NULL DEFAULT 0,     
  outstanding_due    REAL NOT NULL DEFAULT 0,
  new_tenants        INTEGER NOT NULL DEFAULT 0,  
  churned_tenants    INTEGER NOT NULL DEFAULT 0,
  trials_converted   INTEGER NOT NULL DEFAULT 0,
  active_tenants_7d  INTEGER NOT NULL DEFAULT 0,  
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_pmetrics_date ON platform_metrics(date);

CREATE TABLE IF NOT EXISTS job_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',   
  trigger      TEXT NOT NULL DEFAULT 'cron',      
  actor_id     INTEGER REFERENCES users(id),
  actor_name   TEXT,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  duration_ms  INTEGER,
  result       TEXT,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS ix_jobruns ON job_runs(job, started_at);

CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  body          TEXT,
  url           TEXT,
  severity      TEXT NOT NULL DEFAULT 'info',      
  audience      TEXT NOT NULL DEFAULT 'all',       
  audience_value TEXT,
  banner        INTEGER NOT NULL DEFAULT 0,        
  push          INTEGER NOT NULL DEFAULT 1,        
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

CREATE TABLE IF NOT EXISTS coupons (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'percent',   
  value            REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'SAR',
  duration         TEXT NOT NULL DEFAULT 'once',      
  duration_months  INTEGER,
  applies_to       TEXT NOT NULL DEFAULT '[]',        
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

CREATE TABLE IF NOT EXISTS platform_admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_backup   TEXT,
  last_login_at TEXT,
  created_by    INTEGER REFERENCES platform_admins(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_admins_email ON platform_admins(lower(email));

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
