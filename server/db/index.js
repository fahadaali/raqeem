import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/** now() → طابع زمني UTC موحّد (البند ١١: توحيد التخزين) */
export const nowUTC = () => new Date().toISOString();

/** تنفيذ داخل معاملة */
export const tx = (fn) => db.transaction(fn);

/** مساعد: قراءة حقل JSON بأمان */
export function j(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export const s = (obj) => JSON.stringify(obj ?? null);

export default db;
