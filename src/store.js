// Shared pieces: database setup, settings, theme defaults, small helpers.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
export const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
export const clean = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);

export const STATUSES = ['draft', 'available', 'sold', 'hidden'];
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'manual', title TEXT NOT NULL, caption TEXT,
     grams INTEGER, price_cents INTEGER, status TEXT NOT NULL DEFAULT 'available',
     image_key TEXT, permalink TEXT, posted_at INTEGER, locked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS photos (
     id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, key TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS photos_item ON photos (item_id, sort)`,
  `CREATE TABLE IF NOT EXISTS orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE, hold_token TEXT, status TEXT NOT NULL DEFAULT 'pending',
     email TEXT, name TEXT, address TEXT, items TEXT NOT NULL, subtotal_cents INTEGER, shipping_cents INTEGER,
     total_cents INTEGER, shipping_label TEXT, created_at INTEGER NOT NULL, paid_at INTEGER, shipped_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS requests (
     id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_id TEXT, name TEXT NOT NULL, email TEXT NOT NULL,
     message TEXT, grams INTEGER, photo_key TEXT, created_at INTEGER NOT NULL, handled INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
];
// Columns added after the first version. Each runs once; "duplicate column" is fine.
const COLUMNS = [
  'ALTER TABLE items ADD COLUMN description TEXT',
  'ALTER TABLE items ADD COLUMN category TEXT',
  "ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
  'ALTER TABLE items ADD COLUMN reserved_until INTEGER',
  'ALTER TABLE items ADD COLUMN reserved_by TEXT',
  'ALTER TABLE items ADD COLUMN ig_post_url TEXT',
];
const SCHEMA_VERSION = '2';
let schemaReady = false;

export async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(TABLES.map((sql) => env.DB.prepare(sql)));
  const v = await getMeta(env, 'schema_version');
  if (v !== SCHEMA_VERSION) {
    for (const sql of COLUMNS) {
      try { await env.DB.prepare(sql).run(); } catch (err) {
        if (!/duplicate column/i.test(String(err.message || err))) throw err;
      }
    }
    // Version 1 kept one photo per figure in items.image_key. Carry those over.
    await env.DB.prepare(
      `INSERT INTO photos (item_id, key, sort) SELECT id, image_key, 0 FROM items
       WHERE image_key IS NOT NULL AND id NOT IN (SELECT item_id FROM photos)`
    ).run();
    await setMeta(env, 'schema_version', SCHEMA_VERSION);
  }
  schemaReady = true;
}

export async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
export async function setMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}
async function getJson(env, key, fallback) {
  try { return { ...fallback, ...JSON.parse((await getMeta(env, key)) || '{}') }; } catch { return { ...fallback }; }
}

/* ---------- shop settings (Admin > Shop settings) ---------- */

export const DEFAULT_SETTINGS = {
  price_per_gram_cents: 100,
  shipping_cents: 500,
  shipping_label: 'Shipping (USPS, tracked)',
  pickup: false,
  pickup_label: 'Pick up at a market',
  hero_title: "Hi, I'm Claire. I make tiny clay animals.",
  hero_text: 'Each one is sculpted by hand from polymer clay, baked, painted and glazed. No molds, so no two come out the same.',
  ig_default_tags: '#polymerclay #clayanimals #handmade',
};
export const getSettings = (env) => getJson(env, 'settings', DEFAULT_SETTINGS);
export async function saveSettings(env, input) {
  const cur = await getSettings(env);
  const cents = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
  const next = {
    price_per_gram_cents: cents(input.price_per_gram_cents, cur.price_per_gram_cents),
    shipping_cents: cents(input.shipping_cents, cur.shipping_cents),
    shipping_label: clean(input.shipping_label ?? cur.shipping_label, 60) || DEFAULT_SETTINGS.shipping_label,
    pickup: 'pickup' in input ? !!input.pickup : cur.pickup,
    pickup_label: clean(input.pickup_label ?? cur.pickup_label, 60) || DEFAULT_SETTINGS.pickup_label,
    hero_title: clean(input.hero_title ?? cur.hero_title, 120) || DEFAULT_SETTINGS.hero_title,
    hero_text: clean(input.hero_text ?? cur.hero_text, 600),
    ig_default_tags: clean(input.ig_default_tags ?? cur.ig_default_tags, 400),
  };
  await setMeta(env, 'settings', JSON.stringify(next));
  return next;
}

/* ---------- theme (Admin > Look) ---------- */

export const BUNDLED_FONTS = ['Fredoka', 'Baloo 2', 'Nunito', 'Quicksand', 'Lora', 'Chewy', 'Patrick Hand', 'Caveat', 'Gaegu'];
export const DEFAULT_THEME = {
  colors: { paper: '#f3f1fa', card: '#ffffff', text: '#33241d', button: '#5f6c3f', logo: '#8c9a66', accent: '#b9a8e6', wash: '#e4ddf7' },
  fonts: { head: 'Fredoka', body: 'Fredoka', hand: 'Patrick Hand' },
  custom_fonts: [],   // [{ name, key }]
  logo_key: null, favicon_key: null, hero_key: null,
};
const HEX = /^#[0-9a-f]{6}$/i;
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

