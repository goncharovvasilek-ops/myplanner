'use strict';
/*
 * LinkBoard — доска со звеньями, ниточками и слоями.
 *
 * Модель данных (одна запись "board" в IndexedDB, фото — отдельными Blob'ами):
 *   cards:  { id: {id, text, imageId, imgW, imgH, x, y} }   — звено существует в одном экземпляре
 *   layers: [{id, name, visible, cardIds:[...], links:[{id, a, b}]}]
 *
 * Перенос звена на слой = ССЫЛКА, а не копия: id звена просто добавляется в cardIds
 * текущего слоя. Текст/фото/позиция у звена общие для всех слоёв, а ниточки у каждого
 * слоя свои. Так фото не дублируется в хранилище, правка подписи видна везде, а
 * полупрозрачная «подложка» с других слоёв совпадает с активным звеном и не двоится.
 */

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const MIN_LAYERS = 5;
const MIN_SCALE = 0.08, MAX_SCALE = 4;

/* ====================== IndexedDB ====================== */
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('linkboard', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
async function idb(store, mode, fn) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    let out;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Транзакция прервана'));
  });
}
const kvGet = (k) => idb('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k));
const imgGet = (k) => idb('images', 'readonly', (s) => s.get(k));
const imgSet = (k, v) => idb('images', 'readwrite', (s) => s.put(v, k));
const imgDel = (k) => idb('images', 'readwrite', (s) => s.delete(k));
const imgClear = () => idb('images', 'readwrite', (s) => s.clear());

/* ====================== state ====================== */
let B = null;                 // board
const sel = new Set();        // выбранные звенья (только текущего слоя)
const selLinks = new Set();   // выбранные ниточки (текущего слоя)
const picked = new Set();     // звенья, отмеченные для переноса
let transferMode = false;
let shown = new Set();        // id звеньев, которые сейчас на экране (активные + подложка)
let linkGeo = [];             // геометрия ниточек текущего слоя для попадания тапом

function newBoard() {
  return {
    version: 1,
    cards: {},
    layers: Array.from({ length: MIN_LAYERS }, (_, i) => newLayer(i)),
    current: 0,
    view: { x: Math.round(innerWidth / 2 - 110), y: Math.round(innerHeight / 2 - 80), s: 1 },
  };
}
function newLayer(i) {
  return { id: uid(), name: 'Слой ' + (i + 1), visible: true, cardIds: [], links: [] };
}
function normalize(b) {
  if (!b || typeof b !== 'object') return newBoard();
  if (!b.cards || typeof b.cards !== 'object') b.cards = {};
  if (!Array.isArray(b.layers)) b.layers = [];
  while (b.layers.length < MIN_LAYERS) b.layers.push(newLayer(b.layers.length));
  for (const [i, l] of b.layers.entries()) {
    l.id = l.id || uid();
    l.name = typeof l.name === 'string' && l.name ? l.name : 'Слой ' + (i + 1);
    l.visible = l.visible !== false;
    l.cardIds = (Array.isArray(l.cardIds) ? l.cardIds : []).filter((id) => b.cards[id]);
    l.cardIds = [...new Set(l.cardIds)];
    const ids = new Set(l.cardIds);
    l.links = (Array.isArray(l.links) ? l.links : []).filter((k) => k && ids.has(k.a) && ids.has(k.b) && k.a !== k.b);
    for (const k of l.links) k.id = k.id || uid();
  }
  for (const c of Object.values(b.cards)) {
    c.x = Number.isFinite(c.x) ? c.x : 0;
    c.y = Number.isFinite(c.y) ? c.y : 0;
    c.text = typeof c.text === 'string' ? c.text : '';
  }
  b.current = clamp(b.current | 0, 0, b.layers.length - 1);
  const v = b.view || {};
  b.view = {
    x: Number.isFinite(v.x) ? v.x : innerWidth / 2,
    y: Number.isFinite(v.y) ? v.y : innerHeight / 2,
    s: Number.isFinite(v.s) ? clamp(v.s, MIN_SCALE, MAX_SCALE) : 1,
  };
  return b;
}
const cur = () => B.layers[B.current];
const layersOf = (id) => B.layers.reduce((a, l, i) => (l.cardIds.includes(id) ? (a.push(i), a) : a), []);

/* ---------- autosave ---------- */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
function flush() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  kvSet('board', B).catch((e) => toast('Не удалось сохранить: ' + e.message, 4000));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('pagehide', flush);

/* ====================== DOM refs ====================== */
const board = $('#board'), world = $('#world');
const ghostCardsEl = $('#ghostCards'), activeCardsEl = $('#activeCards');
const ghostLinksEl = $('#ghostLinks'), activeLinksEl = $('#activeLinks');
const tempPath = $('#tempLink path');

/* ====================== images ====================== */
const urls = new Map(); // imageId -> objectURL
async function imageURL(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await imgGet(id);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}
function forgetImage(id) {
  if (!id) return;
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  imgDel(id).catch(() => {});
}
async function shrinkImage(file, max = 1200) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Не удалось открыть фото'));
      i.src = src;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Не удалось сжать фото');
    return { blob, w, h };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/* ====================== rendering ====================== */
const els = new Map();   // card id -> element
const sizes = new Map(); // card id -> {w, h}

function cardEl(c) {
  let el = els.get(c.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = c.id;
    els.set(c.id, el);
  }
  const sig = c.text + '\u0000' + (c.imageId || '');
  if (el._sig !== sig) {
    el._sig = sig;
    el.textContent = '';
    el.classList.toggle('photo', !!c.imageId);
    if (c.imageId) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      if (c.imgW && c.imgH) img.style.aspectRatio = c.imgW + ' / ' + c.imgH;
      img.onload = () => { if (el.isConnected) { measure(c.id); drawLinks(); } };
      imageURL(c.imageId).then((u) => { if (u) img.src = u; });
      el.appendChild(img);
    }
    if (c.text || !c.imageId) {
      const t = document.createElement('div');
      t.className = 'txt';
      t.textContent = c.text || ' ';
      el.appendChild(t);
    }
    const h = document.createElement('div');
    h.className = 'handle';
    el.appendChild(h);
    const b = document.createElement('span');
    b.className = 'badge';
    el.appendChild(b);
  }
  return el;
}
function placeEl(el, c) { el.style.transform = `translate(${c.x}px, ${c.y}px)`; }
function measure(id) {
  const el = els.get(id);
  if (el && el.isConnected) sizes.set(id, { w: el.offsetWidth, h: el.offsetHeight });
}

