// Instagram -> shop sync.
//
// Claire keeps posting to Instagram as usual. A post becomes a listing when
// its caption has the sale hashtag (SALE_TAG, default #forsale):
//
//     Round calico cat
//     20g #forsale #polymerclay
//
//   title  = first line of the caption (hashtags stripped)
//   weight = first "10g" / "20 g" style number in the caption
//   price  = "$12" in the caption if there is one, otherwise weight x $1/g
//   sold   = caption contains #sold (or the word SOLD in capitals)
//
// Editing the caption later (adding #sold, fixing the weight) updates the
// listing on the next sync. Removing the sale tag hides it. Anything edited
// by hand in /admin is "locked" and the sync leaves it alone.
//
// Uses the Instagram API with Instagram Login (graph.instagram.com), which
// needs a free Professional (Creator or Business) Instagram account and a
// long-lived access token. Tokens last 60 days; refreshToken() renews it.

const GRAPH_DEFAULT = 'https://graph.instagram.com';
const FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}';
const REFRESH_AFTER_DAYS = 7;
const MAX_PAGES = 4; // 4 x 50 posts per sync is plenty

export function parseCaption(caption, env) {
  const text = caption || '';
  const saleTag = (env.SALE_TAG || '#forsale').toLowerCase();
  const perGram = Number(env.PRICE_PER_GRAM_CENTS || 100);
  const lower = text.toLowerCase();

  const forSale = hasTag(lower, saleTag);
  const sold = hasTag(lower, '#sold') || /\bSOLD\b/.test(text);

  const gramsMatch = text.match(/(?<![\w.$])(\d{1,3})\s?(?:g|grams?)\b/i);
  const grams = gramsMatch ? Number(gramsMatch[1]) : null;

  const priceMatch = text.match(/\$\s?(\d{1,4})(?:\.(\d{2}))?/);
  const price_cents = priceMatch
    ? Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0)
    : grams ? grams * perGram : null;

  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
  const title = firstLine
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\$\s?\d+(\.\d{2})?/g, '')
    .replace(/(?<![\w.])\d{1,3}\s?(?:g|grams?)\b/gi, '')
    .replace(/\bSOLD\b/g, '')
    .replace(/[\s\-–—:|,.!]+$/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80) || 'Little clay friend';

  return { forSale, sold, grams, price_cents, title };
}

function hasTag(lowerText, tag) {
  const i = lowerText.indexOf(tag);
  if (i < 0) return false;
  const after = lowerText[i + tag.length];
  return !after || !/[\p{L}\p{N}_]/u.test(after);
}

function pickImage(post) {
  if (post.media_type === 'IMAGE') return post.media_url;
  if (post.media_type === 'VIDEO') return post.thumbnail_url;
  if (post.media_type === 'CAROUSEL_ALBUM') {
    const first = post.children?.data?.[0];
    return first ? (first.media_type === 'VIDEO' ? first.thumbnail_url : first.media_url) : null;
  }
  return post.media_url || post.thumbnail_url || null;
}

async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
async function setMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}

// The token in the IG_ACCESS_TOKEN secret is only the starting point. Once it
// has been refreshed, the fresh one lives in the database and is used instead.
async function currentToken(env) {
  const stored = await getMeta(env, 'ig_token');
  const seededFrom = await getMeta(env, 'ig_token_seed');
  if (env.IG_ACCESS_TOKEN && seededFrom !== (await fingerprint(env.IG_ACCESS_TOKEN))) {
    // A new secret was set (first run, or Claire reconnected): start from it.
    await setMeta(env, 'ig_token', env.IG_ACCESS_TOKEN);
    await setMeta(env, 'ig_token_seed', await fingerprint(env.IG_ACCESS_TOKEN));
    await setMeta(env, 'ig_token_refreshed_at', Date.now());
    return env.IG_ACCESS_TOKEN;
  }
  return stored || env.IG_ACCESS_TOKEN || null;
}

async function fingerprint(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function refreshToken(env, token) {
  const last = Number((await getMeta(env, 'ig_token_refreshed_at')) || 0);
  if (Date.now() - last < REFRESH_AFTER_DAYS * 86400e3) return token;
  const res = await fetch(`${env.IG_API_BASE || GRAPH_DEFAULT}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    await setMeta(env, 'ig_last_error', `Token refresh failed (${res.status}): ${body.error?.message || 'no details'}`);
    return token; // keep using the old one until it actually expires
  }
  await setMeta(env, 'ig_token', body.access_token);
  await setMeta(env, 'ig_token_refreshed_at', Date.now());
  await setMeta(env, 'ig_token_expires_at', Date.now() + Number(body.expires_in || 0) * 1000);
  return body.access_token;
}

async function copyImage(env, id, url) {
  const key = `ig/${id}.jpg`;
  if (await env.PHOTOS.head(key)) return key;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download ${res.status}`);
  await env.PHOTOS.put(key, res.body, { httpMetadata: { contentType: res.headers.get('content-type') || 'image/jpeg' } });
  return key;
}

export async function syncInstagram(env) {
  const result = { ok: false, seen: 0, listed: 0, hidden: 0, error: null };
  try {
    let token = await currentToken(env);
    if (!token) throw new Error('No Instagram token yet. Set the IG_ACCESS_TOKEN secret (see README).');
    token = await refreshToken(env, token);

    let url = `${env.IG_API_BASE || GRAPH_DEFAULT}/me/media?fields=${encodeURIComponent(FIELDS)}&limit=50&access_token=${encodeURIComponent(token)}`;
    const now = Date.now();

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Instagram said ${res.status}: ${body.error?.message || 'no details'}`);

      for (const post of body.data || []) {
        result.seen++;
        const parsed = parseCaption(post.caption, env);
        const existing = await env.DB.prepare('SELECT id, locked, status FROM items WHERE id = ?').bind(post.id).first();

        if (!parsed.forSale) {
          // Sale tag removed from a post we had listed: take it off the shelf.
          if (existing && !existing.locked && existing.status !== 'hidden') {
            await env.DB.prepare("UPDATE items SET status = 'hidden', updated_at = ? WHERE id = ?").bind(now, post.id).run();
            result.hidden++;
          }
          continue;
        }
        if (existing?.locked) { result.listed++; continue; }

        const imageUrl = pickImage(post);
        if (!imageUrl) continue;
        const image_key = await copyImage(env, post.id, imageUrl);
        const status = parsed.sold ? 'sold' : 'available';

        await env.DB.prepare(
          `INSERT INTO items (id, source, title, caption, grams, price_cents, status, image_key, permalink, posted_at, locked, updated_at)
           VALUES (?, 'instagram', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, caption = excluded.caption, grams = excluded.grams,
             price_cents = excluded.price_cents, status = excluded.status, image_key = excluded.image_key,
             permalink = excluded.permalink, updated_at = excluded.updated_at`
        ).bind(post.id, parsed.title, post.caption || '', parsed.grams, parsed.price_cents, status, image_key,
               post.permalink || null, Date.parse(post.timestamp) || now, now).run();
        result.listed++;
      }
      url = body.paging?.next || null;
    }
    result.ok = true;
    await setMeta(env, 'ig_last_error', '');
  } catch (err) {
    result.error = String(err.message || err);
    await setMeta(env, 'ig_last_error', result.error).catch(() => {});
  }
  await setMeta(env, 'ig_last_sync', JSON.stringify({ at: Date.now(), ...result })).catch(() => {});
  return result;
}
