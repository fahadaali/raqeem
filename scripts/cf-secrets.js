/**
 * يولّد الأسرار المطلوبة على Cloudflare ويرفعها بأمر واحد.
 *   npm run cf:secrets            — يعرض الأوامر والقيم المولَّدة (لا يرفع شيئاً)
 *   npm run cf:secrets -- --put   — يرفعها فعلياً عبر wrangler secret put
 *   npm run cf:secrets -- --put --env staging
 */
import { spawnSync } from 'node:child_process';
import { generateVAPIDKeys } from '../server/core/webpush.js';

const args = process.argv.slice(2).filter(a => a !== '--');
const doPut = args.includes('--put');
const envIdx = args.indexOf('--env');
const envName = envIdx >= 0 ? args[envIdx + 1] : '';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomSecret = (bytes = 48) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const vapid = await generateVAPIDKeys();

const secrets = {
  JWT_SECRET: randomSecret(48),
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  BOOTSTRAP_TOKEN: randomSecret(24)
};

console.log('\n▸ الأسرار المولَّدة لمنصة رقيم على Cloudflare\n');
for (const [k, v] of Object.entries(secrets)) console.log(`  ${k.padEnd(20)} = ${v}`);

if (!doPut) {
  console.log('\n▸ لرفعها إلى Cloudflare نفّذ:\n');
  for (const [k, v] of Object.entries(secrets)) {
    console.log(`  echo -n "${v}" | npx wrangler secret put ${k}${envName ? ' --env ' + envName : ''}`);
  }
  console.log('\n  أو مباشرةً:  npm run cf:secrets -- --put\n');
  console.log('  ⚠ احتفظ بمفتاح VAPID العام والخاص — تغييرهما يُبطل كل اشتراكات الإشعارات القائمة.\n');
  process.exit(0);
}

for (const [k, v] of Object.entries(secrets)) {
  const argv = ['wrangler', 'secret', 'put', k, ...(envName ? ['--env', envName] : [])];
  const r = spawnSync('npx', argv, { input: v, stdio: ['pipe', 'inherit', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(`✘ فشل رفع ${k}`); process.exit(1); }
  console.log(`✔ ${k}`);
}
console.log('\n✔ رُفعت كل الأسرار. احتفظ بمفتاحَي VAPID في مكان آمن.\n');
