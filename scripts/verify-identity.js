/**
 * فحص الانحراف عن دليل الهوية البصرية — `docs/IDENTITY.md`.
 *
 * يُشغَّل قبل كل دمج: `npm run verify:identity`
 *
 * يفحص خمسة أشياء لا يمسكها المراجع البشري بالعين:
 *   ١) قيم ألوان مباشرة خارج كتلة التوكنز
 *   ٢) رموز تعبيرية ومحارف أيقونات في ملفات الواجهة
 *   ٣) خصائص اتجاه فيزيائية (يسار/يمين) في CSS
 *   ٤) أسماء أيقونات مستعملة وغير معرّفة في `web/js/icons.js`
 *   ٥) خطوط خارج خطَّي الهوية
 *
 * الاستثناءات تُكتب هنا صراحةً لا في مواضع متفرّقة، فيبقى الفحص قابلاً للقراءة.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/node/env.js';

const CSS = path.join(ROOT, 'web/css/app.css');
const ICONS = path.join(ROOT, 'web/js/icons.js');

/* ── جمع الملفات ─────────────────────────────────────────────── */
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else out.push(p);
  }
  return out;
};
const rel = (p) => path.relative(ROOT, p);
const webJs = walk(path.join(ROOT, 'web/js')).filter(p => p.endsWith('.js'));
const webHtml = walk(path.join(ROOT, 'web')).filter(p => p.endsWith('.html'));

const findings = [];
const flag = (file, line, rule, detail) => findings.push({ file: rel(file), line, rule, detail });

/* ── ١) قيم ألوان مباشرة خارج كتلة التوكنز ──────────────────── */
{
  const css = fs.readFileSync(CSS, 'utf8').split('\n');
  /* الكتل التي يُسمح فيها بالقيم — هي مصدر التوكنز نفسه */
  const tokenBlocks = [/^:root\{/, /^\[data-theme="dark"\]\{/, /^\.admin-mode\{/];
  let inToken = false;
  const colorRe = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g;
  css.forEach((l, i) => {
    if (tokenBlocks.some(re => re.test(l))) inToken = true;
    const isTokenLine = inToken;
    if (inToken && /\}\s*$/.test(l) && !/^\s*--/.test(l) && !tokenBlocks.some(re => re.test(l))) inToken = false;
    if (tokenBlocks.some(re => re.test(l))) { /* السطر الأول من الكتلة */ }
    if (isTokenLine) return;
    /* data: URI لأيقونة لوسايد داخل mask — هندسة لا لون */
    if (l.includes('data:image/svg+xml')) return;
    for (const m of l.match(colorRe) || []) flag(CSS, i + 1, 'لون مباشر', m);
  });

  /* والقيم المضمّنة في `style` داخل جافاسكربت الواجهة */
  for (const f of webJs) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (!/style\s*:|\.style\./.test(l)) return;
      for (const m of l.match(/#[0-9a-fA-F]{3,8}\b/g) || []) flag(f, i + 1, 'لون مباشر', m);
    });
  }
}

/* ── ٢) رموز تعبيرية ومحارف أيقونات ─────────────────────────── */
{
  /* محارف تُستعمل مكان الأيقونات — ممنوعة. والفواصل الزخرفية في التعليقات مستثناة. */
  const banned = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2600}-\u{26FF}\u{2460}-\u{24FF}\u{FF0B}]/gu;
  const allowed = new Set(['═', '─', '←', '→', '⇒', '•', '↔']);   /* رسم الصناديق والأسهم في التعليقات */
  const isComment = (l) => /^\s*(\/\*|\*|\/\/)/.test(l) || /^\s*<!--/.test(l);
  for (const f of [...webJs, ...webHtml]) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (isComment(l)) return;
      for (const m of l.match(banned) || []) {
        if (allowed.has(m)) continue;
        flag(f, i + 1, 'رمز تعبيري', m);
      }
    });
  }
}

