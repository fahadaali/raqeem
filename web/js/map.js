import { el, clear, AR_NUM } from './util.js';
import { icon as luIcon } from './icons.js';

/**
 * خريطة حقيقية بمربّعات OpenStreetMap — بلا مكتبةٍ خارجية.
 *
 * الشاشتان تحتاجانها: ضبطُ نطاق الفرع في الإعداد، ورؤيةُ المُحضِّر موقعَه من
 * الفرع. وكانت رسماً تخطيطياً: دائرةٌ وأيقونة، تقول «داخل النطاق» ولا تُري أين.
 *
 * ولا Leaflet: الحزمة ١٤٠ ك.ب وسياسة الأمان تمنع سكربتاً من خارج المصدر، فتُوضَع
 * في المستودع وتُصان. والمطلوب هنا أصغر من ذلك بكثير — مربّعاتٌ ثابتة ودائرةٌ
 * وعلامتان — فحُسبت رياضيات مركاتور هنا في مئة سطر.
 *
 * والخريطة تتمركز على الفرع دائماً، لا على المستخدم: فطلبُ المربّعات يكشف موضع
 * الفرع لا موضع الشخص، وموقعُه يُرسَم فوقها من جهازه ولا يغادره.
 */

const TILE = 256;
const SUB = ['a', 'b', 'c'];
/* حدُّ خطّ العرض في مركاتور — قطبٌ لا يُسقَط على مستوٍ */
const clampLat = (l) => Math.max(-85.05112878, Math.min(85.05112878, l));

/** إحداثيات جغرافية → إحداثيات مربّعات عند تكبيرٍ ما (كسرية) */
function project(lat, lng, z) {
  const n = 2 ** z;
  const rad = clampLat(lat) * Math.PI / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  };
}

/** أمتارٌ لكل بكسل عند خطّ عرضٍ وتكبير — ثابت الأرض ٦٣٧٨١٣٧ م */
const mPerPx = (lat, z) =>
  (2 * Math.PI * 6378137 * Math.cos(clampLat(lat) * Math.PI / 180)) / (TILE * 2 ** z);

/** المسافة بالأمتار — هافرساين، هي نفسها التي يحتسب بها الخادم */
export function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (bLat - aLat) * t, dLng = (bLng - aLng) * t;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** أنسب تكبيرٍ ليملأ قُطرُ النطاق نحو ٧٠٪ من الإطار */
function fitZoom(lat, radius, w, h) {
  const want = (Math.min(w, h) * 0.7) / (2 * Math.max(radius, 10));   /* بكسل لكل متر */
  for (let z = 19; z >= 3; z--) if (1 / mPerPx(lat, z) <= want) return z;
  return 16;
}

/**
 * @param {object}  o
 * @param {number}  o.lat        خط عرض الفرع
 * @param {number}  o.lng        خط طول الفرع
 * @param {number}  o.radius     نطاق التحضير بالأمتار
 * @param {object}  [o.me]       موقع المستخدم `{lat, lng, accuracy}` إن عُرف
 * @param {boolean} [o.editable] هل يُسحَب الدبّوس لضبط الموقع؟
 * @param {Function}[o.onMove]   يُستدعى بـ `{lat, lng}` بعد كل سحب
 * @param {number}  [o.height]   ارتفاع الإطار
 * @param {object}  [o.fallback] مركزٌ يُبدأ منه حين لا إحداثيات — للتحرير وحده
 */
