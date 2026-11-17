/* Clayer Bear admin: figures, orders, look, settings, Instagram posts.
   The password is checked by the Worker on every call. It is kept only for
   this browser tab (sessionStorage) and never stored anywhere else. */

let password = '';
try { password = sessionStorage.getItem('cb-admin') || ''; } catch {}

let data = null;          // last /api/admin/overview
let editing = null;       // figure open in the editor
const selected = new Set();

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter(Boolean));
  return n;
};
const money = (c) => (c == null ? '' : '$' + (c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)));
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const say = (id, text, kind) => { const p = $(id); p.textContent = text; p.className = 'msg' + (kind ? ' ' + kind : ''); };

async function api(route, options = {}) {
  const res = await fetch('/api/admin/' + route, { ...options, headers: { authorization: 'Bearer ' + password, ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'That did not work. Try again.'), { status: res.status });
  return body;
}
const post = (route, payload) => api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const upload = (route, blob, name = 'photo.jpg') => { const f = new FormData(); f.append('file', blob, name); return api(route, { method: 'POST', body: f }); };

/* ---------- photos: shrink in the browser before uploading ---------- */

async function loadBitmap(source) {
  if (source instanceof Blob && 'createImageBitmap' in window) {
    try { return await createImageBitmap(source, { imageOrientation: 'from-image' }); } catch {}
  }
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { if (source instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

// Draws (a crop of) an image at a sensible size and returns a JPEG blob.
async function toJpeg(source, { maxSide = 2000, minRatio = 0, maxRatio = Infinity, quality = 0.88 } = {}) {
  const img = await loadBitmap(source);
  const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
  let cw = w, ch = h;
  if (w / h < minRatio) ch = Math.round(w / minRatio);        // too tall: trim top and bottom
  else if (w / h > maxRatio) cw = Math.round(h * maxRatio);   // too wide: trim the sides
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cw * scale); canvas.height = Math.round(ch * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo.'))), 'image/jpeg', quality));
}

/* ---------- loading and tabs ---------- */

async function load() {
  try { data = await api('overview'); }
  catch (err) {
    $('app').hidden = true; $('login').hidden = false;
    say('login-msg', password ? err.message : '', 'bad');
    return false;
  }
  try { sessionStorage.setItem('cb-admin', password); } catch {}
  $('login').hidden = true; $('app').hidden = false;
  drawItems(); drawOrders(); drawSettings();
  if (!lookDirty) drawLook();
  return true;
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    b.setAttribute('aria-selected', String(b === tab));
    $('tab-' + b.dataset.tab).hidden = b !== tab;
  }
});

$('login').addEventListener('submit', (e) => { e.preventDefault(); password = $('pw').value; load(); });

/* ---------- figures: list ---------- */

const STATUS_LABEL = { draft: 'Draft', available: 'On the shelf', sold: 'Sold', hidden: 'Hidden' };

function drawItems() {
  const q = $('item-search').value.trim().toLowerCase();
  const status = $('item-status').value;
  const shown = data.items.filter((i) => (!status || i.status === status)
    && (!q || [i.title, i.category, ...i.tags].join(' ').toLowerCase().includes(q)));
  for (const id of [...selected]) if (!data.items.some((i) => i.id === id)) selected.delete(id);

  $('item-list').replaceChildren(...(shown.length ? shown.map((i) => el('li', { class: 'row' },
    el('input', { type: 'checkbox', checked: selected.has(i.id), 'aria-label': 'Select ' + i.title,
      onchange: (e) => { e.target.checked ? selected.add(i.id) : selected.delete(i.id); drawSelection(); } }),
    el('img', { src: i.photo_keys[0] ? '/img/' + i.photo_keys[0] : '', alt: '' }),
    el('button', { class: 'row-main', type: 'button', onclick: () => openEditor(i.id) },
      el('strong', { text: i.title }),
      el('small', { text: [i.category, i.grams ? i.grams + 'g' : '', money(i.price_cents), i.photo_keys.length + (i.photo_keys.length === 1 ? ' photo' : ' photos')].filter(Boolean).join(', ') })),
    el('span', { class: 'pill ' + (i.on_hold ? 'hold' : i.status), text: i.on_hold ? 'Being bought' : STATUS_LABEL[i.status] })
  )) : [el('li', { class: 'hint', text: data.items.length ? 'Nothing matches.' : 'No figures yet. Press "New figure" to add the first one.' })]));

  $('category-list').replaceChildren(...[...new Set(data.items.map((i) => i.category).filter(Boolean))].sort().map((c) => el('option', { value: c })));
  drawSelection();
}
function drawSelection() {
  $('selection').hidden = selected.size === 0;
  $('selection-count').textContent = selected.size + ' selected';
}
$('item-search').addEventListener('input', drawItems);
$('item-status').addEventListener('change', drawItems);
$('clear-selected').addEventListener('click', () => { selected.clear(); drawItems(); });
$('post-selected').addEventListener('click', () => openComposer(data.items.filter((i) => selected.has(i.id))));

$('new-item').addEventListener('click', async () => {
  const { id } = await post('items', {});
  await load();
  openEditor(id);
});

/* ---------- figures: editor ---------- */

function openEditor(id) {
  editing = data.items.find((i) => i.id === id);
  if (!editing) return;
  $('list-view').hidden = true; $('editor').hidden = false;
  $('editor-heading').textContent = editing.title;
  $('f-title').value = editing.title === 'New figure' && !editing.photo_keys.length ? '' : editing.title;
  $('f-description').value = editing.description;
  $('f-category').value = editing.category;
  $('f-tags').value = editing.tags.join(', ');
  $('f-grams').value = editing.grams ?? '';
  const auto = editing.grams ? editing.grams * data.settings.price_per_gram_cents : null;
  $('f-price').value = editing.price_cents != null && editing.price_cents !== auto ? editing.price_cents / 100 : '';
  $('f-status').value = editing.status;
  drawPriceHint(); drawPhotos();
  say('editor-msg', ''); say('photo-msg', '');
  armDelete(false);
  window.scrollTo(0, 0);
}
function closeEditor() { editing = null; $('editor').hidden = true; $('list-view').hidden = false; drawItems(); }
$('back').addEventListener('click', closeEditor);

function drawPriceHint() {
  const g = Number($('f-grams').value);
  $('f-price').placeholder = g ? String((g * data.settings.price_per_gram_cents) / 100) : '';
  $('price-hint').textContent = g ? 'Leave blank to use the weight price.' : 'Or enter a weight.';
}
$('f-grams').addEventListener('input', drawPriceHint);

function drawPhotos() {
  const keys = editing.photo_keys;
  const move = (i, d) => { const k = [...keys]; [k[i], k[i + d]] = [k[i + d], k[i]]; savePhotos(k); };
  $('photo-list').replaceChildren(...keys.map((k, i) => el('li', {},
    el('img', { src: '/img/' + k, alt: 'Photo ' + (i + 1) }),
    el('div', { class: 'tools' },
      el('button', { type: 'button', 'aria-label': 'Move earlier', disabled: i === 0, text: '←', onclick: () => move(i, -1) }),
      el('button', { type: 'button', 'aria-label': 'Move later', disabled: i === keys.length - 1, text: '→', onclick: () => move(i, 1) }),
      el('button', { type: 'button', 'aria-label': 'Remove photo', text: 'Remove', onclick: () => savePhotos(keys.filter((x) => x !== k)) }))
  )));
}
async function savePhotos(keys) {
  try {
    await post('items/' + editing.id, { photo_keys: keys, status: keys.length ? editing.status : (editing.status === 'available' ? 'draft' : editing.status) });
    await refreshEditing();
  } catch (err) { say('photo-msg', err.message, 'bad'); }
}
async function refreshEditing() {
  const id = editing.id;
  await load();
  editing = data.items.find((i) => i.id === id);
  if (editing) drawPhotos();
}

$('add-photos').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let done = 0;
  for (const file of files) {
    say('photo-msg', `Uploading ${done + 1} of ${files.length}…`);
    try { await upload(`items/${editing.id}/photos`, await toJpeg(file)); done++; }
    catch (err) { say('photo-msg', `${file.name}: ${err.message}`, 'bad'); await refreshEditing(); return; }
  }
  await refreshEditing();
  say('photo-msg', done === 1 ? 'Photo added.' : done + ' photos added.', 'good');
});