function render() {
  const L = cur();
  const curSet = new Set(L.cardIds);
  const ghostOf = new Map(); // id -> [номера слоёв]
  B.layers.forEach((l, i) => {
    if (i === B.current || !l.visible) return;
    for (const id of l.cardIds) {
      if (curSet.has(id)) continue;
      if (!ghostOf.has(id)) ghostOf.set(id, []);
      ghostOf.get(id).push(i + 1);
    }
  });
  // убрать удалённые
  for (const [id, el] of els) {
    if (!B.cards[id]) { el.remove(); els.delete(id); sizes.delete(id); }
  }
  shown = new Set();
  // подложка (в порядке слоёв), затем активные (в порядке слоя = z-порядок)
  for (const [id, nums] of ghostOf) {
    const c = B.cards[id];
    const el = cardEl(c);
    if (el.parentNode !== ghostCardsEl) ghostCardsEl.appendChild(el);
    el.classList.add('ghost');
    el.classList.remove('selected', 'linkTarget');
    el.classList.toggle('picked', picked.has(id));
    el.querySelector('.badge').textContent = 'L' + nums.join(',');
    placeEl(el, c);
    shown.add(id);
  }
  for (const id of L.cardIds) {
    const c = B.cards[id];
    const el = cardEl(c);
    if (el.parentNode !== activeCardsEl) activeCardsEl.appendChild(el);
    el.classList.remove('ghost', 'picked');
    el.classList.toggle('selected', sel.has(id));
    placeEl(el, c);
    shown.add(id);
  }
  for (const [id, el] of els) if (!shown.has(id) && el.parentNode) el.remove();
  for (const id of shown) measure(id);
  drawLinks();
  updateUI();
}

function geom(a, b) {
  const ca = B.cards[a], cb = B.cards[b], sa = sizes.get(a), sb = sizes.get(b);
  if (!ca || !cb || !sa || !sb) return null;
  const ax = ca.x + sa.w / 2, ay = ca.y + sa.h / 2, bx = cb.x + sb.w / 2, by = cb.y + sb.h / 2;
  const p = clipToRect(ax, ay, sa.w, sa.h, bx - ax, by - ay);
  const q = clipToRect(bx, by, sb.w, sb.h, ax - bx, ay - by);
  return curve(p.x, p.y, q.x, q.y);
}
function clipToRect(cx, cy, w, h, dx, dy) {
  if (!dx && !dy) return { x: cx, y: cy };
  const t = Math.min(dx ? (w / 2) / Math.abs(dx) : Infinity, dy ? (h / 2) / Math.abs(dy) : Infinity);
  return t >= 1 ? { x: cx, y: cy } : { x: cx + dx * t, y: cy + dy * t };
}
// нитка слегка провисает вниз
function curve(x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const sag = Math.min(70, len * 0.14);
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 + sag * 2 };
}
const pathD = (g) => `M${g.x1.toFixed(1)} ${g.y1.toFixed(1)}Q${g.cx.toFixed(1)} ${g.cy.toFixed(1)} ${g.x2.toFixed(1)} ${g.y2.toFixed(1)}`;

