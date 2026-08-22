import fs from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys } from '../server/core/webpush.js';
import { ROOT } from '../server/node/env.js';

const keys = await generateVAPIDKeys();
const envPath = path.join(ROOT, '.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8')
  : fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const set = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}`;
};
set('VAPID_PUBLIC_KEY', keys.publicKey);
set('VAPID_PRIVATE_KEY', keys.privateKey);
fs.writeFileSync(envPath, env);

console.log('✔ تم توليد مفاتيح إشعارات الدفع (VAPID) وحفظها في .env');
console.log('  المفتاح العام  :', keys.publicKey);
console.log('  للنشر على Cloudflare نفّذ:');
console.log('    npx wrangler secret put VAPID_PUBLIC_KEY');
console.log('    npx wrangler secret put VAPID_PRIVATE_KEY');