async function saveEditor() {
  const price = $('f-price').value.trim();
  await post('items/' + editing.id, {
    title: $('f-title').value, description: $('f-description').value, category: $('f-category').value,
    tags: $('f-tags').value, grams: $('f-grams').value, price_cents: price === '' ? null : Math.round(Number(price) * 100),
    status: $('f-status').value,
  });
  await refreshEditing();
  $('editor-heading').textContent = editing.title;
}
$('editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('f-title').value.trim()) { say('editor-msg', 'Give it a name first.', 'bad'); return; }
  try { await saveEditor(); say('editor-msg', 'Saved.', 'good'); }
  catch (err) { say('editor-msg', err.message, 'bad'); }
});

// Delete asks twice instead of using a pop-up.
let deleteArmed = false;
function armDelete(on) { deleteArmed = on; $('delete-item').textContent = on ? 'Really delete? Press again' : 'Delete'; }
$('delete-item').addEventListener('click', async () => {
  if (!deleteArmed) { armDelete(true); setTimeout(() => armDelete(false), 4000); return; }
  await api('items/' + editing.id, { method: 'DELETE' });
  selected.delete(editing.id);
  await load();
  closeEditor();
});

$('post-one').addEventListener('click', async () => {
  try { await saveEditor(); } catch (err) { say('editor-msg', err.message, 'bad'); return; }
  openComposer([editing]);
});