function drawLinks() {
  const L = cur();
  let html = '';
  linkGeo = [];
  for (const k of L.links) {
    const g = geom(k.a, k.b);
    if (!g) continue;
    html += `<path class="thread${selLinks.has(k.id) ? ' sel' : ''}" d="${pathD(g)}"/>`;
    linkGeo.push({ id: k.id, g });
  }
  activeLinksEl.innerHTML = html;

  const seen = new Set(L.links.map((k) => pairKey(k.a, k.b)));
  let gh = '';
  B.layers.forEach((l, i) => {
    if (i === B.current || !l.visible) return;
    for (const k of l.links) {
      const key = pairKey(k.a, k.b);
      if (seen.has(key) || !shown.has(k.a) || !shown.has(k.b)) continue;
      seen.add(key);
      const g = geom(k.a, k.b);
      if (g) gh += `<path class="thread" d="${pathD(g)}"/>`;
    }
  });
  ghostLinksEl.innerHTML = gh;
}

function linkAt(sx, sy) {
  const v = B.view;
  const wx = (sx - v.x) / v.s, wy = (sy - v.y) / v.s;
  let best = null, bd = 18 / v.s;
  for (const { id, g } of linkGeo) {
    let px = g.x1, py = g.y1;
    for (let i = 1; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      const x = u * u * g.x1 + 2 * u * t * g.cx + t * t * g.x2;
      const y = u * u * g.y1 + 2 * u * t * g.cy + t * t * g.y2;
      const d = segDist(wx, wy, px, py, x, y);
      if (d < bd) { bd = d; best = id; }
      px = x; py = y;
    }
  }
  return best;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function applyView() {
  const v = B.view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
  world.style.setProperty('--inv', (1 / v.s).toFixed(3));
  const g = 24 * v.s;
  board.style.backgroundSize = `${g}px ${g}px`;
  board.style.backgroundPosition = `${v.x}px ${v.y}px`;
}
function zoomAt(sx, sy, ns) {
  const v = B.view;
  ns = clamp(ns, MIN_SCALE, MAX_SCALE);
  const wx = (sx - v.x) / v.s, wy = (sy - v.y) / v.s;
  v.s = ns;
  v.x = sx - wx * ns;
  v.y = sy - wy * ns;
  applyView();
  save();
}
function fitAll() {
  const ids = [...shown];
  if (!ids.length) {
    B.view = { x: innerWidth / 2 - 110, y: innerHeight / 2 - 80, s: 1 };
    applyView(); save(); return;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const c = B.cards[id], s = sizes.get(id) || { w: 200, h: 100 };
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + s.w); y1 = Math.max(y1, c.y + s.h);
  }
  const top = 80, bottom = 100, side = 24;
  const aw = innerWidth - side * 2, ah = innerHeight - top - bottom;
  const s = clamp(Math.min(aw / (x1 - x0 || 1), ah / (y1 - y0 || 1), 1.5), MIN_SCALE, MAX_SCALE);
  B.view = {
    s,
    x: side + (aw - (x1 - x0) * s) / 2 - x0 * s,
    y: top + (ah - (y1 - y0) * s) / 2 - y0 * s,
  };
  applyView(); save();
}

