import { el, clear, AR_NUM } from './util.js';
import { icon as luIcon } from './icons.js';

/**
 * خريطة تفاعلية بمربّعاتٍ من الخادم — بلا مكتبةٍ خارجية.
 *
 * الشاشتان تحتاجانها: ضبطُ نطاق الفرع في الإعداد، ورؤيةُ المُحضِّر موقعَه من
 * الفرع. وكانت لوحةً ثابتة: صورةٌ واحدة لا تتحرّك ولا تكبر، تقول «خارج النطاق»
 * ولا تُري الطريق إليه. فصارت خريطةً تُسحَب وتُكبَّر وتُبدَّل طبقاتها.
 *
 * ولا Leaflet ولا سكربت قوقل: الحزمة ثقيلة، وسياسة الأمان تمنع سكربتاً من خارج
 * المصدر، وواجهةُ قوقل تجرّ معها خطَّها وأزرارها فتشقّ الهوية. فالمربّعات من
 * قوقل عبر وسيط الخادم (`server/core/routes/map.js`)، والأزرار والدائرة
 * والعلامات من عندنا: أيقونات لوسايد وتوكنز الألوان واتجاهٌ من اليمين.
 *
 * والخصوصية على حالها: المتصفّح لا يطلب مربّعاً إلا من خادمنا، فمزوّد الخرائط
 * يرى الخادم لا جهازَ المُحضِّر — حتى حين يتمركز على نفسه بزرّ «موقعي».
 */

const TILE = 256;
const MIN_Z = 3;
/* حدُّ خطّ العرض في مركاتور — قطبٌ لا يُسقَط على مستوٍ */
const clampLat = (l) => Math.max(-85.05112878, Math.min(85.05112878, l));

/** إحداثيات جغرافية → بكسل العالم عند تكبيرٍ ما */
function worldPx(lat, lng, z) {
  const n = TILE * 2 ** z;
  const rad = clampLat(lat) * Math.PI / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  };
}

/** بكسل العالم → إحداثيات جغرافية (عكس مركاتور) */
function unproject(px, py, z) {
  const n = TILE * 2 ** z;
  const lng = (px / n) * 360 - 180;
  const k = Math.PI - 2 * Math.PI * (py / n);
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k))), lng };
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

/* ── كتالوج الطبقات ────────────────────────────────────────────
   يُجلب مرة واحدة ويُشارَك بين كل الخرائط في الجلسة. وحين يتعذّر
   الخادم تبقى الطبقة المفتوحة مرجعاً، فالخريطة لا تسقط إلى فراغ. */
const OPEN_LAYER = {
  id: 'osm',
  label: 'خريطة مفتوحة',
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  subdomains: ['a', 'b', 'c'],
  max_zoom: 19,
  attribution: '© OpenStreetMap',
  attribution_url: 'https://www.openstreetmap.org/copyright'
};
const OPEN_CATALOG = { provider: 'osm', default: OPEN_LAYER.id, layers: [OPEN_LAYER] };

let catalogPromise = null;
export function mapCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/map/layers')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('layers'))))
      .then(d => (Array.isArray(d?.layers) && d.layers.length ? d : OPEN_CATALOG))
      .catch(() => OPEN_CATALOG);
  }
  return catalogPromise;
}

/** الطبقة المختارة تُحفَظ للجلسة القادمة — من فضّل القمر الصناعي وجده كما تركه */
const PREF_KEY = 'raqeem.map.layer';
const readPref = () => { try { return localStorage.getItem(PREF_KEY) || ''; } catch { return ''; } };
const writePref = (v) => { try { localStorage.setItem(PREF_KEY, v); } catch { /* وضع خاص */ } };