/* ---------- Instagram composer ---------- */

const IG_MIN = 4 / 5, IG_MAX = 1.91;
let composing = [];   // figures in this post
let igPicks = [];     // [{ key, checked }]

function draftCaption(figs) {
  const one = figs.length === 1 ? figs[0] : null;
  const lines = [];
  if (one) {
    lines.push(one.title);
    if (one.description) lines.push('', one.description);
    if (one.price_cents != null && one.status === 'available') lines.push('', (one.grams ? one.grams + 'g, ' : '') + money(one.price_cents));
  } else {
    lines.push(figs.map((f) => f.title).join(', '));
    const forSale = figs.filter((f) => f.status === 'available' && f.price_cents != null);
    if (forSale.length) lines.push('', ...forSale.map((f) => `${f.title}: ${money(f.price_cents)}`));
  }
  if (figs.some((f) => f.status === 'available')) lines.push('', 'On the shelf at clayerbear.com');
  const tags = new Set();
  for (const f of figs) for (const t of f.tags) tags.add('#' + t.replace(/[^\p{L}\p{N}_]/gu, ''));
  for (const t of (data.settings.ig_default_tags || '').split(/\s+/)) if (t.startsWith('#')) tags.add(t);
  tags.delete('#');
  if (tags.size) lines.push('', [...tags].join(' '));
  return lines.join('\n');
}

