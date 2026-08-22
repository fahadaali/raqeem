import { gzip } from '../zip.js';

/**
 * النسخ الاحتياطي المنطقي اليومي (البند ١٠) — يعمل على البيئتين:
 *   • Node       : يُحفظ في مجلّد التخزين المحلي إضافةً إلى نسخة ملف SQLite
 *   • Cloudflare : يُحفظ في دلو R2 تحت tenants/<tenant_id>/backups/
 *
 * الناتج ملف SQL مضغوط (gzip) قابل للاستعادة كما هو:
 *   npx wrangler d1 execute raqeem-db --remote --file=raqeem-YYYY-MM-DD.sql
 *   sqlite3 raqeem.db < raqeem-YYYY-MM-DD.sql
 *
 * الملف يرتّب الجداول حسب تبعية المفاتيح الأجنبية، ويُسقط مُشغّلات الحماية
 * (سجل التدقيق غير القابل للتعديل، وقفل الفصول المؤرشفة) قبل الإدراج
 * ثم يعيد إنشاءها بعده — وإلا منعت هذه المُشغّلات استعادةَ البيانات نفسها.
 */

/* جداول عامة (بلا tenant_id) وأخرى لا معنى لنسخها */
const GLOBAL_TABLES = new Set(['permissions', 'schema_meta']);
const SKIP_TABLES = new Set(['sqlite_sequence', 'job_queue', 'rate_limits', 'refresh_tokens', 'sessions']);

/*
 * التصدير المحصور بجهة واحدة (حق نقل البيانات) لا يجوز أن يتسرّب منه شيء
 * لجهة أخرى ولا لأسرار المنصة. الجداول بلا عمود tenant_id تُستبعَد كلها
 * ما لم يكن لها مفتاح ربط صريح بالجهة أدناه — فجدول `platform_settings`
 * وحده يحمل مفاتيح بوابة الدفع، و`tenants` بلا شرط يصدّر كل الجهات.
 */
const TENANT_KEY = { tenants: 'id' };

const quote = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const b = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    return `X'${[...b].map(x => x.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
};

const pragma = async (app, sql) => { try { return await app.db.all(sql); } catch { return []; } };

/** يرتّب الجداول بحيث يسبق الجدولُ المرجعيُّ الجداولَ التي تشير إليه */
async function orderByDependency(app, tables) {
  const deps = new Map();
  for (const t of tables) {
    const fks = await pragma(app, `PRAGMA foreign_key_list(${t})`);
    deps.set(t, new Set(fks.map(f => f.table).filter(x => x && x !== t && tables.includes(x))));
  }
  const out = [], done = new Set();
  /* ترتيب طوبولوجي بسيط مع كسر أي دورة بالترتيب الأبجدي */
  for (let pass = 0; pass < tables.length + 1 && done.size < tables.length; pass++) {
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every(d => done.has(d))) { out.push(t); done.add(t); }
    }
  }
  for (const t of tables) if (!done.has(t)) out.push(t);
  return out;
}

async function listTables(app) {
  const rows = await app.db.all(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`);
  return rows.map(r => r.name).filter(n => !SKIP_TABLES.has(n));
}

async function tableColumns(app, table) {
  return (await pragma(app, `PRAGMA table_info(${table})`)).map(c => c.name);
}

/**
 * ينتج نسخة SQL لبيانات جهة واحدة (أو كل الجهات إن لم يُحدَّد tenantId).
 * @returns {Promise<{sql:string, tables:number, rows:number}>}
 */
export async function dumpSQL(app, { tenantId = null } = {}) {
  const tables = await orderByDependency(app, await listTables(app));
  const triggers = (await app.db.all(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name`)) || [];

  const head = [
    '-- ══════════════════════════════════════════════════════════════',
    '--  منصة رقيم — نسخة احتياطية منطقية قابلة للاستعادة',
    `--  التاريخ : ${new Date().toISOString()}`,
    `--  الجهة   : ${tenantId ?? 'كل الجهات'}`,
    '--  الاستعادة: wrangler d1 execute raqeem-db --remote --file=<هذا الملف>',
    '-- ══════════════════════════════════════════════════════════════',
    '',
    '-- إسقاط مُشغّلات الحماية مؤقتاً كي لا تمنع استعادة البيانات',
    ...triggers.map(t => `DROP TRIGGER IF EXISTS ${t.name};`),
    ''
  ];

  const body = [];
  let rowCount = 0, tableCount = 0;

  for (const table of tables) {
    const cols = await tableColumns(app, table);
    if (!cols.length) continue;

    let rows;
    if (!tenantId || GLOBAL_TABLES.has(table)) {
      rows = await app.db.all(`SELECT * FROM ${table}`);
    } else {
      const key = cols.includes('tenant_id') ? 'tenant_id' : TENANT_KEY[table];
      if (!key || !cols.includes(key)) continue;   // لا رابط بالجهة ⇒ ليست بياناتها
      rows = await app.db.all(`SELECT * FROM ${table} WHERE ${key}=?`, tenantId);
    }
    if (!rows.length) continue;

    tableCount++;
    body.push(`-- ${table} (${rows.length})`);
    for (const row of rows) {
      const present = cols.filter(c => c in row);
      body.push(`INSERT OR REPLACE INTO ${table}(${present.join(',')}) VALUES(${present.map(c => quote(row[c])).join(',')});`);
      rowCount++;
    }
    body.push('');
  }

  const tail = [
    '-- إعادة إنشاء مُشغّلات الحماية',
    ...triggers.map(t => `${t.sql.trim().replace(/;+\s*$/, '')};`),
    ''
  ];

  return { sql: [...head, ...body, ...tail].join('\n'), tables: tableCount, rows: rowCount };
}

/**
 * ينفّذ النسخ الاحتياطي لجهة واحدة ويحفظه في التخزين المربوط (R2 أو محلي)
 * تحت مجلّد الجهة نفسه (عزل التخزين — المقدمة الاستراتيجية §٣) ثم ينظّف القديم.
 */
export async function runLogicalBackup(app, { tenantId, keep = null } = {}) {
  if (!app.storage) return { skipped: 'لا يوجد تخزين مربوط' };
  if (!tenantId) throw new Error('النسخ الاحتياطي يتطلّب معرّف الجهة');

  const { sql, tables, rows } = await dumpSQL(app, { tenantId });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = `tenants/${tenantId}/backups/`;
  const key = `${prefix}raqeem-${stamp}.sql.gz`;
  const body = await gzip(new TextEncoder().encode(sql));

  await app.storage.put(key, body, { contentType: 'application/gzip' });

  /* الاحتفاظ بأحدث N نسخة فقط */
  const limit = keep ?? app.cfg?.backup?.keep ?? 14;
  let removed = 0;
  if (app.storage.list) {
    for (const k of (await app.storage.list(prefix)).sort().reverse().slice(limit)) {
      await app.storage.remove(k);
      removed++;
    }
  }

  return { key, size: body.length, tables, rows, removed };
}

/** نسخ احتياطي لكل الجهات — يُستدعى من مؤقّت Cron اليومي */
export async function runDailyBackup(app) {
  if (app.cfg?.backup?.enabled === false) return { skipped: 'النسخ الاحتياطي معطّل' };
  const tenants = await app.db.all(`SELECT id FROM tenants WHERE status='active'`);
  const out = [];
  for (const t of tenants) out.push(await runLogicalBackup(app, { tenantId: t.id }));
  return { tenants: tenants.length, backups: out };
}