/* ── ٣) خصائص اتجاه فيزيائية في CSS ─────────────────────────── */
{
  const physical = /(^|[;{\s])(margin|padding|border)-(left|right)\s*:|(^|[;{\s])(left|right)\s*:|text-align\s*:\s*(left|right)\b/;
  fs.readFileSync(CSS, 'utf8').split('\n').forEach((l, i) => {
    if (/^\s*(\/\*|\*)/.test(l)) return;
    /* التمركز الهندسي وكتل الشيفرة اللاتينية تُستثنى بوسم `rtl-ok` في تعليق على السطر نفسه */
    if (/\/\*\s*rtl-ok/.test(l)) return;
    if (physical.test(l)) flag(CSS, i + 1, 'اتجاه فيزيائي', l.trim().slice(0, 80));
  });
}

/* ── ٤) أسماء أيقونات غير معرّفة ────────────────────────────── */
{
  const src = fs.readFileSync(ICONS, 'utf8');
  const defined = new Set([...src.matchAll(/^\s{2}'([a-z0-9-]+)':/gm)].map(m => m[1]));
  if (!defined.size) flag(ICONS, 1, 'أيقونات', 'تعذّرت قراءة أسماء الأيقونات');
  const useRe = /\bicon:\s*'([a-z][a-z0-9-]*)'|\bluIcon\('([a-z][a-z0-9-]*)'|\bicon\('([a-z][a-z0-9-]*)'|\biconSvg\('([a-z][a-z0-9-]*)'/g;
  for (const f of webJs) {
    if (f === ICONS) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      for (const m of l.matchAll(useRe)) {
        const name = m[1] || m[2] || m[3] || m[4];
        if (!defined.has(name)) flag(f, i + 1, 'أيقونة غير معرّفة', name);
      }
    });
  }
  /* وأسماء المزايا الافتراضية في الشاشة الرئيسية */
  const landing = path.join(ROOT, 'server/core/landing.js');
  fs.readFileSync(landing, 'utf8').split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/icon:\s*'([a-z][a-z0-9-]*)'/g)) {
      if (!defined.has(m[1])) flag(landing, i + 1, 'أيقونة غير معرّفة', m[1]);
    }
  });
}

/* ── ٥) خطوط خارج خطَّي الهوية ──────────────────────────────── */
{
  const ok = /Zain|IBM\+?\s?Plex\s?Sans\s?Arabic|inherit|var\(--font-|Segoe UI|Tahoma|system-ui|-apple-system|sans-serif|ui-monospace|SF Mono|Consolas|monospace|Noto Naskh Arabic/;
  fs.readFileSync(CSS, 'utf8').split('\n').forEach((l, i) => {
    const m = l.match(/font-family\s*:\s*([^;}]+)/);
    if (!m) return;
    for (const fam of m[1].split(',')) {
      const name = fam.trim().replace(/^["']|["']$/g, '');
      if (name && !ok.test(name)) flag(CSS, i + 1, 'خط خارج الهوية', name);
    }
  });
}

/* ── التقرير ─────────────────────────────────────────────────── */
const byRule = findings.reduce((a, f) => ((a[f.rule] ||= []).push(f), a), {});
const RULES = ['لون مباشر', 'رمز تعبيري', 'اتجاه فيزيائي', 'أيقونة غير معرّفة', 'خط خارج الهوية'];

console.log('\n▸ فحص الانحراف عن دليل الهوية — منصة رقيم\n');
for (const rule of RULES) {
  const list = byRule[rule] || [];
  if (!list.length) { console.log(`  ✔ ${rule}: لا انحراف`); continue; }
  console.log(`  ✘ ${rule}: ${list.length}`);
  for (const f of list.slice(0, 12)) console.log(`      ${f.file}:${f.line}  ${f.detail}`);
  if (list.length > 12) console.log(`      … و${list.length - 12} غيرها`);
}

if (findings.length) {
  console.log(`\n  المجموع: ${findings.length} انحراف — راجع docs/IDENTITY.md\n`);
  process.exit(1);
}
console.log('\n  ✔ الواجهة ملتزمة بدليل الهوية البصرية\n');