function openComposer(figs) {
  figs = figs.filter((f) => f.photo_keys.length);
  if (!figs.length) { alertMsg('Add a photo first.'); return; }
  composing = figs;
  const ig = data.instagram;
  $('ig-account').textContent = ig.connected ? 'Posting as @' + ig.username
    : 'Instagram is not connected yet' + (ig.error ? ': ' + ig.error : '. See "Shop settings" for what is needed.');
  $('ig-publish').disabled = !ig.connected;
  // First photo of each figure is ticked to start with.
  igPicks = figs.flatMap((f) => f.photo_keys.map((key, i) => ({ key, title: f.title, checked: i === 0 || figs.length === 1 })));
  let n = 0;
  for (const p of igPicks) { if (p.checked && ++n > data.limits.carousel) p.checked = false; }
  drawPicks();
  $('ig-caption').value = draftCaption(figs);
  countCaption();
  say('ig-msg', '');
  $('ig-dialog').showModal();
}
function alertMsg(text) { say(editing ? 'editor-msg' : 'photo-msg', text, 'bad'); }

function drawPicks() {
  const count = igPicks.filter((p) => p.checked).length;
  $('ig-photo-count').textContent = `${count} of up to ${data.limits.carousel}`;
  $('ig-photos').replaceChildren(...igPicks.map((p) => el('li', {}, el('label', {},
    el('input', { type: 'checkbox', checked: p.checked, onchange: (e) => {
      if (e.target.checked && count >= data.limits.carousel) { e.target.checked = false; return; }
      p.checked = e.target.checked; drawPicks();
    } }),
    el('img', { src: '/img/' + p.key, alt: p.title }),
    composing.length > 1 ? p.title : null))));
}
function countCaption() {
  const n = $('ig-caption').value.length;
  $('ig-caption-count').textContent = `${n} of ${data.limits.caption} characters`;
}
$('ig-caption').addEventListener('input', countCaption);
$('ig-close').addEventListener('click', () => $('ig-dialog').close());

$('ig-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const picks = igPicks.filter((p) => p.checked);
  if (!picks.length) { say('ig-msg', 'Tick at least one photo.', 'bad'); return; }
  if ($('ig-caption').value.length > data.limits.caption) { say('ig-msg', 'The caption is too long for Instagram.', 'bad'); return; }
  $('ig-publish').disabled = true;
  try {
    const keys = [];
    for (const [i, p] of picks.entries()) {
      say('ig-msg', `Preparing photo ${i + 1} of ${picks.length}…`);
      const blob = await toJpeg('/img/' + p.key, { maxSide: 1440, minRatio: IG_MIN, maxRatio: IG_MAX, quality: 0.9 });
      keys.push((await upload('upload?kind=ig', blob)).key);
    }
    say('ig-msg', 'Publishing…');
    const out = await post('instagram/post', { keys, caption: $('ig-caption').value, item_ids: composing.map((f) => f.id) });
    const msg = $('ig-msg');
    msg.className = 'msg good';
    msg.replaceChildren('Posted. ', out.permalink ? el('a', { href: out.permalink, target: '_blank', rel: 'noopener', text: 'See it on Instagram' }) : '');
    selected.clear();
    await load();
  } catch (err) {
    say('ig-msg', err.message, 'bad');
  } finally { $('ig-publish').disabled = !data.instagram.connected; }
});

/* ---------- orders and requests ---------- */

