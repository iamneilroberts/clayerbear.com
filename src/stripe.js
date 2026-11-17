// Stripe Checkout.
//
// Every figure is one of a kind, so buying works like this:
//   1. The buyer's bag is sent to POST /api/checkout.
//   2. Each figure is put on hold (30 minutes) so nobody else can buy it.
//   3. The buyer pays on Stripe's hosted page, which also collects the
//      shipping address and adds the shipping charge.
//   4. Stripe calls POST /api/stripe/webhook. Paid: figures become "sold" and
//      the order appears in Admin > Orders. Abandoned: the hold is released.
//
// Needs two secrets: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (see README).
// Without STRIPE_SECRET_KEY the shop falls back to the "send a request" form.

import { json, fail, clean, getSettings, loadItems } from './store.js';

const HOLD_MINUTES = 31; // Stripe's minimum session lifetime is 30 minutes
const MAX_BAG = 10;

export const checkoutEnabled = (env) => !!env.STRIPE_SECRET_KEY;

async function stripe(env, path, params) {
  const res = await fetch((env.STRIPE_API_BASE || 'https://api.stripe.com') + '/v1/' + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Stripe error ${res.status}`);
  return body;
}

async function release(env, token) {
  await env.DB.prepare('UPDATE items SET reserved_until = NULL, reserved_by = NULL WHERE reserved_by = ?').bind(token).run();
}

export async function createCheckout(request, env) {
  if (!checkoutEnabled(env)) return fail(503, 'Card checkout is not set up yet.');
  const body = await request.json().catch(() => ({}));
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => clean(x, 80)).filter(Boolean))].slice(0, MAX_BAG);
  if (!ids.length) return fail(400, 'Your bag is empty.');

  const now = Date.now();
  const token = crypto.randomUUID();
  const until = now + HOLD_MINUTES * 60e3;

  // Put a hold on each figure. The WHERE clause makes this safe if two people
  // check out the same figure at the same moment: only one UPDATE wins.
  const taken = [];
  for (const id of ids) {
    const r = await env.DB.prepare(
      `UPDATE items SET reserved_until = ?, reserved_by = ? WHERE id = ? AND status = 'available'
       AND price_cents IS NOT NULL AND (reserved_until IS NULL OR reserved_until < ?)`
    ).bind(until, token, id, now).run();
    if (!r.meta.changes) taken.push(id);
  }
  if (taken.length) {
    await release(env, token);
    return fail(409, 'Someone else just got to one of these. It has been taken out of your bag.', { unavailable: taken });
  }

  const items = await loadItems(env, 'WHERE reserved_by = ?', [token]);
  const settings = await getSettings(env);
  const origin = new URL(request.url).origin;
  const p = {
    mode: 'payment',
    success_url: `${origin}/?order=paid`,
    cancel_url: `${origin}/?order=cancelled&hold=${token}`,
    expires_at: String(Math.floor(until / 1000)),
    'shipping_address_collection[allowed_countries][0]': 'US',
    'metadata[hold_token]': token,
  };
  items.forEach((it, i) => {
    p[`line_items[${i}][quantity]`] = '1';
    p[`line_items[${i}][price_data][currency]`] = 'usd';
    p[`line_items[${i}][price_data][unit_amount]`] = String(it.price_cents);
    p[`line_items[${i}][price_data][product_data][name]`] = it.title;
    if (it.photo_keys[0]) p[`line_items[${i}][price_data][product_data][images][0]`] = `${origin}/img/${it.photo_keys[0]}`;
  });
  const options = [{ label: settings.shipping_label, cents: settings.shipping_cents }];
  if (settings.pickup) options.push({ label: settings.pickup_label, cents: 0 });
  options.forEach((o, i) => {
    p[`shipping_options[${i}][shipping_rate_data][type]`] = 'fixed_amount';
    p[`shipping_options[${i}][shipping_rate_data][display_name]`] = o.label;
    p[`shipping_options[${i}][shipping_rate_data][fixed_amount][amount]`] = String(o.cents);
    p[`shipping_options[${i}][shipping_rate_data][fixed_amount][currency]`] = 'usd';
  });

  let session;
  try { session = await stripe(env, 'checkout/sessions', p); }
  catch (err) {
    await release(env, token);
    console.error('stripe create failed', err);
    return fail(502, 'The payment page could not be opened. Nothing was charged. Please try again.');
  }

  const subtotal = items.reduce((n, it) => n + it.price_cents, 0);
  await env.DB.prepare(
    `INSERT INTO orders (session_id, hold_token, status, items, subtotal_cents, created_at) VALUES (?, ?, 'pending', ?, ?, ?)`
  ).bind(session.id, token, JSON.stringify(items.map((it) => ({ id: it.id, title: it.title, price_cents: it.price_cents, photo: it.photo_keys[0] || null }))), subtotal, now).run();

  return json({ url: session.url, hold: token });
}

// The buyer pressed "back" on Stripe's page: free the figures straight away
// and close the Stripe session so it cannot be paid later.
export async function cancelCheckout(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = clean(body.hold, 60);
  if (!/^[0-9a-f-]{36}$/.test(token)) return fail(400, 'Bad hold.');
  const order = await env.DB.prepare("SELECT session_id FROM orders WHERE hold_token = ? AND status = 'pending'").bind(token).first();
  if (!order) return json({ ok: true });
  try { await stripe(env, `checkout/sessions/${encodeURIComponent(order.session_id)}/expire`, {}); }
  catch (err) { console.error('expire failed', err); return json({ ok: true, released: false }); } // maybe already paid; let the webhook decide
  await release(env, token);
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE hold_token = ? AND status = 'pending'").bind(token).run();
  return json({ ok: true, released: true });
}

/* ---------- webhook ---------- */

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function verifyStripeSignature(payload, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = Object.create(null);
  for (const piece of String(header || '').split(',')) {
    const [k, v] = piece.split('=');
    if (k && v) (parts[k.trim()] ||= []).push(v.trim());
  }
  const t = Number(parts.t?.[0]);
  if (!t || !parts.v1 || Math.abs(nowSec - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  let match = false;
  for (const sig of parts.v1) {
    if (sig.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff === 0) match = true;
  }
  return match;
}

export async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return fail(503, 'Webhook secret not set.');
  const payload = await request.text();
  if (!(await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return fail(400, 'Bad signature.');
  }
  const event = JSON.parse(payload);
  const s = event.data?.object;
  if (!s || s.object !== 'checkout.session') return json({ received: true });
  const token = s.metadata?.hold_token;
  if (!token) return json({ received: true }); // not a session this site created
  const now = Date.now();

  const paid = (event.type === 'checkout.session.completed' && s.payment_status === 'paid')
    || event.type === 'checkout.session.async_payment_succeeded';

  if (paid) {
    // Newer Stripe API versions put the address under collected_information.
    const ship = s.collected_information?.shipping_details || s.shipping_details || null;
    await env.DB.prepare("UPDATE items SET status = 'sold', reserved_until = NULL, updated_at = ? WHERE reserved_by = ?").bind(now, token).run();
    await env.DB.prepare(
      `UPDATE orders SET status = 'paid', paid_at = ?, email = ?, name = ?, address = ?, shipping_cents = ?, total_cents = ?, shipping_label = ?
       WHERE hold_token = ? AND status != 'paid'`
    ).bind(now, s.customer_details?.email || null, ship?.name || s.customer_details?.name || null,
      ship?.address ? JSON.stringify(ship.address) : null, s.shipping_cost?.amount_total ?? s.total_details?.amount_shipping ?? null,
      s.amount_total ?? null, s.shipping_cost?.shipping_rate?.display_name ?? null, token).run();
  } else if (event.type === 'checkout.session.completed') {
    // Completed but not paid yet (a slow payment method): keep the hold for a week.
    await env.DB.prepare('UPDATE items SET reserved_until = ? WHERE reserved_by = ?').bind(now + 7 * 86400e3, token).run();
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    await release(env, token);
    await env.DB.prepare("UPDATE orders SET status = 'expired' WHERE hold_token = ? AND status = 'pending'").bind(token).run();
  }
  return json({ received: true });
}
