/**
 * الربط الفعلي مع Cloudflare بأمر واحد.
 *
 *   npm run cf:link                 — ينفّذ السلسلة كاملةً
 *   npm run cf:link -- --dry        — يعرض ما سيفعله دون تنفيذ
 *   npm run cf:link -- --rotate     — يعيد توليد الأسرار (يُبطل اشتراكات الإشعارات!)
 *   npm run cf:link -- --name نور   — اسم عامل مختلف
 *
 * السلسلة: تحقّق من الدخول ← قاعدة D1 ← دلو R2 ← الأسرار ← المخطط ← النشر ←
 *          ضبط APP_URL ← التهيئة الأولى ← فحص الصحة.
 *
 * السكربت صالح لإعادة التشغيل: يكتشف ما أُنشئ سابقاً فلا يكرّره.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVAPIDKeys } from '../server/core/webpush.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = path.join(ROOT, 'wrangler.toml');
const VAULT = path.join(ROOT, '.cf-secrets.json');

const args = process.argv.slice(2).filter(a => a !== '--');
const DRY = args.includes('--dry');
const ROTATE = args.includes('--rotate');
const nameIdx = args.indexOf('--name');
const WORKER = nameIdx >= 0 ? args[nameIdx + 1] : null;

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
let step = 0;
const head = (t) => console.log(`\n${C.b}▸ ${++step}. ${t}${C.x}`);
const ok = (t) => console.log(`   ${C.g}✔${C.x} ${t}`);
const info = (t) => console.log(`   ${C.d}${t}${C.x}`);
const warn = (t) => console.log(`   ${C.y}⚠${C.x} ${t}`);
const die = (t, hint) => {
  console.error(`\n   ${C.r}✘ ${t}${C.x}`);
  if (hint) console.error(`   ${C.d}${hint}${C.x}\n`);
  process.exit(1);
};

/**
 * ينفّذ wrangler ويعيد المخرجات.
 * `real` يتجاوز الوضع التجريبي: الأوامر القرائية تُنفَّذ فعلاً حتى في --dry،
 * وإلا صار التشغيل التجريبي يعلن نجاحاً كاذباً بدل أن يكشف العوائق مسبقاً.
 */
function wr(argv, { input, quiet = true, allowFail = false, real = false } = {}) {
  if (DRY && !real) { info(`[تجريبي] npx wrangler ${argv.join(' ')}`); return { code: 0, out: '', err: '' }; }
  const r = spawnSync('npx', ['wrangler', ...argv], {
    cwd: ROOT, input,
    encoding: 'utf8',
    stdio: quiet ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit']
  });
  const out = r.stdout || '', err = r.stderr || '';
  if (r.status !== 0 && !allowFail) {
    die(`فشل الأمر: wrangler ${argv.join(' ')}`, (err || out).trim().split('\n').slice(-6).join('\n   '));
  }
  return { code: r.status, out, err };
}

const readToml = () => fs.readFileSync(TOML, 'utf8');
const writeToml = (s) => { if (!DRY) fs.writeFileSync(TOML, s); };

/* ─────────── ١. التحقّق من الدخول ─────────── */
head('التحقّق من الدخول إلى Cloudflare');
{
  const who = wr(['whoami'], { allowFail: true, real: true });
  const txt = who.out + who.err;
  if (who.code !== 0 || /not authenticated|You are not logged in/i.test(txt)) {
    die('لست داخلاً إلى Cloudflare',
      'نفّذ:  npx wrangler login\n   أو اضبط رمز واجهة برمجية:  export CLOUDFLARE_API_TOKEN=…');
  }
  const email = (txt.match(/([\w.+-]+@[\w.-]+\.\w+)/) || [])[1];
  const acct = (txt.match(/([0-9a-f]{32})/) || [])[1];
  ok(`الحساب متاح${email ? ` — ${email}` : ''}`);
  if (acct) info(`معرّف الحساب: ${acct}`);
}

/* ─────────── ٢. اسم العامل ─────────── */
head('اسم العامل (Worker)');
let toml = readToml();
let workerName = (toml.match(/^name\s*=\s*"([^"]+)"/m) || [])[1];
if (WORKER && WORKER !== workerName) {
  toml = toml.replace(/^name\s*=\s*"[^"]+"/m, `name = "${WORKER}"`);
  writeToml(toml);
  workerName = WORKER;
  ok(`غُيّر اسم العامل إلى «${workerName}»`);
} else {
  ok(`اسم العامل: ${workerName}`);
}