function drawOrders() {
  const open = data.orders.filter((o) => o.status === 'paid').length + data.requests.filter((r) => !r.handled).length;
  $('orders-count').hidden = !open; $('orders-count').textContent = open;

  $('order-list').replaceChildren(...(data.orders.length ? data.orders.map((o) => {
    const a = o.address;
    return el('li', { class: 'row plain' + (o.status === 'shipped' ? ' done' : '') }, el('div', {},
      el('strong', { text: `${o.name || 'Someone'} bought ${o.items.map((i) => i.title).join(', ')}` }),
      el('div', { class: 'hint', text: `${when(o.paid_at)}. Total ${money(o.total_cents)}` + (o.shipping_cents != null ? `, of which shipping ${money(o.shipping_cents)}` : '') }),
      a ? el('pre', { text: [o.name, a.line1, a.line2, `${a.city || ''}, ${a.state || ''} ${a.postal_code || ''}`, a.country !== 'US' ? a.country : ''].filter(Boolean).join('\n') }) : el('div', { class: 'hint', text: 'No shipping address on this order.' }),
      el('div', { class: 'line' },
        o.email ? el('a', { href: 'mailto:' + o.email, text: o.email }) : null,
        el('button', { class: 'btn quiet', type: 'button', text: o.status === 'shipped' ? 'Mark as not sent' : 'Mark as sent',
          onclick: async () => { await post('orders/' + o.id, { shipped: o.status !== 'shipped' }); load(); } }))));
  }) : [el('li', { class: 'hint', text: 'No orders yet.' })]));

  $('request-list').replaceChildren(...(data.requests.length ? data.requests.map((r) => {
    const what = r.kind === 'buy' ? `wants to buy ${r.item_title || 'a figure'}` : r.kind === 'like' ? `wants one like ${r.item_title || 'a sold figure'}` : 'wants a custom figure';
    const img = r.photo_key ? el('img', { alt: 'Photo they sent' }) : null;
    if (img) fetch('/api/admin/photo/' + r.photo_key, { headers: { authorization: 'Bearer ' + password } })
      .then((res) => (res.ok ? res.blob() : null)).then((b) => { if (b) img.src = URL.createObjectURL(b); });
    return el('li', { class: 'row ' + (img ? 'with-photo' : 'plain') + (r.handled ? ' done' : '') }, img, el('div', {},
      el('strong', { text: `${r.name} ${what}` }),
      el('div', { class: 'hint', text: when(r.created_at) + (r.grams ? `, ${r.grams}g` : '') }),
      r.message ? el('pre', { text: r.message }) : null,
      el('div', { class: 'line' },
        el('a', { href: 'mailto:' + r.email, text: r.email }),
        el('button', { class: 'btn quiet', type: 'button', text: r.handled ? 'Mark as open' : 'Mark as done',
          onclick: async () => { await post('requests/' + r.id, { handled: !r.handled }); load(); } }))));
  }) : [el('li', { class: 'hint', text: 'No requests yet.' })]));
}

/* ---------- look ---------- */

const COLOR_FIELDS = [
  ['paper', 'Background', 'Behind everything'],
  ['card', 'Panels', 'Shop shelf area, forms'],
  ['text', 'Text', 'All writing, and "bear" in the logo'],
  ['button', 'Buttons and links', 'Needs to be dark enough for white text'],
  ['logo', 'Logo green', '"clayer" in the logo'],
  ['accent', 'Accent', 'Shapes, outlines, highlights'],
  ['wash', 'Soft accent', 'Pale bands and chips'],
];
const PRESETS = [
  ['Market sign', { paper: '#f3f1fa', card: '#ffffff', text: '#33241d', button: '#5f6c3f', logo: '#8c9a66', accent: '#b9a8e6', wash: '#e4ddf7' }],
  ['Oat and moss', { paper: '#f2f0e6', card: '#fffdf7', text: '#2f2a22', button: '#4f6238', logo: '#7f9460', accent: '#d9b98a', wash: '#ebe4d2' }],
  ['Blueberry', { paper: '#eef2fa', card: '#ffffff', text: '#232a3d', button: '#3f4f8c', logo: '#6f84c4', accent: '#f0b7c4', wash: '#dfe6f6' }],
  ['Night shelf', { paper: '#2a2530', card: '#3a3442', text: '#f4f0f8', button: '#5f7040', logo: '#a9b983', accent: '#b9a8e6', wash: '#4a4356' }],
];
let look = null;       // working copy of the theme
let lookDirty = false;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function drawLook() {
  look = JSON.parse(JSON.stringify(data.theme));
  lookDirty = false;
  $('presets').replaceChildren(...PRESETS.map(([name, colors]) => el('button', { type: 'button', onclick: () => { look.colors = { ...colors }; lookChanged(); drawColors(); } },
    el('i', {}, ...['paper', 'text', 'button', 'accent'].map((k) => el('b', { style: 'background:' + colors[k] }))), name)));
  drawColors(); drawFonts(); drawImages(); preview();
  say('look-msg', '');
}
function lookChanged() { lookDirty = true; preview(); }