/* ====================== UI chrome ====================== */
function updateUI() {
  const tabs = B.layers.map((l, i) =>
    `<button type="button" class="tab${i === B.current ? ' cur' : ''}${l.cardIds.length ? ' has' : ''}${l.visible ? '' : ' hidden-layer'}" data-layer="${i}" aria-label="${esc(l.name)}">${i + 1}</button>`
  ).join('');
  const tabsEl = $('#layerTabs');
  if (tabsEl._html !== tabs) { tabsEl.innerHTML = tabs; tabsEl._html = tabs; }
  const L = cur();
  $('#layerLabel').textContent = `${L.name} · ${L.cardIds.length}`;

  const tb = $('#toolbar');
  tb.querySelector('[data-act=edit]').disabled = sel.size !== 1;
  tb.querySelector('[data-act=delete]').disabled = !(sel.size || selLinks.size);
  tb.querySelector('[data-act=transfer]').classList.toggle('on', transferMode);

  $('#hint').hidden = Object.keys(B.cards).length > 0;
  document.body.classList.toggle('transfer', transferMode);
  $('#transferBar').hidden = !transferMode;
  const ok = $('#trOk');
  ok.textContent = picked.size ? `Перенести (${picked.size})` : 'Перенести';
  ok.disabled = !picked.size;
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ====================== gestures ====================== */
const pointers = new Map(); // pointerId -> {x, y}
let g = null;               // текущий жест
let tap = null;             // кандидат на тап
let lastTap = null;
const TAP_MOVE = 9, TAP_TIME = 350, DOUBLE_TIME = 380;

const toWorld = (sx, sy) => ({ x: (sx - B.view.x) / B.view.s, y: (sy - B.view.y) / B.view.s });

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { board.setPointerCapture(e.pointerId); } catch (_) { /* синтетические события */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;

  const target = e.target;
  const cardNode = target.closest ? target.closest('.card') : null;
  const id = cardNode ? cardNode.dataset.id : null;
  const isGhost = !!(cardNode && cardNode.classList.contains('ghost'));
  tap = { id, isGhost, x: e.clientX, y: e.clientY, t: performance.now() };

  if (id && !isGhost && !transferMode && target.classList.contains('handle')) {
    g = { mode: 'link', from: id, pid: e.pointerId };
    tap = null;
    updateTempLink(e.clientX, e.clientY);
    return;
  }
  if (id && !isGhost && sel.has(id) && !transferMode) {
    const start = new Map();
    for (const sid of sel) start.set(sid, { x: B.cards[sid].x, y: B.cards[sid].y });
    g = { mode: 'drag', pid: e.pointerId, sx: e.clientX, sy: e.clientY, start, moved: false };
    return;
  }
  startPan(e.pointerId, e.clientX, e.clientY);
}

function startPan(pid, x, y) {
  g = { mode: 'pan', pid, sx: x, sy: y, vx: B.view.x, vy: B.view.y };
  board.classList.add('panning');
}
function startPinch() {
  if (g && g.mode === 'link') clearTempLink();
  if (g && g.mode === 'drag' && g.moved) save();
  tap = null; lastTap = null;
  const [p1, p2] = [...pointers.values()];
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  g = {
    mode: 'pinch',
    d0: Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
    s0: B.view.s,
    anchor: toWorld(mx, my),
  };
}

function onPointerMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_MOVE) tap = null;
  if (!g) return;

  if (g.mode === 'pinch') {
    if (pointers.size < 2) return;
    const [p1, p2] = [...pointers.values()];
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const d = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const v = B.view;
    v.s = clamp(g.s0 * d / g.d0, MIN_SCALE, MAX_SCALE);
    v.x = mx - g.anchor.x * v.s;
    v.y = my - g.anchor.y * v.s;
    applyView();
  } else if (e.pointerId !== g.pid) {
    return;
  } else if (g.mode === 'pan') {
    B.view.x = g.vx + (p.x - g.sx);
    B.view.y = g.vy + (p.y - g.sy);
    applyView();
  } else if (g.mode === 'drag') {
    const dx = (p.x - g.sx) / B.view.s, dy = (p.y - g.sy) / B.view.s;
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 4) return;
    g.moved = true;
    for (const [sid, s0] of g.start) {
      const c = B.cards[sid];
      if (!c) continue;
      c.x = Math.round(s0.x + dx); c.y = Math.round(s0.y + dy);
      const el = els.get(sid);
      if (el) placeEl(el, c);
    }
    drawLinks();
  } else if (g.mode === 'link') {
    updateTempLink(p.x, p.y);
  }
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  const cancelled = e.type === 'pointercancel';
  pointers.delete(e.pointerId);
  try { board.releasePointerCapture(e.pointerId); } catch (_) {}

  if (g && g.mode === 'pinch') {
    if (pointers.size === 1) {
      const [[pid, p]] = [...pointers.entries()];
      startPan(pid, p.x, p.y);
    } else if (pointers.size === 0) {
      g = null; save();
    }
    return;
  }
  if (pointers.size > 0) return;

  const ended = g;
  g = null;
  board.classList.remove('panning');
  if (ended) {
    if (ended.mode === 'pan') save();
    if (ended.mode === 'drag' && ended.moved) save();
    if (ended.mode === 'link') { finishLink(ended.from, e.clientX, e.clientY, cancelled); return; }
  }
  const t = tap;
  tap = null;
  if (!cancelled && t && performance.now() - t.t < TAP_TIME && !(ended && ended.moved)) handleTap(t);
}

function handleTap(t) {
  const now = performance.now();
  const kind = t.id ? (t.isGhost ? 'ghost' : 'card') : 'empty';
  const dbl = lastTap && lastTap.kind === kind && lastTap.id === t.id &&
    now - lastTap.t < DOUBLE_TIME && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 30;
  lastTap = dbl ? null : { kind, id: t.id, t: now, x: t.x, y: t.y };

  if (transferMode) {
    if (kind === 'ghost') {
      picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id);
      lastTap = null;
      render();
    }
    return;
  }
  if (kind === 'card') {
    if (dbl) {
      sel.has(t.id) ? sel.delete(t.id) : sel.add(t.id);
      render();
    }
    return;
  }
  if (kind === 'empty') {
    const lid = linkAt(t.x, t.y);
    if (lid) {
      selLinks.has(lid) ? selLinks.delete(lid) : selLinks.add(lid);
      lastTap = null;
      drawLinks(); updateUI();
      return;
    }
    if (dbl && (sel.size || selLinks.size)) {
      sel.clear(); selLinks.clear();
      render();
    }
  }
}

