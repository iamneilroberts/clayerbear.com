// Clayer Bear Worker.
// The pages in /public are served as static files. This Worker handles only:
//   GET  /api/site               shop settings the storefront needs
//   GET  /api/items              figures on the shelf
//   POST /api/checkout           start a Stripe payment for the bag
//   POST /api/checkout/cancel    buyer backed out: release the hold
//   POST /api/stripe/webhook     Stripe tells us a payment went through
//   POST /api/requests           custom-figure requests
//   GET  /theme.css              colors and fonts chosen in Admin > Look
//   GET  /img/<key>              photos, logos and uploaded fonts (R2)
//   *    /api/admin/...          the admin pages (password protected)

import { EmailMessage } from 'cloudflare:email';
import { json, fail, clean, ensureSchema, getSettings, getTheme, themeCss, loadItems, publicItem, MAX_UPLOAD_BYTES } from './store.js';
import { admin } from './admin.js';
import { checkoutEnabled, createCheckout, cancelCheckout, stripeWebhook } from './stripe.js';
import { refreshInstagramToken } from './instagram.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path.startsWith('/img/')) return await serveFile(request, env, ctx, path.slice(5));
      if (path === '/theme.css') {
        await ensureSchema(env);
        return new Response(themeCss(await getTheme(env)), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60' } });
      }
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

      await ensureSchema(env);
      if (path === '/api/site' && method === 'GET') return await site(env);
      if (path === '/api/items' && method === 'GET') return await listItems(request, env);
      if (path === '/api/checkout' && method === 'POST') return await createCheckout(request, env);
      if (path === '/api/checkout/cancel' && method === 'POST') return await cancelCheckout(request, env);
      if (path === '/api/stripe/webhook' && method === 'POST') return await stripeWebhook(request, env);
      if (path === '/api/requests' && method === 'POST') return await createRequest(request, env, ctx);
      if (path.startsWith('/api/admin/')) return await admin(request, env, path.slice('/api/admin/'.length));
      return fail(404, 'Not found.');
    } catch (err) {
      console.error(err);
      return fail(500, 'Something broke on the server.');
    }
  },

  // Once a day: keep the Instagram token from expiring.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => refreshInstagramToken(env)));
  },
};

/* ---------- public ---------- */

async function site(env) {
  const [s, t] = await Promise.all([getSettings(env), getTheme(env)]);
  const img = (k) => (k ? '/img/' + k : null);
  return json({
    checkout: checkoutEnabled(env),
    price_per_gram_cents: s.price_per_gram_cents,
    shipping_cents: s.shipping_cents, shipping_label: s.shipping_label,
    pickup: s.pickup, pickup_label: s.pickup_label,
    hero_title: s.hero_title, hero_text: s.hero_text,
    logo: img(t.logo_key), favicon: img(t.favicon_key), hero: img(t.hero_key),
  }, 200, { 'cache-control': 'public, max-age=60' });
}

async function listItems(request, env) {
  const rows = await loadItems(env, "WHERE status IN ('available','sold') AND price_cents IS NOT NULL");
  const items = rows.filter((r) => r.photo_keys.length).map((r) => publicItem(r));
  items.sort((a, b) => (a.status === 'sold') - (b.status === 'sold'));

  // Brand-new site with nothing listed yet: optionally show the sample figures.
  if (!items.length && env.SHOW_SAMPLES === 'true') {
    return env.ASSETS.fetch(new Request(new URL('/sample/items.json', request.url)));
  }
  return json({ items }, 200, { 'cache-control': 'no-store' });
}

async function serveFile(request, env, ctx, key) {
  key = decodeURIComponent(key);
  // Photos customers attach to requests (req/...) are private; only /api/admin serves those.
  if (!/^(ig|manual|items|site|fonts)\/[\w./-]+$/.test(key) || key.includes('..')) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const res = new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
      'cache-control': 'public, max-age=2592000, immutable',
      'x-content-type-options': 'nosniff',
      // An uploaded SVG logo must never be able to run scripts.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      etag: obj.httpEtag,
    },
  });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function createRequest(request, env, ctx) {
  let form;
  try { form = await request.formData(); } catch { return fail(400, 'That form could not be read.'); }

  // Honeypot: bots fill the hidden "website" field. Pretend it worked.
  if (clean(form.get('website'), 10)) return json({ ok: true });

  const kind = ['buy', 'custom', 'like'].includes(form.get('kind')) ? form.get('kind') : 'custom';
  const name = clean(form.get('name'), 120);
  const email = clean(form.get('email'), 200);
  const message = clean(form.get('message'), 4000);
  const itemId = clean(form.get('item_id'), 80) || null;
  const grams = Number(form.get('grams')) || null;

  if (!name) return fail(400, 'Please add your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'That email address does not look right.');
  if (kind !== 'buy' && !message) return fail(400, 'Tell me a little about what you would like.');

  let item = null;
  if (itemId) {
    item = await env.DB.prepare('SELECT id, title, status FROM items WHERE id = ?').bind(itemId).first();
    if (kind === 'buy' && !item) return fail(400, 'That figure is no longer listed.');
    if (kind === 'buy' && item.status !== 'available') return fail(409, 'Someone got to that one first. I can make you one like it, though.');
  } else if (kind === 'buy') {
    return fail(400, 'Pick a figure first.');
  }

  let photoKey = null;
  const photo = form.get('photo');
  if (photo && typeof photo === 'object' && photo.size > 0) {
    if (!photo.type.startsWith('image/')) return fail(400, 'The attachment needs to be a photo.');
    if (photo.size > MAX_UPLOAD_BYTES) return fail(400, 'That photo is over 8 MB. Try a smaller one.');
    photoKey = `req/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await env.PHOTOS.put(photoKey, photo.stream(), { httpMetadata: { contentType: photo.type } });
  }

  await env.DB.prepare(
    'INSERT INTO requests (kind, item_id, name, email, message, grams, photo_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(kind, item ? item.id : null, name, email, message, grams, photoKey, Date.now()).run();

  ctx.waitUntil(notify(env, { kind, name, email, message, grams, item, hasPhoto: !!photoKey }));
  return json({ ok: true });
}

// Optional: email Claire when a request comes in. Needs Cloudflare Email
// Routing on the domain and the send_email binding in wrangler.jsonc.
// Without the binding this does nothing and requests still show in /admin.
async function notify(env, r) {
  if (!env.NOTIFY || !env.NOTIFY_FROM || !env.NOTIFY_TO) return;
  const what = r.kind === 'buy' ? `wants to buy "${r.item.title}"`
    : r.kind === 'like' ? `wants one like "${r.item?.title || 'a sold figure'}"` : 'wants a custom figure';
  const lines = [
    `${r.name} <${r.email}> ${what}.`, '',
    r.grams ? `Size: ${r.grams}g` : null,
    r.message ? `Message:\n${r.message}` : null,
    r.hasPhoto ? 'They attached a photo. See it in the admin page.' : null,
    '', 'All requests: https://clayerbear.com/admin/',
  ].filter((l) => l !== null);
  const subject = `Clayer Bear: ${r.name} ${what}`.replace(/[\r\n]+/g, ' ').slice(0, 150);
  const raw = [
    `From: Clayer Bear site <${env.NOTIFY_FROM}>`, `To: <${env.NOTIFY_TO}>`,
    `Reply-To: <${r.email.replace(/[\r\n<>]/g, '')}>`, `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@clayerbear.com>`, `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', lines.join('\r\n'),
  ].join('\r\n');
  try { await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, raw)); }
  catch (err) { console.error('notify failed', err); }
}
