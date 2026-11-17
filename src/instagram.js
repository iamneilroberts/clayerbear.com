// Posting to Instagram from Admin > Figures.
//
// Uses Meta's "Instagram API with Instagram Login" (graph.instagram.com).
// Needs a Business or Creator Instagram account and a long-lived token with
// the instagram_business_basic and instagram_business_content_publish
// permissions, stored as the IG_ACCESS_TOKEN secret (see README).
//
// Instagram downloads the photos itself from the URLs we give it, so this
// only works on the live site, not on localhost.
//
// Pulling posts the other way (Instagram -> shop listings) is switched off
// for now. That code is parked in src/deferred/instagram-import.js.

import { getMeta, setMeta } from './store.js';

const GRAPH = 'https://graph.instagram.com';
const REFRESH_AFTER_DAYS = 7;
export const MAX_CAROUSEL = 10;
export const MAX_CAPTION = 2200;

const base = (env) => env.IG_API_BASE || GRAPH;

async function fingerprint(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The secret is only the starting token. Tokens last 60 days; once refreshed,
// the newer one is kept in the database and used instead.
async function currentToken(env) {
  if (!env.IG_ACCESS_TOKEN && !(await getMeta(env, 'ig_token'))) return null;
  if (env.IG_ACCESS_TOKEN) {
    const fp = await fingerprint(env.IG_ACCESS_TOKEN);
    if ((await getMeta(env, 'ig_token_seed')) !== fp) {
      await setMeta(env, 'ig_token', env.IG_ACCESS_TOKEN);
      await setMeta(env, 'ig_token_seed', fp);
      await setMeta(env, 'ig_token_refreshed_at', Date.now());
      await setMeta(env, 'ig_account', '');
      return env.IG_ACCESS_TOKEN;
    }
  }
  return getMeta(env, 'ig_token');
}

// Called by the daily cron so the token never reaches its 60-day expiry.
export async function refreshInstagramToken(env) {
  const token = await currentToken(env);
  if (!token) return;
  const last = Number((await getMeta(env, 'ig_token_refreshed_at')) || 0);
  if (Date.now() - last < REFRESH_AFTER_DAYS * 86400e3) return;
  const res = await fetch(`${base(env)}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    await setMeta(env, 'ig_last_error', `Token refresh failed: ${body.error?.message || res.status}`);
    return;
  }
  await setMeta(env, 'ig_token', body.access_token);
  await setMeta(env, 'ig_token_refreshed_at', Date.now());
  await setMeta(env, 'ig_last_error', '');
}

async function call(env, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base(env)}/${path}`, {
    method,
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.error_user_msg || data.error?.message || `Instagram error ${res.status}`);
  return data;
}

// { connected, username, error } for the admin page.
export async function instagramStatus(env) {
  const token = await currentToken(env);
  if (!token) return { connected: false, username: null, error: null };
  let account = null;
  try { account = JSON.parse((await getMeta(env, 'ig_account')) || 'null'); } catch {}
  if (!account) {
    try {
      const me = await call(env, token, 'me?fields=user_id,username');
      account = { id: String(me.user_id || me.id), username: me.username };
      await setMeta(env, 'ig_account', JSON.stringify(account));
      await setMeta(env, 'ig_last_error', '');
    } catch (err) {
      return { connected: false, username: null, error: String(err.message || err) };
    }
  }
  return { connected: true, username: account.username, id: account.id, error: (await getMeta(env, 'ig_last_error')) || null };
}

async function waitUntilReady(env, token, containerId) {
  for (let i = 0; i < 12; i++) {
    const s = await call(env, token, `${containerId}?fields=status_code`);
    if (s.status_code === 'FINISHED' || s.status_code === undefined) return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram could not process one of the photos.');
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Instagram is still processing the photos. Try again in a minute.');
}

// imageUrls: 1 to 10 public JPEG URLs. Returns { id, permalink }.
export async function publishToInstagram(env, imageUrls, caption) {
  const status = await instagramStatus(env);
  if (!status.connected) throw new Error(status.error || 'Instagram is not connected yet.');
  const token = await currentToken(env);
  const ig = status.id;

  let creation;
  if (imageUrls.length === 1) {
    creation = (await call(env, token, `${ig}/media`, { method: 'POST', body: { image_url: imageUrls[0], caption } })).id;
  } else {
    const children = [];
    for (const url of imageUrls) {
      children.push((await call(env, token, `${ig}/media`, { method: 'POST', body: { image_url: url, is_carousel_item: true } })).id);
    }
    for (const id of children) await waitUntilReady(env, token, id);
    creation = (await call(env, token, `${ig}/media`, { method: 'POST', body: { media_type: 'CAROUSEL', children: children.join(','), caption } })).id;
  }
  await waitUntilReady(env, token, creation);
  const published = await call(env, token, `${ig}/media_publish`, { method: 'POST', body: { creation_id: creation } });
  let permalink = null;
  try { permalink = (await call(env, token, `${published.id}?fields=permalink`)).permalink || null; } catch {}
  return { id: published.id, permalink };
}