function drawColors() {
  $('colors').replaceChildren(...COLOR_FIELDS.map(([key, label, hint]) => el('label', {},
    el('input', { type: 'color', value: look.colors[key], oninput: (e) => { look.colors[key] = e.target.value; lookChanged(); } }),
    el('span', {}, label, el('small', { text: hint })))));
}

function drawFonts() {
  const names = [...data.bundled_fonts, ...look.custom_fonts.map((f) => f.name)];
  for (const role of ['head', 'body', 'hand']) {
    const sel = $('font-' + role);
    sel.replaceChildren(...names.map((n) => el('option', { value: n, text: n, selected: n === look.fonts[role], style: `font-family:"${n}"` })));
    sel.onchange = () => { look.fonts[role] = sel.value; lookChanged(); };
  }
  $('custom-fonts').replaceChildren(...look.custom_fonts.map((f) => el('li', {},
    el('span', { text: f.name, style: `font-family:"${f.name}"; font-size:1.2rem` }),
    el('button', { class: 'link', type: 'button', text: 'Remove', onclick: () => {
      look.custom_fonts = look.custom_fonts.filter((x) => x !== f);
      for (const r of ['head', 'body', 'hand']) if (look.fonts[r] === f.name) look.fonts[r] = { head: 'Fredoka', body: 'Fredoka', hand: 'Patrick Hand' }[r];
      lookChanged(); drawFonts();
    } }))));
  // Make uploaded fonts usable on this page (lists and preview).
  let style = $('custom-font-faces');
  if (!style) { style = el('style', { id: 'custom-font-faces' }); document.head.append(style); }
  style.textContent = look.custom_fonts.map((f) => `@font-face{font-family:"${f.name}";src:url("/img/${f.key}")}`).join('\n');
}

$('font-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const name = ($('font-name').value.trim() || file.name.replace(/\.[^.]+$/, '')).replace(/[^A-Za-z0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) { say('look-msg', 'Give the font a name using letters and numbers.', 'bad'); return; }
  if ([...data.bundled_fonts, ...look.custom_fonts.map((f) => f.name)].includes(name)) { say('look-msg', 'There is already a font with that name.', 'bad'); return; }
  try {
    const { key } = await upload('upload?kind=font', file, file.name);
    look.custom_fonts.push({ name, key });
    $('font-name').value = '';
    lookChanged(); drawFonts();
    say('look-msg', `"${name}" added. Pick it in the lists above, then save.`, 'good');
  } catch (err) { say('look-msg', err.message, 'bad'); }
});

const IMAGE_SLOTS = [
  ['logo_key', 'Logo', 'Replaces the "clayer bear" lettering in the header. A PNG or SVG with a clear background works best.', 1200],
  ['favicon_key', 'Browser tab icon', 'A small square mark.', 256],
  ['hero_key', 'Front page photo', 'The big photo beside the headline.', 1600],
];
function drawImages() {
  $('images').replaceChildren(...IMAGE_SLOTS.map(([key, label, hint, max]) => el('div', { class: 'slot' },
    el('strong', { text: label }), el('small', { text: hint }),
    look[key] ? el('img', { src: '/img/' + look[key], alt: label }) : null,
    el('div', { class: 'line' },
      el('label', { class: 'btn quiet file' }, look[key] ? 'Replace' : 'Upload', el('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          // Keep SVG and PNG as they are (clear backgrounds); shrink big photos.
          const keep = file.type === 'image/svg+xml' || (file.type === 'image/png' && file.size < 1.5e6);
          const { key: k } = await upload('upload?kind=site', keep ? file : await toJpeg(file, { maxSide: max }), file.name);
          look[key] = k; lookChanged(); drawImages();
        } catch (err) { say('look-msg', err.message, 'bad'); }
      } })),
      look[key] ? el('button', { class: 'btn quiet', type: 'button', text: 'Remove', onclick: () => { look[key] = null; lookChanged(); drawImages(); } }) : null))));
}

