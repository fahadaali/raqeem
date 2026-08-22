import { normalizeParams, splitStatements } from '../core/sql.js';

/** محوّل Cloudflare D1 — الواجهة نفسها المستخدمة في التشغيل الذاتي */
export function createD1(D1) {
  const bind = (sql, params) => {
    const st = D1.prepare(sql);
    const p = normalizeParams(params);
    return p.length ? st.bind(...p) : st;
  };

  return {
    dialect: 'd1',
    raw: D1,
    async get(sql, ...params) { return (await bind(sql, params).first()) ?? null; },
    async all(sql, ...params) { const r = await bind(sql, params).all(); return r.results || []; },
    async run(sql, ...params) {
      const r = await bind(sql, params).run();
      return { lastId: Number(r.meta?.last_row_id || 0), changes: r.meta?.changes || 0 };
    },
    async batch(statements) {
      if (!statements.length) return [];
      const res = await D1.batch(statements.map(([sql, params = []]) => bind(sql, params)));
      return res.map(r => ({
        results: r.results || [],
        lastId: Number(r.meta?.last_row_id || 0),
        changes: r.meta?.changes || 0
      }));
    },
    async exec(script) {
      // D1 لا يقبل سكربتاً متعدد الجمل دفعةً واحدة مع المُشغّلات، فنقسّمه
      const stmts = splitStatements(script);
      for (let i = 0; i < stmts.length; i += 40) {
        await D1.batch(stmts.slice(i, i + 40).map(sql => D1.prepare(sql)));
      }
    },
    async close() {}
  };
}