export function geoMap({ lat, lng, radius = 50, me = null, editable = false, onMove, height = 260,
  fallback = { lat: 24.7136, lng: 46.6753 } }) {
  const box = el('div.geomap', { style: { height: `${height}px` } });
  const layer = el('div.gm-tiles');
  const marks = el('div.gm-marks');
  box.append(layer, marks, el('a.gm-credit', {
    href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener',
    text: '© OpenStreetMap'
  }));

  let cur = { lat: Number(lat), lng: Number(lng) };

  const draw = () => {
    const w = box.clientWidth || 320;
    const h = height;
    const unset = !Number.isFinite(cur.lat) || !Number.isFinite(cur.lng);
    /*
     * فرعٌ جديد بلا إحداثيات: في وضع التحرير تُفتح الخريطة على مركزٍ مبدئيّ
     * ويُسحَب منه الدبّوس — إذ لا يُسحَب من لا شيء. وفي وضع العرض تبقى رسالةً
     * تقول ما ينقص، فلا تُوهم بموقعٍ ليس موقع الفرع.
     */
    if (unset && !editable) {
      clear(layer); clear(marks);
      marks.append(el('div.gm-empty', {}, [
        el('span.ic', { icon: 'map-pin', iconSize: 'card' }),
        el('p', { text: 'لم تُضبط إحداثيات الفرع بعد' })
      ]));
      return;
    }
    if (unset) cur = { ...fallback };
    box.classList.toggle('gm-unset', unset);
    const z = fitZoom(cur.lat, radius, w, h);
    const c = project(cur.lat, cur.lng, z);
    /* بكسل مركز الإطار يقابل مركز الفرع */
    const originX = c.x * TILE - w / 2;
    const originY = c.y * TILE - h / 2;

    clear(layer);
    const n = 2 ** z;
    const x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + w) / TILE);
    const y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + h) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;   /* لفُّ الكرة عند خط التاريخ */
        const img = el('img.gm-tile', {
          src: `https://${SUB[(wx + ty) % 3]}.tile.openstreetmap.org/${z}/${wx}/${ty}.png`,
          alt: '', loading: 'lazy', width: TILE, height: TILE, referrerpolicy: 'no-referrer',
          style: { insetInlineStart: 'auto', left: `${tx * TILE - originX}px`, top: `${ty * TILE - originY}px` }
        });
        /* مربّعٌ لم يصل — دون اتصالٍ أو بشبكةٍ تحجبه — يُخفى: أيقونةُ صورةٍ
           مكسورة أسوأ من سطحٍ فارغ، والدائرة والعلامتان تبقيان مفهومتين فوقه. */
        img.addEventListener('error', () => { img.hidden = true; box.classList.add('gm-blind'); });
        img.addEventListener('load', () => box.classList.remove('gm-blind'));
        layer.append(img);
      }
    }

    clear(marks);
    /* دائرة النطاق بمقياس الخريطة نفسه */
    const rPx = radius / mPerPx(cur.lat, z);
    marks.append(el('div.gm-fence', { style: {
      width: `${rPx * 2}px`, height: `${rPx * 2}px`,
      left: `${w / 2 - rPx}px`, top: `${h / 2 - rPx}px`
    } }));
    marks.append(el('div.gm-pin' + (editable ? '.drag' : ''), {
      title: 'موقع الفرع', style: { left: `${w / 2}px`, top: `${h / 2}px` }
    }, [luIcon('landmark', { size: 18 })]));
    if (unset) marks.append(el('div.gm-dist.warn', { text: 'اسحب الدبّوس إلى موقع المسجد' }));

    if (me && Number.isFinite(me.lat)) {
      const p = project(me.lat, me.lng, z);
      const mx = p.x * TILE - originX, my = p.y * TILE - originY;
      const dist = distanceM(cur.lat, cur.lng, me.lat, me.lng);
      const inside = dist <= radius;
      /* الموقع خارج الإطار: يُثبَّت على حافّته فلا يختفي المؤشّر */
      const cx = Math.max(10, Math.min(w - 10, mx));
      const cy = Math.max(10, Math.min(h - 10, my));
      marks.append(el('div.gm-me' + (inside ? '.in' : '.out'), {
        title: `أنت على بُعد ${AR_NUM(dist)} م`, style: { left: `${cx}px`, top: `${cy}px` }
      }));
      marks.append(el('div.gm-dist' + (inside ? '.in' : '.out'), {
        text: inside ? `داخل النطاق · ${AR_NUM(dist)} م` : `خارج النطاق · ${AR_NUM(dist)} م`
      }));
    }
  };

  /* السحب يحرّك الفرع لا الخريطة: المطلوب ضبطُ موضعه لا تصفّحُ العالم */
  if (editable) {
    let drag = null;
    const down = (e) => {
      if (!e.target.closest('.gm-pin')) return;
      e.preventDefault();
      if (!Number.isFinite(cur.lat)) cur = { ...fallback };
      drag = { z: fitZoom(cur.lat, radius, box.clientWidth || 320, height) };
      box.classList.remove('gm-unset');
    };
    const move = (e) => {
      if (!drag) return;
      const t = e.touches?.[0] || e;
      const r = box.getBoundingClientRect();
      const w = r.width, h = height, z = drag.z;
      const c = project(cur.lat, cur.lng, z);
      const px = c.x * TILE - w / 2 + (t.clientX - r.left);
      const py = c.y * TILE - h / 2 + (t.clientY - r.top);
      const n = 2 ** z;
      const lng2 = (px / TILE / n) * 360 - 180;
      const k = Math.PI - 2 * Math.PI * (py / TILE / n);
      const lat2 = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k)));
      cur = { lat: Number(lat2.toFixed(6)), lng: Number(lng2.toFixed(6)) };
      draw();
    };
    const up = () => { if (drag) { drag = null; onMove?.({ ...cur }); } };
    box.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* العرض يُعرَف بعد الإلحاق بالمستند، فيُرسَم عند أول قياس ثم عند كل تغيّر */
  const ro = new ResizeObserver(() => draw());
  queueMicrotask(() => { ro.observe(box); draw(); });

  box.update = (patch = {}) => {
    if (patch.lat !== undefined) cur.lat = Number(patch.lat);
    if (patch.lng !== undefined) cur.lng = Number(patch.lng);
    if (patch.radius !== undefined) radius = Number(patch.radius) || radius;
    if (patch.me !== undefined) me = patch.me;
    draw();
  };
  return box;
}