function preview() {
  const c = look.colors, pv = $('pv');
  const vars = { '--paper': c.paper, '--card': c.card, '--cocoa': c.text, '--sage-deep': c.button, '--sage': c.logo, '--lavender': c.accent, '--lilac-wash': c.wash,
    '--font-head': `"${look.fonts.head}", sans-serif`, '--font-body': `"${look.fonts.body}", sans-serif`, '--font-hand': `"${look.fonts.hand}", cursive` };
  for (const [k, v] of Object.entries(vars)) pv.style.setProperty(k, v);
  $('pv-logo').replaceChildren(...(look.logo_key ? [el('img', { src: '/img/' + look.logo_key, alt: 'Logo' })]
    : [el('span', { class: 'pv-clayer', text: 'clayer' }), el('span', { class: 'pv-bear', text: 'bear' })]));
  const warnings = [];
  if (contrast(c.text, c.paper) < 4.5) warnings.push('Text is hard to read on this background.');
  if (contrast(c.text, c.card) < 4.5) warnings.push('Text is hard to read on the panels.');
  if (contrast('#ffffff', c.button) < 4.5) warnings.push('White button text is hard to read on this button color.');
  $('contrast-msg').textContent = warnings.join(' ');
}

$('look-undo').addEventListener('click', drawLook);
$('look-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await post('theme', look);
    lookDirty = false;
    await load();
    say('look-msg', 'Saved. The shop picks it up within a minute.', 'good');
  } catch (err) { say('look-msg', err.message, 'bad'); }
});

/* ---------- settings ---------- */

function drawSettings() {
  const s = data.settings;
  $('s-hero-title').value = s.hero_title; $('s-hero-text').value = s.hero_text;
  $('s-per-gram').value = s.price_per_gram_cents / 100; $('s-ship').value = s.shipping_cents / 100;
  $('s-ship-label').value = s.shipping_label; $('s-pickup').checked = s.pickup; $('s-pickup-label').value = s.pickup_label;
  $('s-ig-tags').value = s.ig_default_tags;

  const ig = data.instagram, st = data.stripe;
  $('connections').replaceChildren(
    el('li', {}, el('strong', { text: 'Card payments (Stripe): ' + (st.checkout && st.webhook ? 'on' : st.checkout ? 'half set up' : 'off') }),
      st.checkout && st.webhook ? 'Buyers pay by card and paid figures are marked sold automatically.'
        : st.checkout ? 'Buyers can pay, but the site is not being told about payments. The STRIPE_WEBHOOK_SECRET still needs setting.'
        : 'Until the Stripe keys are added, buyers send a request instead of paying on the site.'),
    el('li', {}, el('strong', { text: 'Instagram: ' + (ig.connected ? 'connected as @' + ig.username : 'not connected') }),
      ig.error ? el('span', { class: 'msg bad', text: ig.error }) : ig.connected ? 'You can post figures from the Figures tab.' : 'The Instagram token has not been added yet.'));
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dollars = (id) => Math.round(Number($(id).value) * 100);
  try {
    await post('settings', {
      hero_title: $('s-hero-title').value, hero_text: $('s-hero-text').value,
      price_per_gram_cents: dollars('s-per-gram'), shipping_cents: dollars('s-ship'), shipping_label: $('s-ship-label').value,
      pickup: $('s-pickup').checked, pickup_label: $('s-pickup-label').value, ig_default_tags: $('s-ig-tags').value,
    });
    await load();
    say('settings-msg', 'Saved.', 'good');
  } catch (err) { say('settings-msg', err.message, 'bad'); }
});

if (password) load();
