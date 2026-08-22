/**
 * يولّد web/_headers الذي تقرأه شبكة Cloudflare عند تقديم الملفات الثابتة،
 * من المصدر نفسه المستخدَم في وسيط الأمان (server/core/http.js) — فلا يحدث انحراف.
 *   npm run cf:build:headers
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaderMap } from '../server/core/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/_headers');

const sec = securityHeaderMap({ env: 'production' });
const line = (k, v) => `  ${k}: ${v}`;

const content = [
  '# ⚠ مولَّد آلياً من securityHeaderMap() — لا تُعدّله يدوياً.',
  '#   أعد توليده بـ:  npm run cf:build:headers',
  '',
  '/*',
  ...Object.entries(sec).map(([k, v]) => line(k, v)),
  line('Cache-Control', 'no-cache, must-revalidate'),
  '',
  '/sw.js',
  line('Content-Type', 'application/javascript; charset=utf-8'),
  line('Service-Worker-Allowed', '/'),
  line('Cache-Control', 'no-cache, must-revalidate'),
  '',
  '/manifest.webmanifest',
  line('Content-Type', 'application/manifest+json; charset=utf-8'),
  line('Cache-Control', 'no-cache, must-revalidate'),
  '',
  '/icons/*',
  line('Cache-Control', 'public, max-age=604800'),
  '',
  '/css/*',
  line('Cache-Control', 'public, max-age=3600'),
  '',
  '/js/*',
  line('Cache-Control', 'public, max-age=3600'),
  ''
].join('\n');

fs.writeFileSync(OUT, content, 'utf8');
console.log(`✔ ${path.relative(ROOT, OUT)}  (${Object.keys(sec).length} رأس أمان)`);
