/**
 * يولّد النسخة المضبَّبة من النمط الزخرفي — `npm run gen:pattern`
 *
 * النمط الأصل حادُّ الحواف، فيزاحم النصَّ فوقه ويشوّش العين. والضبابية تُخبز في
 * الملف نفسه (`feGaussianBlur`) لا تُضاف طبقةً في CSS: طبقةٌ فوق العنصر تحتاج
 * `::before` وسياقَ تكديس، وتنزلق في الحاويات التي تمرَّر، وتُقصّ عند الحواف.
 * والمخبوزة تعمل حيث تعمل الخلفية — في كل حاوية وفي الطباعة وبلا سطرٍ إضافي.
 *
 * والهندسة هي هندسة الأصل حرفاً بحرف: مربّعان بزوايا مدوّرة، أحدهما مُدار ٤٥
 * درجة حول مركز البلاطة. لا يُعاد رسم شيء — يُليَّن ما رُسم.
 *
 * والبلاطة تبقى متّصلة بلا فواصل: الشكل يقع بين ١٣٫٤ و٥٨٫٦ من بلاطةٍ ضلعها ٧٢،
 * ومدى الضبابية ثلاثة أضعاف انحرافها — فلا يبلغ حافّة البلاطة فلا تظهر درزة.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'web/assets/brand');

/* هندسة النمط — نسخةٌ طبق الأصل عن `pattern-overlay-*.svg` */
const MOTIF = (stroke, opacity, width) =>
  `<g fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}">`
  + `<rect x="20" y="20" width="32" height="32" rx="8"/>`
  + `<rect x="20" y="20" width="32" height="32" rx="8" transform="rotate(45 36 36)"/>`
  + `</g>`;

const soft = ({ stroke, opacity, width, blur }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">`
  + `<filter id="soften" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">`
  + `<feGaussianBlur stdDeviation="${blur}"/></filter>`
  + `<g filter="url(#soften)">${MOTIF(stroke, opacity, width)}</g>`
  + `</svg>\n`;

/* الحدّة تُعوَّض بسماكةٍ وشفافيةٍ أعلى قليلاً: الضبابية تفرّق الحبر فيبهت */
const FILES = [
  ['pattern-soft-cream.svg', { stroke: '#FBF7EF', opacity: '.26', width: 1.5, blur: 2 }],
  ['pattern-soft-green.svg', { stroke: '#2F8A6F', opacity: '.32', width: 1.5, blur: 2 }]
];

for (const [name, spec] of FILES) {
  fs.writeFileSync(path.join(DIR, name), soft(spec), 'utf8');
  console.log(`✔ web/assets/brand/${name}  (ضبابية ${spec.blur})`);
}
