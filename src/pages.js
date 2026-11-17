// Pages for search engines: one real HTML page per listed figure, the sitemap
// and robots.txt. Pure functions only (no Cloudflare imports) so tests can load them.

export const ORIGIN = 'https://clayerbear.com';
const IG = 'https://www.instagram.com/clayerbearshop/';

// A figure is listed (gets a page) when it is on the shelf with a price. It also
// needs a photo, which the caller checks on the loaded row.
export const LISTED = "status IN ('available','sold') AND price_cents IS NOT NULL";

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// JSON for a <script> block: "</script>" and "<!--" cannot end or confuse it.
export const jsonLd = (data) =>
  JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

export function slugify(title) {
  const s = String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'figure';
}

export const figurePath = (title, id) => `/figure/${slugify(title)}-${id}`;

const money = (cents) => '$' + (cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function summary(item) {
  const text = String(item.description || '').replace(/\s+/g, ' ').trim();
  if (!text) return `${item.title}, a polymer clay figure sculpted by hand by Claire.`;
  if (text.length <= 155) return text;
  const cut = text.slice(0, 155);
  return cut.slice(0, cut.lastIndexOf(' ') > 100 ? cut.lastIndexOf(' ') : 155).replace(/[\s,.;:]+$/, '') + '...';
}

// Head, header and footer shared by the figure page and the 404 page.
function shell({ title, head = '', body, logo, favicon }) {
  const mark = logo ? `<img src="${esc(logo)}" alt="Clayer Bear">`
    : '<span class="wordmark-clayer">clayer</span>\n    <span class="wordmark-bear">bear</span>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
${head}  <link rel="icon" href="${esc(favicon || '/favicon.svg')}">
  <link rel="stylesheet" href="/fonts/fonts.css">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/theme.css">
</head>
<body>

<header class="top">
  <a class="wordmark" href="/" aria-label="Clayer Bear, home">
    ${mark}
  </a>
  <nav class="top-nav" aria-label="Main">
    <a href="/#shop">Shop</a>
    <a href="/#custom">Custom figures</a>
    <a href="/#prices">Prices</a>
    <a href="${IG}" rel="noopener">Instagram</a>
  </nav>
</header>

${body}

<footer class="bottom">
  <p>New figures, works in progress and workbench mess are on Instagram: <a href="${IG}" rel="noopener">@clayerbearshop</a></p>
</footer>
</body>
</html>
`;
}

// item: publicItem() output (status may be 'held'). opts: { checkout, logo, favicon }.
export function figurePage(item, opts = {}) {
  const url = ORIGIN + figurePath(item.title, item.id);
  const desc = summary(item);
  const photos = item.photos.map((p) => ORIGIN + p);
  const title = `${item.title} | Clayer Bear`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: item.title, description: item.description || desc, image: photos,
    sku: item.id, productID: item.id, url, brand: { '@type': 'Brand', name: 'Clayer Bear' },
    ...(item.category ? { category: item.category } : {}),
    offers: {
      '@type': 'Offer', price: (item.price_cents / 100).toFixed(2), priceCurrency: 'USD', url,
      // A hold lasts only while someone is at checkout, so it still counts as in stock.
      availability: item.status === 'sold' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: 'Clayer Bear' },
    },
  };
  const head = `  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="Clayer Bear">
  <meta property="og:title" content="${esc(item.title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(photos[0])}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(item.title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${esc(photos[0])}">
  <script type="application/ld+json">${jsonLd(ld)}</script>
`;

  const id = encodeURIComponent(item.id);
  const actions = item.status === 'sold'
    ? `<p class="sold-line">This one found a home, but I can make one for you.</p>
        <a class="button button-quiet" href="/?like=${esc(id)}">Make me one like this</a>`
    : item.status === 'held' ? '<p class="held-line">On hold while someone checks out.</p>'
    : opts.checkout ? `<a class="button" href="/?add=${esc(id)}">Add to bag</a>`
    : `<a class="button" href="/?buy=${esc(id)}">I'd like this one</a>`;
  const ig = /^https:\/\//.test(item.permalink || '') ? `\n        <a href="${esc(item.permalink)}" rel="noopener">See it on Instagram</a>` : '';
  const thumbs = item.photos.length > 1 ? `
      <div class="gallery-thumbs">
        ${item.photos.map((p, i) => `<a href="${esc(p)}" aria-label="Photo ${i + 1}"${i ? '' : ' aria-current="true"'}><img src="${esc(p)}" alt=""></a>`).join('\n        ')}
      </div>
      <script>
        for (const a of document.querySelectorAll('.gallery-thumbs a')) a.onclick = (e) => {
          e.preventDefault();
          document.querySelector('.gallery-main').src = a.getAttribute('href');
          for (const b of a.parentNode.children) b.setAttribute('aria-current', String(b === a));
        };
      </script>` : '';
  const category = item.category
    ? `\n      <p class="detail-tags">Category: <a href="/?category=${esc(encodeURIComponent(item.category))}">${esc(item.category)}</a></p>` : '';
  const tags = item.tags && item.tags.length
    ? `\n      <p class="detail-tags">More like this: ${item.tags.map((t) => `<a href="/?q=${esc(encodeURIComponent(t))}">${esc(t)}</a>`).join(', ')}</p>` : '';
  const status = { available: 'Available', held: 'On hold', sold: 'Sold' }[item.status] || '';

  const body = `<main class="figure-page${item.status === 'sold' ? ' is-sold' : ''}">
  <div class="detail-grid">
    <div class="gallery">
      <img class="gallery-main" src="${esc(item.photos[0])}" alt="${esc(item.title)}">${thumbs}
    </div>
    <div class="detail-words">
      <h1>${esc(item.title)}</h1>
      <p class="tag">${item.grams ? esc(item.grams) + 'g : ' : ''}<span class="tag-price">${esc(money(item.price_cents))}</span></p>
      <p class="figure-status">${status}</p>${item.description ? `\n      <p class="detail-desc">${esc(item.description)}</p>` : ''}${category}${tags}
      <div class="detail-actions">
        ${actions}${ig}
      </div>
    </div>
  </div>
  <p class="figure-back"><a href="/#shop">See everything on the shelf</a></p>
</main>`;
  return shell({ title, head, body, logo: opts.logo, favicon: opts.favicon });
}

export function notFoundPage(opts = {}) {
  const body = `<main class="figure-page">
  <h1>I can't find that figure.</h1>
  <p>It may have been taken off the shelf, or the link is not quite right.</p>
  <p><a href="/#shop">See what's on the shelf</a></p>
</main>`;
  return shell({ title: 'Not found | Clayer Bear', head: '  <meta name="robots" content="noindex">\n', body, logo: opts.logo, favicon: opts.favicon });
}

// rows: listed figures as loaded from the database ({ id, title, updated_at, posted_at }).
export function sitemap(rows) {
  const xml = (s) => esc(s).replace(/&#39;/g, '&apos;');
  const entry = (loc, ms) => `  <url><loc>${xml(loc)}</loc>${ms ? `<lastmod>${day(ms)}</lastmod>` : ''}</url>`;
  const changed = (r) => r.updated_at || r.posted_at || 0;
  const latest = Math.max(0, ...rows.map(changed));
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry(ORIGIN + '/', latest),
    ...rows.map((r) => entry(ORIGIN + figurePath(r.title, r.id), changed(r))),
    '</urlset>', ''].join('\n');
}

export const robots = () => `User-agent: *
Disallow: /admin
Disallow: /api/

Sitemap: ${ORIGIN}/sitemap.xml
`;