/** عنوان مربّعٍ من قالب الطبقة */
function tileUrl(layer, z, x, y) {
  const s = layer.subdomains?.length ? layer.subdomains[(x + y) % layer.subdomains.length] : '';
  return layer.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/**
 * @param {object}  o
 * @param {number}  o.lat        خط عرض الفرع
 * @param {number}  o.lng        خط طول الفرع
 * @param {number}  o.radius     نطاق التحضير بالأمتار
 * @param {object}  [o.me]       موقع المستخدم `{lat, lng, accuracy}` إن عُرف
 * @param {boolean} [o.editable] هل يُسحَب الدبّوس لضبط الموقع؟
 * @param {Function}[o.onMove]   يُستدعى بـ `{lat, lng}` بعد كل سحب للدبّوس
 * @param {Function}[o.onLocate] يُستدعى بـ `{lat, lng, accuracy}` أو بخطأ بعد زرّ «موقعي»
 * @param {number}  [o.height]   ارتفاع الإطار
 * @param {object}  [o.fallback] مركزٌ يُبدأ منه حين لا إحداثيات — للتحرير وحده
 */
export function geoMap({ lat, lng, radius = 50, me = null, editable = false, onMove, onLocate,
  height = 260, fallback = { lat: 24.7136, lng: 46.6753 } }) {
  const box = el('div.geomap', { style: { height: `${height}px` }, tabindex: '0',
    role: 'application', 'aria-label': 'خريطة موقع الفرع ونطاق التحضير' });
  const tilesEl = el('div.gm-tiles');
  const marks = el('div.gm-marks');
  const credit = el('a.gm-credit', { target: '_blank', rel: 'noopener',
    href: OPEN_LAYER.attribution_url, text: OPEN_LAYER.attribution });

  /* ── الحالة ─────────────────────────────────────────────── */
  let branch = { lat: Number(lat), lng: Number(lng) };
  let view = null;          /* مركز الإطار — يتبع الفرع حتى يحرّكه المستخدم */
  let zoom = 16;
  let follow = true;        /* هل ما يزال الإطار ملازماً للفرع؟ */
  let zoomLocked = false;   /* هل اختار المستخدم تكبيراً بنفسه؟ */
  let layer = OPEN_LAYER;
  let catalog = OPEN_CATALOG;
  let originX = 0, originY = 0;
  let engaged = false;      /* هل لمس المستخدم الخريطة؟ العجلة لا تُكبّر قبلها */
  const unset = () => !Number.isFinite(branch.lat) || !Number.isFinite(branch.lng);

  /* ── أدوات التحكّم ──────────────────────────────────────── */
  const ctlBtn = (name, label, onclick) => el('button.gm-btn', {
    type: 'button', title: label, 'aria-label': label,
    onclick: (e) => { engaged = true; onclick(e); }
  }, [luIcon(name, { size: 17 })]);

  const layerList = el('div.gm-panel', { role: 'listbox', 'aria-label': 'طبقات الخريطة', hidden: true });
  const layerBtn = ctlBtn('layers', 'طبقات الخريطة', (e) => {
    e.stopPropagation();
    layerList.hidden = !layerList.hidden;
    layerBtn.classList.toggle('on', !layerList.hidden);
  });
  const layerWrap = el('div.gm-layers', { hidden: true }, [layerBtn, layerList]);

  const zoomIn = ctlBtn('plus', 'تكبير', () => setZoom(zoom + 1));
  const zoomOut = ctlBtn('minus', 'تصغير', () => setZoom(zoom - 1));
  const homeBtn = ctlBtn('landmark', 'العودة إلى الفرع', () => recenter());
  const meBtn = ctlBtn('target', 'موقعي الآن', () => locateMe());

  const ctrl = el('div.gm-ctrl', {}, [layerWrap, zoomIn, zoomOut, meBtn, homeBtn]);
  const hud = el('div.gm-hud');
  box.append(tilesEl, marks, hud, ctrl, credit);

  /* ── طبقة المربّعات ─────────────────────────────────────── */
  const tiles = new Map();     /* مفتاحٌ يجمع الطبقة والتكبير والموضع → صورة */
  let pending = 0;

  const settle = (rec) => {
    if (rec.done) return;
    rec.done = true;
    pending = Math.max(0, pending - 1);
  };
  /* لا يُطرح القديم إلا بعد أن يغطّيه الجديد — وإلا ومض السطح فارغاً */
  const settled = (rec) => { settle(rec); if (!pending) sweep(); };

  function makeTile(z, x, y, wx) {
    const rec = { z, x, y, layer: layer.id, done: false };
    rec.img = el('img.gm-tile', {
      src: tileUrl(layer, z, wx, y), alt: '', loading: 'eager',
      referrerpolicy: 'no-referrer', draggable: 'false',
      style: { insetInlineStart: 'auto' }
    });
    pending += 1;
    /* مربّعٌ لم يصل — دون اتصالٍ أو بشبكةٍ تحجبه — يُخفى: أيقونةُ صورةٍ مكسورة
       أسوأ من سطحٍ فارغ، والدائرة والعلامتان تبقيان مفهومتين فوقه. */
    rec.img.addEventListener('error', () => { rec.img.hidden = true; box.classList.add('gm-blind'); settled(rec); });
    rec.img.addEventListener('load', () => { box.classList.remove('gm-blind'); settled(rec); });
    tilesEl.append(rec.img);
    return rec;
  }

  const drop = (key, rec) => { settle(rec); rec.img.remove(); tiles.delete(key); };

  /** يضع كل مربّعٍ محفوظ في موضعه بمقياس التكبير الحالي، ويطرح ما خرج أو قدُم */
  function sweep() {
    const w = box.clientWidth || 320, h = box.clientHeight || height;
    for (const [key, rec] of tiles) {
      const scale = 2 ** (zoom - rec.z);
      const size = TILE * scale;
      const left = rec.x * size - originX, top = rec.y * size - originY;
      const seen = left < w && top < h && left + size > 0 && top + size > 0;
      const fresh = rec.layer === layer.id && rec.z === zoom;
      if (!seen || (!fresh && !pending)) { drop(key, rec); continue; }
      Object.assign(rec.img.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${size}px`, height: `${size}px`,
        zIndex: fresh ? '2' : '1'
      });
    }
  }

  function renderTiles(w, h) {
    const n = 2 ** zoom;
    const x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + w) / TILE);
    const y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + h) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;    /* لفُّ الكرة عند خط التاريخ */
        const key = `${layer.id}|${zoom}|${tx}|${ty}`;
        if (!tiles.has(key)) tiles.set(key, makeTile(zoom, tx, ty, wx));
      }
    }
    sweep();
  }

  /* ── العلامات ───────────────────────────────────────────── */
  const px = (la, ln) => {
    const p = worldPx(la, ln, zoom);
    return { x: p.x - originX, y: p.y - originY };
  };

  function renderMarks(w, h) {
    clear(marks); clear(hud);
    const b = px(branch.lat, branch.lng);
    const rPx = radius / mPerPx(branch.lat, zoom);

    marks.append(el('div.gm-fence', { style: {
      width: `${rPx * 2}px`, height: `${rPx * 2}px`,
      left: `${b.x - rPx}px`, top: `${b.y - rPx}px`
    } }));
    marks.append(el('div.gm-pin' + (editable ? '.drag' : ''), {
      title: 'موقع الفرع', style: { left: `${b.x}px`, top: `${b.y}px` }
    }, [luIcon('landmark', { size: 18 })]));

    if (unset()) hud.append(el('div.gm-dist.warn', { text: 'اسحب الدبّوس إلى موقع المسجد' }));

    if (me && Number.isFinite(me.lat)) {
      const p = px(me.lat, me.lng);
      const dist = distanceM(branch.lat, branch.lng, me.lat, me.lng);
      const inside = dist <= radius;
      /* دائرة الدقّة تُرسم أولاً فتبقى تحت النقطة — ولا تُرسم إن كانت أدقّ من بكسل */
      const accPx = Number(me.accuracy) > 0 ? me.accuracy / mPerPx(me.lat, zoom) : 0;
      if (accPx > 6) marks.append(el('div.gm-acc', { style: {
        width: `${accPx * 2}px`, height: `${accPx * 2}px`,
        left: `${p.x - accPx}px`, top: `${p.y - accPx}px`
      } }));
      /* الموقع خارج الإطار: يُثبَّت على حافّته فلا يختفي المؤشّر */
      const cx = Math.max(10, Math.min(w - 10, p.x));
      const cy = Math.max(10, Math.min(h - 10, p.y));
      marks.append(el('div.gm-me' + (inside ? '.in' : '.out'), {
        title: `أنت على بُعد ${AR_NUM(dist)} م`, style: { left: `${cx}px`, top: `${cy}px` }
      }));
      hud.append(el('div.gm-dist' + (inside ? '.in' : '.out'), {
        text: inside ? `داخل النطاق · ${AR_NUM(dist)} م` : `خارج النطاق · ${AR_NUM(dist)} م`
      }));
    }
  }

  /* ── الرسم ──────────────────────────────────────────────── */
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  };

  function draw() {
    const w = box.clientWidth || 320;
    const h = box.clientHeight || height;
    if (!w) return;

    /*
     * فرعٌ جديد بلا إحداثيات: في وضع التحرير تُفتح الخريطة على مركزٍ مبدئيّ
     * ويُسحَب منه الدبّوس — إذ لا يُسحَب من لا شيء. وفي وضع العرض تبقى رسالةً
     * تقول ما ينقص، فلا تُوهم بموقعٍ ليس موقع الفرع.
     */
    if (unset() && !editable && !me) {
      clear(marks); clear(hud);
      for (const [k, rec] of tiles) drop(k, rec);
      ctrl.hidden = true;
      marks.append(el('div.gm-empty', {}, [
        el('span.ic', { icon: 'map-pin', iconSize: 'card' }),
        el('p', { text: 'لم تُضبط إحداثيات الفرع بعد' })
      ]));
      return;
    }
    ctrl.hidden = false;
    if (unset()) branch = { ...(me && Number.isFinite(me.lat) ? me : fallback) };
    box.classList.toggle('gm-unset', unset());

    if (!view || follow) view = { ...branch };
    if (!zoomLocked) zoom = fitZoom(w, h);

    const c = worldPx(view.lat, view.lng, zoom);
    originX = c.x - w / 2;
    originY = c.y - h / 2;

    renderTiles(w, h);
    renderMarks(w, h);
    zoomIn.disabled = zoom >= maxZoom();
    zoomOut.disabled = zoom <= MIN_Z;
  }

  const maxZoom = () => Math.min(21, layer.max_zoom || 19);

  /** أنسب تكبيرٍ ليملأ قُطرُ النطاق نحو ٧٠٪ من الإطار */
  function fitZoom(w, h) {
    const want = (Math.min(w, h) * 0.7) / (2 * Math.max(radius, 10));   /* بكسل لكل متر */
    for (let z = maxZoom(); z >= MIN_Z; z--) if (1 / mPerPx(branch.lat, z) <= want) return z;
    return Math.min(16, maxZoom());
  }

  /* ── التكبير والتحريك ───────────────────────────────────── */
  function setZoom(next, anchor = null) {
    const z = Math.max(MIN_Z, Math.min(maxZoom(), Math.round(next)));
    if (z === zoom) return;
    zoomLocked = true;
    if (anchor) {
      /* التكبير حول نقطةٍ بعينها: تبقى تحت المؤشّر قبل التكبير وبعده */
      const geo = unproject(originX + anchor.x, originY + anchor.y, zoom);
      zoom = z;
      const w = box.clientWidth || 320, h = box.clientHeight || height;
      const g = worldPx(geo.lat, geo.lng, zoom);
      view = unproject(g.x - anchor.x + w / 2, g.y - anchor.y + h / 2, zoom);
      follow = false;
    } else {
      zoom = z;
    }
    draw();
  }

  function panBy(dx, dy) {
    const c = worldPx(view.lat, view.lng, zoom);
    view = unproject(c.x - dx, c.y - dy, zoom);
    follow = false;
    schedule();
  }

  function recenter() {
    follow = true; zoomLocked = false;
    view = { ...branch };
    draw();
  }

  /* ── موقعي الآن ─────────────────────────────────────────── */
  function locateMe() {
    if (!navigator.geolocation) { onLocate?.(null, new Error('لا يدعم جهازك تحديد الموقع')); return; }
    meBtn.classList.add('busy'); meBtn.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      meBtn.classList.remove('busy'); meBtn.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      me = { lat: latitude, lng: longitude, accuracy };
      follow = false;
      view = { lat: latitude, lng: longitude };
      draw();
      onLocate?.({ lat: latitude, lng: longitude, accuracy }, null);
    }, (err) => {
      meBtn.classList.remove('busy'); meBtn.disabled = false;
      onLocate?.(null, err);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }

  /* ── مبدّل الطبقات ──────────────────────────────────────── */
  function applyCatalog(cat) {
    catalog = cat;
    const want = readPref();
    layer = cat.layers.find(l => l.id === want) || cat.layers.find(l => l.id === cat.default) || cat.layers[0];
    credit.textContent = layer.attribution || '';
    credit.href = layer.attribution_url || '#';
    /* مبدّلٌ لخيارٍ واحد زينةٌ لا أداة — فلا يظهر إلا حين تتعدّد الطبقات */
    layerWrap.hidden = cat.layers.length < 2;
    clear(layerList);
    for (const l of cat.layers) {
      const on = l.id === layer.id;
      layerList.append(el('button.gm-layer' + (on ? '.on' : ''), {
        type: 'button', role: 'option', 'aria-selected': on ? 'true' : 'false',
        onclick: (e) => { e.stopPropagation(); pickLayer(l.id); }
      }, [el('span.gm-layer-t', { text: l.label }), on ? luIcon('check', { size: 15 }) : null]));
    }
    if (zoom > maxZoom()) zoom = maxZoom();
    draw();
  }

  function pickLayer(id) {
    const next = catalog.layers.find(l => l.id === id);
    if (!next || next.id === layer.id) { layerList.hidden = true; layerBtn.classList.remove('on'); return; }
    layer = next;
    writePref(id);
    box.classList.remove('gm-blind');
    layerList.hidden = true; layerBtn.classList.remove('on');
    applyCatalog(catalog);
  }

  /* ── المؤشّر: سحبٌ للإطار، وسحبٌ للدبّوس في وضع التحرير ─── */
  const points = new Map();
  let mode = null;          /* 'pan' | 'pin' */
  let last = null;
  let pinchBase = 0;

  const localPoint = (e) => {
    const r = box.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.gm-ctrl')) return;
    if (!layerList.hidden) { layerList.hidden = true; layerBtn.classList.remove('on'); }
    points.set(e.pointerId, localPoint(e));
    box.setPointerCapture?.(e.pointerId);
    if (points.size === 2) {
      const [a, b] = [...points.values()];
      pinchBase = Math.hypot(a.x - b.x, a.y - b.y);
      mode = 'pinch';
      return;
    }
    engaged = true;
    if (editable && e.target.closest('.gm-pin')) {
      mode = 'pin';
      box.classList.remove('gm-unset');
      /*
       * السحبُ يفكّ ملازمة الإطار للفرع. وإلا لطاردت الخريطةُ الدبّوسَ: يتحرّك
       * فيُعاد التمركز عليه، فتُقاس الحركة التالية من مركزٍ جديد وتُضاف إلى ما
       * قبلها — فينفلت الدبّوس أضعاف ما حرّكته اليد.
       */
      follow = false;
    }
    else { mode = 'pan'; box.classList.add('gm-grab'); }
    last = localPoint(e);
    e.preventDefault();
  });

  box.addEventListener('pointermove', (e) => {
    if (!points.has(e.pointerId)) return;
    const p = localPoint(e);
    points.set(e.pointerId, p);

    if (mode === 'pinch' && points.size === 2) {
      const [a, b] = [...points.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (d > pinchBase * 1.7) { setZoom(zoom + 1, mid); pinchBase = d; }
      else if (d < pinchBase * 0.6) { setZoom(zoom - 1, mid); pinchBase = d; }
      return;
    }
    if (!last) return;
    const dx = p.x - last.x, dy = p.y - last.y;
    last = p;
    if (mode === 'pan') panBy(dx, dy);
    else if (mode === 'pin') {
      /* الدبّوس يتبع المؤشّر: يُقرأ موضعه من الإطار ثم يُعكس إلى إحداثيات */
      const g = unproject(originX + p.x, originY + p.y, zoom);
      branch = { lat: Number(g.lat.toFixed(6)), lng: Number(g.lng.toFixed(6)) };
      schedule();
    }
  });

  const release = (e) => {
    if (!points.has(e.pointerId)) return;
    points.delete(e.pointerId);
    box.releasePointerCapture?.(e.pointerId);
    if (mode === 'pin') onMove?.({ ...branch });
    box.classList.remove('gm-grab');
    if (points.size < 2) { mode = points.size === 1 ? 'pan' : null; }
    if (points.size === 1) last = [...points.values()][0];
    else last = null;
  };
  box.addEventListener('pointerup', release);
  box.addEventListener('pointercancel', release);

  /*
   * العجلة لا تخطف تمرير الصفحة: الخريطة تجلس داخل نموذجٍ طويل، ومن يمرّر
   * الصفحة فوقها يريد الصفحة لا التكبير. فتُكبَّر بالعجلة بعد أن يشتبك بها
   * المستخدم (سحبٌ أو ضغطة)، أو بـ Ctrl/⌘ فوراً — وقبل ذلك تُقال القاعدة.
   */
  box.addEventListener('wheel', (e) => {
    if (e.target.closest('.gm-ctrl')) return;
    if (!engaged && !e.ctrlKey && !e.metaKey) { flashHint(); return; }
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? 1 : -1), localPoint(e));
  }, { passive: false });

  let hintTimer = 0;
  function flashHint() {
    if (box.querySelector('.gm-hint')) return;
    const n = el('div.gm-hint', { text: 'اضغط على الخريطة أولاً، أو استعمل زرّي التكبير' });
    box.append(n);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => n.remove(), 2200);
  }

  box.addEventListener('dblclick', (e) => {
    if (e.target.closest('.gm-ctrl')) return;
    setZoom(zoom + 1, localPoint(e));
  });

  /* لوحة المفاتيح: الأسهم تحرّك والزائد والناقص يكبّران — لمن لا يستعمل مؤشّراً */
  box.addEventListener('keydown', (e) => {
    const step = 60;
    const moves = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [step, 0], ArrowRight: [-step, 0] };
    if (moves[e.key]) { e.preventDefault(); panBy(...moves[e.key]); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom + 1); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom - 1); }
  });

  /*
   * ضغطةٌ خارج الخريطة تُغلق لوحة الطبقات. والمستمع على المستند يرفع نفسه حين
   * تُنزَع الخريطة من الصفحة: شاشة التحضير تُعيد بناء نفسها بعد كل تسجيل، فلولا
   * ذلك تراكمت مستمعاتٌ تُمسك بخرائط ميتة ولا يجمعها جامع القمامة.
   */
  const closePanel = (e) => {
    if (!box.isConnected) { document.removeEventListener('pointerdown', closePanel); return; }
    if (layerList.hidden || box.contains(e.target)) return;
    layerList.hidden = true; layerBtn.classList.remove('on');
  };
  document.addEventListener('pointerdown', closePanel);

  /* العرض يُعرَف بعد الإلحاق بالمستند، فيُرسَم عند أول قياس ثم عند كل تغيّر */
  const ro = new ResizeObserver(() => schedule());
  queueMicrotask(() => { ro.observe(box); draw(); mapCatalog().then(applyCatalog); });

  box.update = (patch = {}) => {
    const moved = patch.lat !== undefined || patch.lng !== undefined;
    if (patch.lat !== undefined) branch.lat = Number(patch.lat);
    if (patch.lng !== undefined) branch.lng = Number(patch.lng);
    if (patch.radius !== undefined) radius = Number(patch.radius) || radius;
    if (patch.me !== undefined) me = patch.me;
    /* تحريك الفرع من الحقول يُعيد الإطار إليه — وإلا بقيت الخريطة على موضعٍ قديم */
    if (moved && !editable) follow = true;
    if (moved && editable) view = { ...branch };
    draw();
  };
  box.locate = locateMe;
  return box;
}