/* ---------- протягивание ниточки ---------- */
let linkHover = null;
function updateTempLink(sx, sy) {
  const from = B.cards[g.from], s = sizes.get(g.from);
  if (!from || !s) return;
  const end = toWorld(sx, sy);
  const x1 = from.x + s.w, y1 = from.y + s.h / 2;
  const c = curve(x1, y1, end.x, end.y);
  tempPath.setAttribute('d', pathD(c));
  const over = document.elementFromPoint(sx, sy);
  const node = over && over.closest ? over.closest('.card:not(.ghost)') : null;
  const id = node && node.dataset.id !== g.from ? node.dataset.id : null;
  if (id !== linkHover) {
    if (linkHover && els.get(linkHover)) els.get(linkHover).classList.remove('linkTarget');
    if (id) node.classList.add('linkTarget');
    linkHover = id;
  }
}
function clearTempLink() {
  tempPath.setAttribute('d', '');
  if (linkHover && els.get(linkHover)) els.get(linkHover).classList.remove('linkTarget');
  linkHover = null;
}
function finishLink(from, sx, sy, cancelled) {
  const over = cancelled ? null : document.elementFromPoint(sx, sy);
  clearTempLink();
  const node = over && over.closest ? over.closest('.card:not(.ghost)') : null;
  const to = node ? node.dataset.id : null;
  if (!to || to === from) return;
  const L = cur();
  if (L.links.some((k) => pairKey(k.a, k.b) === pairKey(from, to))) { toast('Эти звенья уже связаны'); return; }
  L.links.push({ id: uid(), a: from, b: to });
  drawLinks(); save();
}

/* ---------- подключение событий ---------- */
board.addEventListener('pointerdown', onPointerDown);
addEventListener('pointermove', onPointerMove);
addEventListener('pointerup', onPointerUp);
addEventListener('pointercancel', onPointerUp);
board.addEventListener('wheel', (e) => {
  e.preventDefault();
  // ctrlKey = щипок на тачпаде; обычное колесо — плавнее
  const k = e.ctrlKey ? 0.01 : 0.0015;
  zoomAt(e.clientX, e.clientY, B.view.s * Math.exp(-e.deltaY * k));
}, { passive: false });
// отключаем системный зум Safari и «резинку»
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest || !e.target.closest('.sheet, #layerTabs')) e.preventDefault();
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
board.addEventListener('contextmenu', (e) => e.preventDefault());

/* ====================== actions ====================== */
function switchLayer(i) {
  if (i === B.current) return;
  B.current = i;
  sel.clear(); selLinks.clear();
  if (transferMode) exitTransfer();
  render(); save();
}

function enterTransfer() {
  if (!B.layers.some((l, i) => i !== B.current && l.cardIds.some((id) => !cur().cardIds.includes(id)))) {
    toast('На других слоях нет звеньев для переноса');
    return;
  }
  // скрытые слои на время переноса не показываются — предупредим
  const hiddenWithCards = B.layers.some((l, i) => i !== B.current && !l.visible && l.cardIds.length);
  transferMode = true;
  picked.clear(); sel.clear(); selLinks.clear();
  render();
  toast(hiddenWithCards ? 'Отметьте звенья. Скрытые слои не показаны — включите их в «Слоях»' : 'Отметьте звенья тапом и нажмите «Перенести»', 3000);
}
function exitTransfer() {
  transferMode = false;
  picked.clear();
  render();
}
function doTransfer() {
  const L = cur();
  const ids = [...picked].filter((id) => B.cards[id] && !L.cardIds.includes(id));
  if (!ids.length) { exitTransfer(); return; }
  L.cardIds.push(...ids);
  const now = new Set(L.cardIds), moved = new Set(ids);
  const have = new Set(L.links.map((k) => pairKey(k.a, k.b)));
  let nLinks = 0;
  B.layers.forEach((l, i) => {
    if (i === B.current) return;
    for (const k of l.links) {
      if (!(moved.has(k.a) || moved.has(k.b))) continue;
      if (!now.has(k.a) || !now.has(k.b)) continue;
      const key = pairKey(k.a, k.b);
      if (have.has(key)) continue;
      have.add(key);
      L.links.push({ id: uid(), a: k.a, b: k.b });
      nLinks++;
    }
  });
  transferMode = false;
  picked.clear();
  render(); save();
  toast(`Перенесено звеньев: ${ids.length}, ниточек: ${nLinks}`);
}

function removeFromLayer(id, li) {
  const L = B.layers[li];
  L.cardIds = L.cardIds.filter((x) => x !== id);
  L.links = L.links.filter((k) => k.a !== id && k.b !== id);
  if (!layersOf(id).length) deleteCard(id);
}
function deleteCard(id) {
  for (const L of B.layers) {
    L.cardIds = L.cardIds.filter((x) => x !== id);
    L.links = L.links.filter((k) => k.a !== id && k.b !== id);
  }
  const c = B.cards[id];
  if (c) forgetImage(c.imageId);
  delete B.cards[id];
}