/* ─────────── ٣. قاعدة البيانات D1 ─────────── */
head('قاعدة البيانات D1');
const DB_NAME = (toml.match(/\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/) || [])[1] || 'noor-db';
let dbId = null;
{
  const list = wr(['d1', 'list', '--json'], { allowFail: true, real: true });
  let rows = [];
  try { rows = JSON.parse(list.out.slice(list.out.indexOf('['))); } catch { /* قائمة فارغة أو تنسيق مختلف */ }
  const found = rows.find(d => d.name === DB_NAME);
  if (found) {
    dbId = found.uuid || found.database_id || found.id;
    ok(`القاعدة «${DB_NAME}» موجودة مسبقاً`);
  } else {
    info(`إنشاء «${DB_NAME}» ...`);
    wr(['d1', 'create', DB_NAME], { allowFail: true });
    const again = wr(['d1', 'list', '--json'], { allowFail: true });
    try {
      const rows2 = JSON.parse(again.out.slice(again.out.indexOf('[')));
      const f2 = rows2.find(d => d.name === DB_NAME);
      dbId = f2 && (f2.uuid || f2.database_id || f2.id);
    } catch { /* يُعالَج أدناه */ }
    if (DRY) { ok(`ستُنشأ القاعدة «${DB_NAME}»`); }
    else if (!dbId) die(`تعذّر الحصول على معرّف القاعدة «${DB_NAME}»`,
      'أنشئها يدوياً:  npx wrangler d1 create ' + DB_NAME + '\n   ثم ضع المعرّف في wrangler.toml');
    else ok(`أُنشئت القاعدة «${DB_NAME}»`);
  }
  if (dbId) {
    toml = toml.replace(/(\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*)"[^"]*"/,
      (_m, p1) => `${p1}"${dbId}"`);
    writeToml(toml);
    info(`المعرّف مكتوب في wrangler.toml: ${dbId}`);
  }
}

/* ─────────── ٤. دلو R2 ─────────── */
head('تخزين الملفات R2');
const BUCKET = (toml.match(/\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/) || [])[1] || 'noor-files';
{
  const list = wr(['r2', 'bucket', 'list'], { allowFail: true, real: true });
  if (new RegExp(`(^|\\s|")${BUCKET}(\\s|"|$)`, 'm').test(list.out)) {
    ok(`الدلو «${BUCKET}» موجود مسبقاً`);
  } else {
    const c = wr(['r2', 'bucket', 'create', BUCKET], { allowFail: true });
    if (c.code === 0) ok(`أُنشئ الدلو «${BUCKET}»`);
    else if (/already (exists|owned)/i.test(c.out + c.err)) ok(`الدلو «${BUCKET}» موجود مسبقاً`);
    else die(`تعذّر إنشاء الدلو «${BUCKET}»`,
      'تأكّد أن R2 مُفعَّل في حسابك من لوحة Cloudflare ← R2 ← Enable.');
  }
}

/* ─────────── ٥. الأسرار ─────────── */
head('الأسرار');
{
  const NEEDED = ['JWT_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'BOOTSTRAP_TOKEN'];
  const list = wr(['secret', 'list'], { allowFail: true, real: true });
  let existing = [];
  try { existing = JSON.parse(list.out.slice(list.out.indexOf('['))).map(s => s.name); } catch { /* أول نشر */ }

  const vault = fs.existsSync(VAULT) ? JSON.parse(fs.readFileSync(VAULT, 'utf8')) : {};
  const missing = NEEDED.filter(n => !existing.includes(n));

  if (!missing.length && !ROTATE) {
    ok('الأسرار الأربعة مرفوعة مسبقاً');
    if (vault.VAPID_PUBLIC_KEY) info('مفتاح VAPID العام محفوظ في .cf-secrets.json');
  } else {
    const toPut = ROTATE ? NEEDED : missing;
    if (ROTATE) warn('إعادة توليد VAPID تُبطل كل اشتراكات الإشعارات القائمة على أجهزة المستخدمين');

    const b64url = (b) => Buffer.from(b).toString('base64url');
    const rnd = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));
    const vapid = toPut.some(n => n.startsWith('VAPID')) ? await generateVAPIDKeys() : null;

    const values = {
      JWT_SECRET: vault.JWT_SECRET && !ROTATE ? vault.JWT_SECRET : rnd(48),
      VAPID_PUBLIC_KEY: vapid ? vapid.publicKey : vault.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: vapid ? vapid.privateKey : vault.VAPID_PRIVATE_KEY,
      BOOTSTRAP_TOKEN: vault.BOOTSTRAP_TOKEN && !ROTATE ? vault.BOOTSTRAP_TOKEN : rnd(24)
    };

    for (const n of toPut) {
      wr(['secret', 'put', n], { input: values[n] + '\n' });
      ok(`رُفع ${n}`);
    }
    if (!DRY) {
      fs.writeFileSync(VAULT, JSON.stringify({ ...vault, ...values }, null, 2));
      fs.chmodSync(VAULT, 0o600);
    }
    warn(`القيم محفوظة في .cf-secrets.json (غير مُتتبَّع في git) — احتفظ به، فمفتاحا VAPID لا يمكن استرجاعهما`);
  }
}

