import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeParams, splitStatements } from '../core/sql.js';

/** محوّل better-sqlite3 — يقدّم الواجهة غير المتزامنة نفسها التي يقدّمها D1 */
export function createNodeDB(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  const prep = (sql) => db.prepare(sql);

  return {
    dialect: 'sqlite',
    raw: db,
    async get(sql, ...params) { return prep(sql).get(...normalizeParams(params)) ?? null; },
    async all(sql, ...params) { return prep(sql).all(...normalizeParams(params)); },
    async run(sql, ...params) {
      const r = prep(sql).run(...normalizeParams(params));
      return { lastId: Number(r.lastInsertRowid), changes: r.changes };
    },
    async batch(statements) {
      const tx = db.transaction((list) => list.map(([sql, params = []]) => {
        const st = prep(sql);
        if (/^\s*(select|with)/i.test(sql)) return { results: st.all(...normalizeParams(params)), lastId: 0, changes: 0 };
        const r = st.run(...normalizeParams(params));
        return { results: [], lastId: Number(r.lastInsertRowid), changes: r.changes };
      }));
      return tx(statements);
    },
    async exec(script) { db.exec(script); },
    async close() { try { db.close(); } catch {} },
    async backup(target) { return db.backup(target); }
  };
}