async function deleteSelection() {
  const ids = [...sel];
  let mode = null;
  if (ids.length) {
    const multi = ids.some((id) => layersOf(id).length > 1);
    if (multi) {
      mode = await choose(ids.length > 1 ? 'Некоторые звенья есть и на других слоях' : 'Звено есть и на других слоях', [
        { label: 'Убрать только с этого слоя', value: 'here' },
        { label: 'Удалить со всех слоёв', value: 'all', danger: true },
      ]);
    } else {
      mode = await choose(ids.length > 1 ? `Удалить звенья (${ids.length})?` : 'Удалить звено?', [
        { label: 'Удалить', value: 'all', danger: true },
      ]);
    }
    if (!mode) return;
  }
  const L = cur();
  if (selLinks.size) L.links = L.links.filter((k) => !selLinks.has(k.id));
  for (const id of ids) (mode === 'all' ? deleteCard(id) : removeFromLayer(id, B.current));
  sel.clear(); selLinks.clear();
  render(); save();
}

/* ====================== sheets ====================== */
function sheet(build) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  const s = document.createElement('div');
  s.className = 'sheet';
  wrap.appendChild(s);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) { closeSheet(); wrap._onClose && wrap._onClose(); } });
  document.body.appendChild(wrap);
  build(s, wrap);
  return s;
}
function closeSheet() { document.querySelectorAll('.sheet-wrap').forEach((w) => w.remove()); }