export async function getTheme(env) {
  const t = await getJson(env, 'theme', DEFAULT_THEME);
  t.colors = { ...DEFAULT_THEME.colors, ...(t.colors || {}) };
  t.fonts = { ...DEFAULT_THEME.fonts, ...(t.fonts || {}) };
  t.custom_fonts = Array.isArray(t.custom_fonts) ? t.custom_fonts : [];
  return t;
}
export async function saveTheme(env, input) {
  const cur = await getTheme(env);
  const next = { ...cur, colors: { ...cur.colors }, fonts: { ...cur.fonts } };
  for (const k of Object.keys(DEFAULT_THEME.colors)) {
    if (input.colors && HEX.test(input.colors[k] || '')) next.colors[k] = input.colors[k].toLowerCase();
  }
  if (Array.isArray(input.custom_fonts)) {
    next.custom_fonts = input.custom_fonts
      .filter((f) => f && FONT_NAME.test(f.name || '') && /^fonts\/[\w.-]+$/.test(f.key || '') && !BUNDLED_FONTS.includes(f.name))
      .slice(0, 12).map((f) => ({ name: f.name, key: f.key }));
    const still = new Set([...BUNDLED_FONTS, ...next.custom_fonts.map((f) => f.name)]);
    for (const k of ['head', 'body', 'hand']) if (!still.has(next.fonts[k])) next.fonts[k] = DEFAULT_THEME.fonts[k];
  }
  const known = new Set([...BUNDLED_FONTS, ...next.custom_fonts.map((f) => f.name)]);
  for (const k of ['head', 'body', 'hand']) {
    if (input.fonts && known.has(input.fonts[k])) next.fonts[k] = input.fonts[k];
  }
  for (const k of ['logo_key', 'favicon_key', 'hero_key']) {
    if (k in input) next[k] = input[k] && /^site\/[\w.-]+$/.test(input[k]) ? input[k] : null;
  }
  await setMeta(env, 'theme', JSON.stringify(next));
  return next;
}

// /theme.css: loaded after styles.css, so these values win over the defaults there.
export function themeCss(theme) {
  const c = theme.colors, f = theme.fonts;
  const faces = theme.custom_fonts
    .filter((x) => FONT_NAME.test(x.name))
    .map((x) => `@font-face { font-family: "${x.name}"; src: url("/img/${x.key}"); font-display: swap; }`);
  const font = (name, rest) => `"${FONT_NAME.test(name) ? name : 'Fredoka'}", ${rest}`;
  const ok = (v, d) => (HEX.test(v) ? v : d);
  const d = DEFAULT_THEME.colors;
  return [
    ...faces,
    ':root {',
    `  --paper: ${ok(c.paper, d.paper)};`,
    `  --card: ${ok(c.card, d.card)};`,
    `  --cocoa: ${ok(c.text, d.text)};`,
    `  --sage-deep: ${ok(c.button, d.button)};`,
    `  --sage: ${ok(c.logo, d.logo)};`,
    `  --lavender: ${ok(c.accent, d.accent)};`,
    `  --lilac-wash: ${ok(c.wash, d.wash)};`,
    `  --font-head: ${font(f.head, '"Arial Rounded MT Bold", system-ui, sans-serif')};`,
    `  --font-body: ${font(f.body, 'system-ui, sans-serif')};`,
    `  --font-hand: ${font(f.hand, '"Comic Sans MS", cursive')};`,
    '}', '',
  ].join('\n');
}

/* ---------- items ---------- */

export function parseTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/);
  const seen = new Set();
  return list.map((t) => clean(t, 30).replace(/^#/, '').toLowerCase()).filter((t) => t && !seen.has(t) && seen.add(t)).slice(0, 20);
}
const readTags = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export async function loadItems(env, where = '', binds = []) {
  const { results: rows } = await env.DB.prepare(`SELECT * FROM items ${where} ORDER BY posted_at DESC LIMIT 500`).bind(...binds).all();
  if (!rows.length) return [];
  const { results: photos } = await env.DB.prepare('SELECT item_id, key FROM photos ORDER BY item_id, sort, id').all();
  const byItem = new Map();
  for (const p of photos) (byItem.get(p.item_id) || byItem.set(p.item_id, []).get(p.item_id)).push(p.key);
  return rows.map((r) => ({ ...r, tags: readTags(r.tags), photo_keys: byItem.get(r.id) || [] }));
}

export function publicItem(row, now = Date.now()) {
  const held = row.status === 'available' && row.reserved_until && row.reserved_until > now;
  return {
    id: row.id, title: row.title, description: row.description || '', category: row.category || '', tags: row.tags,
    grams: row.grams, price_cents: row.price_cents, status: held ? 'held' : row.status,
    photos: row.photo_keys.map((k) => '/img/' + k), permalink: row.ig_post_url || row.permalink || null,
  };
}

export async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
