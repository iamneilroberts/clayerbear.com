// Everything behind /api/admin/. Used only by the pages in public/admin/.
// Every call must carry the admin password as a Bearer token.

import {
  json, fail, clean, STATUSES, MAX_UPLOAD_BYTES, BUNDLED_FONTS, getSettings, saveSettings, getTheme, saveTheme,
  loadItems, parseTags, sameSecret,
} from './store.js';
import { instagramStatus, publishToInstagram, MAX_CAROUSEL, MAX_CAPTION } from './instagram.js';
import { checkoutEnabled } from './stripe.js';

const FONT_TYPES = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

function adminItem(row) {
  return {
    id: row.id, title: row.title, description: row.description || '', category: row.category || '', tags: row.tags,
    grams: row.grams, price_cents: row.price_cents, status: row.status, photo_keys: row.photo_keys,
    on_hold: !!(row.status === 'available' && row.reserved_until && row.reserved_until > Date.now()),
    ig_post_url: row.ig_post_url || row.permalink || null, updated_at: row.updated_at,
  };
}

async function readFile(request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file !== 'object' || !file.size) return { error: 'No file was sent.' };
  if (file.size > MAX_UPLOAD_BYTES) return { error: 'That file is over 8 MB.' };
  return { file, form };
}

export async function admin(request, env, route) {
  if (!env.ADMIN_PASSWORD) return fail(503, 'Admin is off until the ADMIN_PASSWORD secret is set.');
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!given || !(await sameSecret(given, env.ADMIN_PASSWORD))) return fail(401, 'Wrong password.');

  const method = request.method;
  const now = Date.now();
  let m;

  /* ----- everything the admin page needs, in one call ----- */
  if (route === 'overview' && method === 'GET') {
    const [items, orders, requests, settings, theme, instagram] = await Promise.all([
      loadItems(env),
      env.DB.prepare("SELECT * FROM orders WHERE status IN ('paid','shipped') ORDER BY paid_at DESC LIMIT 200").all(),
      env.DB.prepare(`SELECT r.*, i.title AS item_title FROM requests r LEFT JOIN items i ON i.id = r.item_id
                      ORDER BY r.handled, r.created_at DESC LIMIT 200`).all(),
      getSettings(env), getTheme(env), instagramStatus(env),
    ]);
    return json({
      items: items.map(adminItem),
      orders: orders.results.map((o) => ({ ...o, items: JSON.parse(o.items || '[]'), address: o.address ? JSON.parse(o.address) : null })),
      requests: requests.results,
      settings, theme, bundled_fonts: BUNDLED_FONTS, instagram,
      stripe: { checkout: checkoutEnabled(env), webhook: !!env.STRIPE_WEBHOOK_SECRET },
      limits: { carousel: MAX_CAROUSEL, caption: MAX_CAPTION },
    });
  }

  /* ----- figures ----- */
  if (route === 'items' && method === 'POST') {
    const id = 'f' + now.toString(36) + shortId().slice(0, 4);
    await env.DB.prepare(
      "INSERT INTO items (id, source, title, status, tags, posted_at, locked, updated_at) VALUES (?, 'manual', 'New figure', 'draft', '[]', ?, 1, ?)"
    ).bind(id, now, now).run();
    return json({ ok: true, id });
  }

  if ((m = route.match(/^items\/([\w-]+)$/)) && method === 'POST') {
    const id = m[1];
    const row = (await loadItems(env, 'WHERE id = ?', [id]))[0];
    if (!row) return fail(404, 'No such figure.');
    const b = await request.json().catch(() => ({}));
    const settings = await getSettings(env);

    const title = 'title' in b ? clean(b.title, 80) || row.title : row.title;
    const description = 'description' in b ? clean(b.description, 2000) : row.description;
    const category = 'category' in b ? clean(b.category, 40) : row.category;
    const tags = 'tags' in b ? parseTags(b.tags) : row.tags;
    const grams = 'grams' in b ? (Number(b.grams) > 0 ? Math.round(Number(b.grams)) : null) : row.grams;
    let price = row.price_cents;
    if ('price_cents' in b) {
      // Blank price = work it out from the weight.
      price = b.price_cents === null || b.price_cents === '' ? (grams ? grams * settings.price_per_gram_cents : null)
        : Math.max(0, Math.round(Number(b.price_cents))) || null;
    }
    const status = STATUSES.includes(b.status) ? b.status : row.status;

    // photo_keys sets the order; any photo left out is deleted.
    let keys = row.photo_keys;
    if (Array.isArray(b.photo_keys)) {
      keys = b.photo_keys.filter((k) => row.photo_keys.includes(k));
      const gone = row.photo_keys.filter((k) => !keys.includes(k));
      const stmts = [env.DB.prepare('DELETE FROM photos WHERE item_id = ?').bind(id),
        ...keys.map((k, i) => env.DB.prepare('INSERT INTO photos (item_id, key, sort) VALUES (?, ?, ?)').bind(id, k, i))];
      await env.DB.batch(stmts);
      if (gone.length) await env.PHOTOS.delete(gone);
    }
    if (status === 'available' && (!keys.length || !price)) {
      return fail(400, 'A figure needs at least one photo and a price (or a weight) before it can go on the shelf.');
    }
    await env.DB.prepare(
      `UPDATE items SET title = ?, description = ?, category = ?, tags = ?, grams = ?, price_cents = ?, status = ?,
       image_key = ?, locked = 1, updated_at = ? WHERE id = ?`
    ).bind(title, description, category, JSON.stringify(tags), grams, price, status, keys[0] || null, now, id).run();
    return json({ ok: true });
  }

  if ((m = route.match(/^items\/([\w-]+)$/)) && method === 'DELETE') {
    const row = (await loadItems(env, 'WHERE id = ?', [m[1]]))[0];
    if (!row) return fail(404, 'No such figure.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM photos WHERE item_id = ?').bind(m[1]),
      env.DB.prepare('DELETE FROM items WHERE id = ?').bind(m[1]),
    ]);
    if (row.photo_keys.length) await env.PHOTOS.delete(row.photo_keys);
    return json({ ok: true });
  }

  if ((m = route.match(/^items\/([\w-]+)\/photos$/)) && method === 'POST') {
    const id = m[1];
    const row = (await loadItems(env, 'WHERE id = ?', [id]))[0];
    if (!row) return fail(404, 'No such figure.');
    if (row.photo_keys.length >= 12) return fail(400, 'A figure can have up to 12 photos.');
    const { file, error } = await readFile(request);
    if (error) return fail(400, error);
    if (!file.type.startsWith('image/')) return fail(400, 'That file is not a photo.');
    const key = `items/${id}/${shortId()}.jpg`;
    await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    await env.DB.prepare('INSERT INTO photos (item_id, key, sort) VALUES (?, ?, ?)').bind(id, key, row.photo_keys.length).run();
    if (!row.photo_keys.length) await env.DB.prepare('UPDATE items SET image_key = ? WHERE id = ?').bind(key, id).run();
    return json({ ok: true, key });
  }

  /* ----- uploads that are not figure photos: logo, hero, fonts, Instagram crops ----- */
  if (route === 'upload' && method === 'POST') {
    const kind = new URL(request.url).searchParams.get('kind');
    const { file, error } = await readFile(request);
    if (error) return fail(400, error);
    let key, type = file.type;
    if (kind === 'font') {
      const ext = (file.name || '').split('.').pop().toLowerCase();
      if (!FONT_TYPES[ext]) return fail(400, 'Fonts need to be .woff2, .woff, .ttf or .otf files.');
      key = `fonts/${shortId()}.${ext}`; type = FONT_TYPES[ext];
    } else if (kind === 'site' || kind === 'ig') {
      if (!type.startsWith('image/')) return fail(400, 'That file is not an image.');
      if (kind === 'ig' && type !== 'image/jpeg') return fail(400, 'Instagram photos must be JPEG.');
      key = kind === 'ig' ? `ig/post-${shortId()}.jpg` : `site/${shortId()}`;
    } else return fail(400, 'Unknown upload kind.');
    await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: type } });
    return json({ ok: true, key });
  }

  /* ----- look and settings ----- */
  if (route === 'theme' && method === 'POST') {
    const before = await getTheme(env);
    const theme = await saveTheme(env, await request.json().catch(() => ({})));
    // Clear out replaced logo / hero / font files.
    const keep = new Set([theme.logo_key, theme.favicon_key, theme.hero_key, ...theme.custom_fonts.map((f) => f.key)]);
    const old = [before.logo_key, before.favicon_key, before.hero_key, ...before.custom_fonts.map((f) => f.key)].filter((k) => k && !keep.has(k));
    if (old.length) await env.PHOTOS.delete(old);
    return json({ ok: true, theme });
  }
  if (route === 'settings' && method === 'POST') {
    return json({ ok: true, settings: await saveSettings(env, await request.json().catch(() => ({}))) });
  }

  /* ----- Instagram ----- */
  if (route === 'instagram/post' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const keys = (Array.isArray(b.keys) ? b.keys : []).filter((k) => /^ig\/post-[\w]+\.jpg$/.test(k)).slice(0, MAX_CAROUSEL);
    const caption = clean(b.caption, MAX_CAPTION);
    if (!keys.length) return fail(400, 'Pick at least one photo.');
    const url = new URL(request.url);
    if (!env.IG_API_BASE && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
      return fail(400, 'Instagram can only fetch photos from the live site, so posting does not work on localhost.');
    }
    let post;
    try { post = await publishToInstagram(env, keys.map((k) => `${url.origin}/img/${k}`), caption); }
    catch (err) { return fail(502, String(err.message || err)); }
    finally { await env.PHOTOS.delete(keys).catch(() => {}); }
    const ids = (Array.isArray(b.item_ids) ? b.item_ids : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 20);
    if (post.permalink && ids.length) {
      await env.DB.batch(ids.map((id) => env.DB.prepare('UPDATE items SET ig_post_url = ? WHERE id = ?').bind(post.permalink, id)));
    }
    return json({ ok: true, permalink: post.permalink });
  }

  /* ----- orders and requests ----- */
  if ((m = route.match(/^orders\/(\d+)$/)) && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare("UPDATE orders SET status = ?, shipped_at = ? WHERE id = ? AND status IN ('paid','shipped')")
      .bind(b.shipped ? 'shipped' : 'paid', b.shipped ? now : null, Number(m[1])).run();
    return json({ ok: true });
  }
  if ((m = route.match(/^requests\/(\d+)$/)) && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare('UPDATE requests SET handled = ? WHERE id = ?').bind(b.handled ? 1 : 0, Number(m[1])).run();
    return json({ ok: true });
  }
  if ((m = route.match(/^photo\/(req\/[\w-]+)$/)) && method === 'GET') {
    const obj = await env.PHOTOS.get(m[1]);
    if (!obj) return fail(404, 'Photo not found.');
    return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, no-store' } });
  }

  return fail(404, 'Not found.');
}