function choose(title, options) {
  return new Promise((resolve) => {
    sheet((s, wrap) => {
      s.innerHTML = `<h3>${esc(title)}</h3>` +
        options.map((o, i) => `<button type="button" class="btn wide${o.danger ? ' danger' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('') +
        `<button type="button" class="btn wide" data-cancel>Отмена</button>`;
      wrap._onClose = () => resolve(null);
      s.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        closeSheet();
        resolve(b.hasAttribute('data-cancel') ? null : options[+b.dataset.i].value);
      });
    });
  });
}
function askText(title, value) {
  return new Promise((resolve) => {
    sheet((s, wrap) => {
      s.innerHTML = `<h3>${esc(title)}</h3><input type="text" maxlength="40" value="${esc(value)}">
        <div class="row"><button type="button" class="btn" data-c>Отмена</button><button type="button" class="btn primary" data-ok>Готово</button></div>`;
      const inp = s.querySelector('input');
      wrap._onClose = () => resolve(null);
      s.querySelector('[data-c]').onclick = () => { closeSheet(); resolve(null); };
      s.querySelector('[data-ok]').onclick = () => { closeSheet(); resolve(inp.value.trim() || null); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') s.querySelector('[data-ok]').click(); });
      setTimeout(() => inp.focus(), 50);
    });
  });
}

/* ---------- редактор звена ---------- */
function editCard(id) {
  const c = id ? B.cards[id] : null;
  let newPhoto = null;     // {blob, w, h}
  let removePhoto = false;
  let previewURL = null;
  sheet((s) => {
    s.innerHTML = `
      <h3>${c ? 'Звено' : 'Новое звено'}</h3>
      <div class="ph">
        <img id="pv" alt="" hidden>
        <div class="ph-btns">
          <button type="button" class="btn" id="bPick">Фото…</button>
          <button type="button" class="btn danger" id="bRm" hidden>Убрать фото</button>
        </div>
      </div>
      <textarea id="tx" placeholder="Текст звена или подпись к фото" autocapitalize="sentences"></textarea>
      <div class="row">
        <button type="button" class="btn" id="bCancel">Отмена</button>
        <button type="button" class="btn primary" id="bOk">Готово</button>
      </div>`;
    const pv = s.querySelector('#pv'), bRm = s.querySelector('#bRm'), tx = s.querySelector('#tx');
    tx.value = c ? c.text : '';
    const showPreview = (u) => { pv.hidden = !u; bRm.hidden = !u; if (u) pv.src = u; };
    if (c && c.imageId) imageURL(c.imageId).then(showPreview);

    const input = $('#photoInput');
    s.querySelector('#bPick').onclick = () => {
      input.value = '';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          toast('Обработка фото…', 8000);
          newPhoto = await shrinkImage(f);
          removePhoto = false;
          if (previewURL) URL.revokeObjectURL(previewURL);
          previewURL = URL.createObjectURL(newPhoto.blob);
          showPreview(previewURL);
          toast('Фото готово', 1000);
        } catch (err) {
          toast(err.message, 3000);
        }
      };
      input.click();
    };
    bRm.onclick = () => { newPhoto = null; removePhoto = true; showPreview(null); };
    const done = () => { if (previewURL) URL.revokeObjectURL(previewURL); closeSheet(); };
    s.querySelector('#bCancel').onclick = done;
    s.querySelector('#bOk').onclick = async () => {
      const text = tx.value.replace(/\s+$/, '');
      const willHavePhoto = !!newPhoto || (c && c.imageId && !removePhoto);
      if (!text && !willHavePhoto) { toast('Добавьте текст или фото'); return; }
      try {
        let imageId = c ? c.imageId || null : null, imgW = c && c.imgW, imgH = c && c.imgH;
        if (newPhoto) {
          const nid = uid();
          await imgSet(nid, newPhoto.blob);
          if (imageId) forgetImage(imageId);
          imageId = nid; imgW = newPhoto.w; imgH = newPhoto.h;
        } else if (removePhoto && imageId) {
          forgetImage(imageId);
          imageId = null; imgW = imgH = undefined;
        }
        if (c) {
          Object.assign(c, { text, imageId, imgW, imgH });
        } else {
          const p = toWorld(innerWidth / 2, innerHeight / 2);
          const nc = {
            id: uid(), text, imageId, imgW, imgH,
            x: Math.round(p.x - 110 + (Math.random() * 40 - 20)),
            y: Math.round(p.y - 70 + (Math.random() * 40 - 20)),
          };
          B.cards[nc.id] = nc;
          cur().cardIds.push(nc.id);
        }
        done();
        render(); save();
      } catch (err) {
        toast('Не удалось сохранить фото: ' + err.message, 4000);
      }
    };
  });
}

/* ---------- слои ---------- */
function layersSheet() {
  sheet((s) => {
    const draw = () => {
      s.innerHTML = `<h3>Слои</h3>` + B.layers.map((l, i) => `
        <div class="lrow${i === B.current ? ' cur' : ''}">
          <button type="button" class="btn lname" data-go="${i}">${i + 1}. ${esc(l.name)}<small>звеньев: ${l.cardIds.length} · ниточек: ${l.links.length}</small></button>
          <button type="button" class="btn icon" data-vis="${i}" ${i === B.current ? 'disabled' : ''} aria-label="Видимость в подложке">${l.visible ? '👁' : '◌'}</button>
          <button type="button" class="btn icon" data-ren="${i}" aria-label="Переименовать">✎</button>
        </div>`).join('') + `
        <div class="row">
          <button type="button" class="btn" data-add>+ Новый слой</button>
          <button type="button" class="btn danger" data-del ${B.layers.length <= 1 ? 'disabled' : ''}>Удалить текущий</button>
        </div>
        <p>Полупрозрачные звенья — с других слоёв (метка L2 = слой 2). 👁/◌ — показывать ли слой подложкой.</p>
        <button type="button" class="btn" data-close>Закрыть</button>`;
    };
    draw();
    s.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.go) { switchLayer(+b.dataset.go); closeSheet(); }
      else if (b.dataset.vis) {
        const l = B.layers[+b.dataset.vis];
        l.visible = !l.visible;
        render(); save(); draw();
      } else if (b.dataset.ren) {
        const i = +b.dataset.ren;
        const name = await askText('Название слоя', B.layers[i].name);
        if (name) { B.layers[i].name = name; render(); save(); }
        layersSheet();
      } else if (b.hasAttribute('data-add')) {
        B.layers.push(newLayer(B.layers.length));
        switchLayer(B.layers.length - 1);
        render(); save(); draw();
      } else if (b.hasAttribute('data-del')) {
        const L = cur();
        const ok = await choose(`Удалить «${L.name}»? Звенья, которых нет на других слоях, удалятся.`, [{ label: 'Удалить слой', value: 1, danger: true }]);
        if (ok) {
          const idx = B.current;
          for (const id of [...L.cardIds]) removeFromLayer(id, idx);
          B.layers.splice(idx, 1);
          if (B.layers.length < MIN_LAYERS) B.layers.push(newLayer(B.layers.length));
          B.current = Math.max(0, idx - 1);
          sel.clear(); selLinks.clear();
          render(); save();
        }
        layersSheet();
      } else if (b.hasAttribute('data-close')) closeSheet();
    });
  });
}

/* ---------- меню ---------- */
function menuSheet() {
  sheet((s) => {
    s.innerHTML = `
      <h3>LinkBoard</h3>
      <button type="button" class="btn wide" data-m="export">Экспорт доски в файл (резервная копия)</button>
      <button type="button" class="btn wide" data-m="import">Импорт из файла…</button>
      <button type="button" class="btn wide" data-m="selall">Выбрать все звенья слоя</button>
      <button type="button" class="btn wide" data-m="clear" ${sel.size || selLinks.size ? '' : 'disabled'}>Снять выделение</button>
      <button type="button" class="btn wide" data-m="help">Как пользоваться</button>
      <button type="button" class="btn wide" data-m="close">Закрыть</button>`;
    s.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      const m = b.dataset.m;
      if (m === 'export') { closeSheet(); exportBoard(); }
      else if (m === 'import') { closeSheet(); importBoard(); }
      else if (m === 'selall') { closeSheet(); cur().cardIds.forEach((id) => sel.add(id)); render(); }
      else if (m === 'clear') { closeSheet(); sel.clear(); selLinks.clear(); render(); }
      else if (m === 'help') helpSheet();
      else closeSheet();
    });
  });
}
function helpSheet() {
  sheet((s) => {
    s.innerHTML = `
      <h3>Как пользоваться</h3>
      <ul class="help">
        <li><b>＋ Звено</b> — фото из галереи/камеры и подпись, или просто текст.</li>
        <li><b>Двойной тап</b> по звену — выбрать / снять выбор (можно несколько). Двойной тап по пустому месту — снять весь выбор.</li>
        <li>Выбранные звенья <b>перетаскиваются</b> пальцем (все выбранные сразу).</li>
        <li><b>Ниточка</b>: тяните от красного кружка на правом краю звена к другому звену.</li>
        <li><b>Тап по ниточке</b> выделяет её; «Удалить» убирает выделенные ниточки и звенья.</li>
        <li><b>Один палец</b> по пустому месту или невыбранному звену — сдвиг доски. <b>Два пальца</b> — масштаб.</li>
        <li><b>Слои</b> 1–5 сверху. Звенья других слоёв видны полупрозрачными. Тап по названию слоя — переименовать, скрыть, добавить слой.</li>
        <li><b>Перенос</b>: нажмите «Перенос», отметьте полупрозрачные звенья и «Перенести». Ниточки между ними (и с уже перенесёнными) тоже переедут. Звено переносится ссылкой: текст, фото и место общие на всех слоях, а ниточки у каждого слоя свои.</li>
        <li>Всё сохраняется само на устройстве. Делайте <b>экспорт</b> в файл как резервную копию.</li>
      </ul>
      <button type="button" class="btn" data-close>Понятно</button>`;
    s.querySelector('[data-close]').onclick = closeSheet;
  });
}

/* ---------- экспорт / импорт ---------- */
const blobToDataURL = (b) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});
async function exportBoard() {
  try {
    flush();
    const images = {};
    for (const c of Object.values(B.cards)) {
      if (c.imageId && !images[c.imageId]) {
        const b = await imgGet(c.imageId);
        if (b) images[c.imageId] = await blobToDataURL(b);
      }
    }
    const data = { app: 'LinkBoard', format: 1, exported: new Date().toISOString(), board: B, images };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const d = new Date();
    const name = `linkboard-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // NotAllowedError (истёк жест пользователя) — падаем на обычное скачивание
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    toast('Файл сохранён: ' + name);
  } catch (err) {
    toast('Экспорт не удался: ' + err.message, 4000);
  }
}
function importBoard() {
  const input = $('#importInput');
  input.value = '';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.app !== 'LinkBoard' || !data.board) throw new Error('это не файл LinkBoard');
      const ok = await choose('Заменить текущую доску содержимым файла?', [{ label: 'Заменить', value: 1, danger: true }]);
      if (!ok) return;
      toast('Импорт…', 10000);
      await imgClear();
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
      for (const [id, durl] of Object.entries(data.images || {})) {
        const blob = await (await fetch(durl)).blob();
        await imgSet(id, blob);
      }
      for (const el of els.values()) el.remove();
      els.clear(); sizes.clear();
      sel.clear(); selLinks.clear(); picked.clear(); transferMode = false;
      B = normalize(data.board);
      await kvSet('board', B);
      applyView(); render();
      toast('Доска загружена');
    } catch (err) {
      toast('Импорт не удался: ' + err.message, 4000);
    }
  };
  input.click();
}

/* ====================== toolbar wiring ====================== */
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'add') editCard(null);
  else if (act === 'transfer') (transferMode ? exitTransfer() : enterTransfer());
  else if (act === 'edit') { if (sel.size === 1) editCard([...sel][0]); }
  else if (act === 'delete') deleteSelection();
  else if (act === 'fit') fitAll();
  else if (act === 'menu') menuSheet();
});
$('#layerTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layer]');
  if (!b) return;
  const i = +b.dataset.layer;
  if (i === B.current) layersSheet(); else switchLayer(i);
});
$('#layerLabel').addEventListener('click', layersSheet);
$('#trCancel').addEventListener('click', exitTransfer);
$('#trOk').addEventListener('click', doTransfer);
addEventListener('resize', () => { if (B) drawLinks(); });

/* ====================== start ====================== */
(async function init() {
  try {
    B = normalize(await kvGet('board'));
  } catch (err) {
    B = newBoard();
    toast('Хранилище недоступно — изменения не сохранятся: ' + err.message, 5000);
  }
  if (!B.layers) B = newBoard();
  applyView();
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