/* ─────────── ٦. المخطط والرؤوس ─────────── */
head('بناء المخطط ورؤوس الأمان');
{
  for (const s of ['cf:build:migrations', 'cf:build:headers']) {
    if (DRY) { info(`[تجريبي] npm run ${s}`); continue; }
    const r = spawnSync('npm', ['run', s], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) die(`فشل ${s}`, (r.stderr || r.stdout || '').trim().slice(-400));
  }
  ok('migrations/0001_init.sql و web/_headers محدَّثان');
}

/* ─────────── ٧. تطبيق المخطط على D1 ─────────── */
head('تطبيق المخطط على قاعدة D1 البعيدة');
{
  const r = wr(['d1', 'migrations', 'apply', DB_NAME, '--remote'], { input: 'y\n', allowFail: true });
  const txt = r.out + r.err;
  if (r.code !== 0 && !/No migrations to apply|already applied/i.test(txt)) {
    die('فشل تطبيق المخطط', txt.trim().split('\n').slice(-8).join('\n   '));
  }
  ok(/No migrations to apply/i.test(txt) ? 'المخطط مطبَّق مسبقاً' : 'طُبِّق المخطط');
}

/* ─────────── ٨. النشر ─────────── */
head('نشر العامل');
let appUrl = '';
{
  const r = wr(['deploy'], { allowFail: true });
  const txt = r.out + r.err;
  if (r.code !== 0) die('فشل النشر', txt.trim().split('\n').slice(-10).join('\n   '));
  appUrl = (txt.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0]
        || (txt.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0] || '';
  ok(appUrl ? `نُشر على ${appUrl}` : 'نُشر العامل');
}

/* ─────────── ٩. ضبط APP_URL ─────────── */
if (appUrl) {
  head('ضبط APP_URL');
  const cur = (toml.match(/APP_URL\s*=\s*"([^"]*)"/) || [])[1];
  if (cur === appUrl) {
    ok('APP_URL مضبوط مسبقاً');
  } else {
    toml = toml.replace(/(APP_URL\s*=\s*)"[^"]*"/, (_m, p1) => `${p1}"${appUrl}"`);
    writeToml(toml);
    info('إعادة نشر لتثبيت APP_URL ...');
    wr(['deploy'], { allowFail: true });
    ok(`APP_URL = ${appUrl}`);
  }
}

/* ─────────── ١٠. التهيئة الأولى ─────────── */
head('التهيئة الأولى (المخطط + بيانات المستأجر رقم ١)');
if (DRY) { info('[تجريبي] npm run cf:bootstrap -- ' + (appUrl || '<الرابط>')); }
else if (!appUrl) { warn('تعذّر استخراج الرابط — نفّذ التهيئة يدوياً:  npm run cf:bootstrap -- <الرابط>'); }
else {
  const vault = fs.existsSync(VAULT) ? JSON.parse(fs.readFileSync(VAULT, 'utf8')) : {};
  const r = spawnSync('node', ['scripts/cf-bootstrap.js', appUrl], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, BOOTSTRAP_TOKEN: vault.BOOTSTRAP_TOKEN || process.env.BOOTSTRAP_TOKEN || '' }
  });
  const txt = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !/مهيّأة|already/i.test(txt)) {
    warn('لم تكتمل التهيئة تلقائياً:');
    console.log('   ' + txt.trim().split('\n').slice(-6).join('\n   '));
    info(`أعِدها يدوياً:  BOOTSTRAP_TOKEN=… npm run cf:bootstrap -- ${appUrl}`);
  } else {
    ok('تمّت التهيئة');
    console.log(txt.split('\n').filter(l => l.includes('@')).map(l => '   ' + l.trim()).join('\n'));
  }
}

/* ─────────── ١١. فحص الصحة ─────────── */
head('فحص الصحة');
if (!DRY && appUrl) {
  let health = null;
  for (let i = 0; i < 6 && !health; i++) {
    try {
      const res = await fetch(appUrl + '/api/health');
      if (res.ok) health = await res.json();
    } catch { /* العامل ما زال ينتشر */ }
    if (!health) await new Promise(r => setTimeout(r, 2500));
  }
  if (!health) warn(`لم يستجب ${appUrl}/api/health بعد — جرّبه بعد دقيقة`);
  else {
    ok(`الخدمة تعمل — قاعدة: ${health.database} · تخزين: ${health.storage} · جهات: ${health.tenants}`);
    if (health.push !== true) warn('إشعارات الدفع غير مفعّلة — تأكّد من مفتاحَي VAPID');
  }
}

console.log(`\n${C.b}${'─'.repeat(58)}${C.x}`);
if (appUrl) {
  console.log(`  ${C.g}المنصة تعمل على:${C.x}  ${C.b}${appUrl}${C.x}`);
  console.log(`  ${C.d}غيّر كلمات المرور الافتراضية فوراً من الإعدادات.${C.x}`);
} else {
  console.log(`  ${C.y}اكتملت الخطوات — راجع الرسائل أعلاه.${C.x}`);
}
console.log(`${C.b}${'─'.repeat(58)}${C.x}\n`);
