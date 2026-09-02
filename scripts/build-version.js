/**
 * يولّد `web/version.js` — ختمَ الإصدار الذي يقرؤه عامل الخدمة والواجهة.
 *
 *   npm run gen:version
 *
 * لماذا ملفٌّ مولَّد لا ثابتٌ في `sw.js`؟ لأن ثابتاً يُرفَع باليد يُنسى، فتُنشَر
 * نسخةٌ جديدة وعامل الخدمة على المتصفّح لا يرى فرقاً ولا يطلب تحديثاً — ويبقى
 * المستخدم على النسخة القديمة حتى يحذف التطبيق ويثبّته من جديد. أمّا ختمٌ
 * يتغيّر مع كل نشرٍ آلياً (رقم الحزمة + الإيداع) فيختلف الملفّ الذي يستورده
 * العامل بايتاً واحداً على الأقل، فيراه المتصفّح تحديثاً ويُعلَم به المستخدم.
 *
 * على Node يُخدَم الملفّ إن وُجد، وإلّا يُركَّب ختمُ تطويرٍ من لحظة الإقلاع —
 * فلا يُلزَم المطوّر بتوليده. وعلى Cloudflare يولّده `npm run cf:build` قبل
 * النشر، فيُرفَع مع بقية الملفّات الثابتة.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT } from '../server/node/env.js';

const OUT = path.join(ROOT, 'web/version.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* الإيداع من بيئة النشر أولاً، ثم من المستودع، وإلّا طابعٌ زمنيّ */
function commit() {
  const fromEnv = (process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || '').slice(0, 7);
  if (fromEnv) return fromEnv;
  try { return execSync('git rev-parse --short=7 HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return Date.now().toString(36); }
}

export function buildVersionSource({ version = pkg.version, build = commit(), builtAt = new Date().toISOString() } = {}) {
  return [
    '/* مولَّد آلياً بـ `npm run gen:version` — لا يُعدَّل يدوياً ولا يُودَع في المستودع */',
    `self.RAQEEM_VERSION = ${JSON.stringify(`${version}+${build}`)};`,
    `self.RAQEEM_BUILT_AT = ${JSON.stringify(builtAt)};`,
    ''
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const src = buildVersionSource();
  fs.writeFileSync(OUT, src, 'utf8');
  console.log(`✔ ${path.relative(ROOT, OUT)}  ${src.match(/RAQEEM_VERSION = "([^"]+)"/)[1]}`);
}
