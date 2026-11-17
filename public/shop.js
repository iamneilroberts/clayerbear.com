/* Clayer Bear storefront.
   Loads the figures and shop settings, draws the shelf, and runs search,
   the close-up view, the bag and the request forms.
   No build step, no libraries. Edit and redeploy. */

const INSTAGRAM = 'https://www.instagram.com/clayerbearshop/';
const $ = (id) => document.getElementById(id);

const shelf = $('shelf');
const note = $('shop-note');
const customForm = $('custom-form');
const customRef = $('custom-ref');
const buyForm = $('buy-form');

let items = [];
let site = { checkout: false, shipping_cents: 0, shipping_label: 'Shipping', price_per_gram_cents: 100 };
let demo = false;                       // true while only the sample figures are showing
const view = { category: '', search: '', onlyAvailable: false };

const money = (cents) => '$' + (cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid) node.append(kid);
  return node;
}

function tag(item, props = {}) {
  const p = el('p', { class: 'tag', ...props });
  if (item.grams) p.append(item.grams + 'g : ');
  p.append(el('span', { class: 'tag-price', text: money(item.price_cents) }));
  return p;
}

/* ----- the bag (remembered in this browser only) ----- */

let bag = [];
try { bag = JSON.parse(localStorage.getItem('cb-bag') || '[]'); } catch {}
const saveBag = () => { try { localStorage.setItem('cb-bag', JSON.stringify(bag)); } catch {} };
const inBag = (id) => bag.includes(id);

function setBag(next) {
  bag = next;
  saveBag();
  $('bag-count').textContent = bag.length;
  $('bag-button').hidden = (!site.checkout && !demo) || bag.length === 0;
  draw();
}

/* ----- what a figure's buttons do ----- */

function actions(item, { inDetail = false } = {}) {
  if (item.status === 'sold') {
    return [
      el('p', { class: 'sold-line', text: 'This one found a home, but I can make one for you.' }),
      el('button', { class: 'button button-quiet', type: 'button', text: 'Make me one like this', onclick: () => askForOneLike(item) }),
    ];
  }
  if (item.status === 'held') {
    return [el('p', { class: 'held-line', text: 'On hold while someone checks out.' })];
  }
  if (site.checkout || demo) {
    return inBag(item.id)
      ? [el('button', { class: 'button button-quiet', type: 'button', text: 'In your bag. Open bag', onclick: openBag })]
      : [el('button', { class: 'button', type: 'button', text: 'Add to bag', onclick: () => { setBag([...bag, item.id]); if (inDetail) openDetail(item); } })];
  }
  return [el('button', { class: 'button', type: 'button', text: "I'd like this one", onclick: () => openBuy(item) })];
}

/* ----- the shelf ----- */

function figure(item) {
  const sold = item.status === 'sold';
  return el('li', { class: 'figure' + (sold ? ' is-sold' : '') },
    el('button', { class: 'figure-photo', type: 'button', 'aria-label': 'Look closer at ' + item.title, onclick: () => openDetail(item) },
      el('img', { src: item.photos[0], alt: '', loading: 'lazy' }),
      sold ? el('span', { class: 'sold-flag', text: 'Sold' }) : null
    ),
    el('div', { class: 'figure-step' }),
    el('div', { class: 'figure-info' },
      el('h3', {}, el('button', { type: 'button', text: item.title, onclick: () => openDetail(item) })),
      tag(item),
      actions(item)
    )
  );
}

function matches(item) {
  if (view.category && item.category !== view.category) return false;
  if (view.onlyAvailable && item.status !== 'available') return false;
  if (view.search) {
    const hay = [item.title, item.description, item.category, ...(item.tags || [])].join(' ').toLowerCase();
    if (!view.search.toLowerCase().split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function draw() {
  const shown = items.filter(matches);
  shelf.replaceChildren(...shown.map(figure));
  note.hidden = shown.length > 0;
  if (!items.length) {
    note.replaceChildren('The shelf is empty right now. New figures show up on ',
      el('a', { href: INSTAGRAM, rel: 'noopener', text: 'Instagram' }), ' first.');
  } else if (!shown.length) {
    note.textContent = 'Nothing like that on the shelf right now.';
  }
}

function drawFilters() {
  const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
  const button = (label, value) => el('button', {
    type: 'button', class: 'filter' + (view.category === value ? ' is-on' : ''), text: label,
    onclick: () => { view.category = value; drawFilters(); draw(); },
  });
  $('filters').replaceChildren(
    ...(cats.length ? [button('Everything', '')] : []),
    ...cats.map((c) => button(c, c)),
    el('label', { class: 'only-available' },
      el('input', { type: 'checkbox', checked: view.onlyAvailable, onchange: (e) => { view.onlyAvailable = e.target.checked; draw(); } }),
      'Available only')
  );
}

$('search').addEventListener('input', (e) => { view.search = e.target.value.trim(); draw(); });

/* ----- close-up view ----- */

const detail = $('detail-dialog');

function openDetail(item) {
  const main = $('detail-main');
  const show = (src) => {
    main.src = src; main.alt = item.title;
    for (const b of $('detail-thumbs').children) b.setAttribute('aria-current', String(b.dataset.src === src));
  };
  $('detail-thumbs').replaceChildren(...(item.photos.length > 1 ? item.photos.map((src, i) =>
    el('button', { type: 'button', 'data-src': src, 'aria-label': 'Photo ' + (i + 1), onclick: () => show(src) }, el('img', { src, alt: '' }))) : []));
  show(item.photos[0]);
  $('detail-title').textContent = item.title;
  $('detail-tag').replaceWith(tag(item, { id: 'detail-tag' }));
  $('detail-desc').textContent = item.description || '';
  const tags = item.tags || [];
  $('detail-tags').replaceChildren(...tags.flatMap((t, i) => [
    i ? ', ' : 'More like this: ',
    el('button', { type: 'button', text: t, onclick: () => { detail.close(); $('search').value = t; view.search = t; draw(); $('shop').scrollIntoView(); } }),
  ]));
  $('detail-actions').replaceChildren(...actions(item, { inDetail: true }),
    ...(item.permalink ? [el('a', { href: item.permalink, rel: 'noopener', text: 'See it on Instagram' })] : []));
  if (!detail.open) detail.showModal();
}

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
}

/* ----- bag and checkout ----- */

function openBag() {
  if (detail.open) detail.close();
  const mine = bag.map((id) => items.find((i) => i.id === id)).filter((i) => i && i.status === 'available');
  if (mine.length !== bag.length) setBag(mine.map((i) => i.id)); // something sold or went on hold meanwhile
  $('bag-list').replaceChildren(...mine.map((item) => el('li', {},
    el('img', { src: item.photos[0], alt: '' }),
    el('div', {}, el('strong', { text: item.title }), tag(item)),
    el('button', { type: 'button', text: 'Remove', onclick: () => { setBag(bag.filter((id) => id !== item.id)); openBag(); } })
  )));
  const subtotal = mine.reduce((n, i) => n + i.price_cents, 0);
  $('bag-total').textContent = mine.length ? 'Figures: ' + money(subtotal) : 'Your bag is empty.';
  $('bag-ship').textContent = mine.length
    ? `${site.shipping_label}: ${money(site.shipping_cents)}, added at checkout.` + (site.pickup ? ` Or choose "${site.pickup_label}" there.` : '') : '';
  $('checkout').hidden = !mine.length;
  $('bag-status').textContent = '';
  if (!$('bag-dialog').open) $('bag-dialog').showModal();
}
$('bag-button').addEventListener('click', openBag);

$('checkout').addEventListener('click', async () => {
  const status = $('bag-status');
  if (demo) { status.textContent = "These are sample figures, so there's nothing to pay for yet."; return; }
  $('checkout').disabled = true;
  status.textContent = 'Opening the payment page…';
  try {
    const res = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: bag }) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.unavailable) {
      await load();
      setBag(bag.filter((id) => !body.unavailable.includes(id)));
      openBag();
      $('bag-status').textContent = body.error;
      return;
    }
    if (!res.ok || !body.url) throw new Error(body.error || '');
    try { localStorage.setItem('cb-hold', body.hold); } catch {}
    location.href = body.url;
  } catch (err) {
    status.textContent = err.message || "The payment page didn't open. Nothing was charged. Please try again.";
  } finally {
    $('checkout').disabled = false;
  }
});

// Coming back from Stripe's payment page, by its links or the Back button.
// If a checkout was started and not paid, let go of the hold straight away.
async function handleReturn() {
  const q = new URLSearchParams(location.search);
  const order = q.get('order');
  let hold = q.get('hold');
  try { hold = hold || localStorage.getItem('cb-hold'); localStorage.removeItem('cb-hold'); } catch {}
  const notice = $('notice');
  if (order === 'paid') {
    bag = []; saveBag();
    notice.textContent = "Thank you! Your order is in. I'll email you when it's on its way.";
    notice.hidden = false;
  } else if (hold) {
    await fetch('/api/checkout/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hold }) }).catch(() => {});
    if (order === 'cancelled') {
      notice.textContent = 'Checkout cancelled. Nothing was charged, and your bag is still here.';
      notice.hidden = false;
    }
  }
  if (order) history.replaceState(null, '', location.pathname);
}

/* ----- asking by email: request fallback and custom figures ----- */

function openBuy(item) {
  buyForm.reset();
  setStatus(buyForm, '');
  buyForm.elements.item_id.value = item.id;
  $('buy-img').src = item.photos[0];
  $('buy-title').textContent = item.title;
  $('buy-tag').replaceWith(tag(item, { id: 'buy-tag' }));
  if (detail.open) detail.close();
  $('buy-dialog').showModal();
}

function askForOneLike(item) {
  if (detail.open) detail.close();
  customForm.elements.kind.value = 'like';
  customForm.elements.item_id.value = item.id;
  customRef.hidden = false;
  customRef.replaceChildren('Like the ' + item.title.toLowerCase(),
    el('button', { type: 'button', text: 'remove', onclick: clearRef }));
  if (item.grams === 10 || item.grams === 20) customForm.elements.grams.value = String(item.grams);
  $('custom').scrollIntoView();
  $('c-message').focus({ preventScroll: true });
}
function clearRef() {
  customForm.elements.kind.value = 'custom';
  customForm.elements.item_id.value = '';
  customRef.hidden = true;
}

function setStatus(form, text, kind) {
  const p = form.querySelector('.form-status');
  p.textContent = text;
  p.className = 'form-status' + (kind ? ' is-' + kind : '');
}

async function send(form) {
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus(form, 'Sending…');
  try {
    const res = await fetch('/api/requests', { method: 'POST', body: new FormData(form) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || '');
    form.reset();
    if (form === customForm) clearRef();
    setStatus(form, "Request sent. I'll email you soon.", 'good');
  } catch (err) {
    setStatus(form, (err.message ? err.message + ' ' : "That didn't send. ") + 'You can also message me on Instagram @clayerbearshop.', 'bad');
  } finally {
    button.disabled = false;
  }
}
buyForm.addEventListener('submit', (e) => { e.preventDefault(); send(buyForm); });
customForm.addEventListener('submit', (e) => { e.preventDefault(); send(customForm); });

/* ----- loading ----- */

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) return await res.json();
  } catch {}
  return null;
}

function applySite() {
  if (site.hero_title) $('hero-title').textContent = site.hero_title;
  if (site.hero_text) $('hero-text').textContent = site.hero_text;
  if (site.hero) $('hero-img').src = site.hero;
  if (site.favicon) $('favicon').href = site.favicon;
  if (site.logo) $('wordmark').replaceChildren(el('img', { src: site.logo, alt: 'Clayer Bear' }));
  const per = site.price_per_gram_cents || 100;
  $('price-10').textContent = money(10 * per);
  $('price-20').textContent = money(20 * per);
}

async function load() {
  // Opened as plain files (no Worker running): show the sample figures so the
  // page can still be designed against something.
  const data = (await getJson('/api/items')) || (await getJson('sample/items.json')) || { items: [] };
  items = (data.items || []).filter((i) => i.photos && i.photos.length);
  demo = !!data.demo;
  drawFilters();
  setBag(bag.filter((id) => items.some((i) => i.id === id && i.status === 'available')));
}

// Preview copy only (no server behind the page): send the owner links to the
// demo admin and the "how it works" doc instead of the real /admin/.
const PREVIEW_ADMIN = 'https://claude.ai/artifact/FWc7bvCGT1JzrrMtvLSiZT';
const PREVIEW_DOC = 'https://claude.ai/artifact/4PXvC96Tck1Vbji1FY1WJq';

(async () => {
  const live = await getJson('/api/site');
  if (!live) {
    $('admin-link').href = PREVIEW_ADMIN;
    $('admin-link').textContent = 'Shop admin (demo)';
    $('owner-links').append(el('a', { href: PREVIEW_DOC, rel: 'noopener', text: 'How this site works' }));
  }
  site = { ...site, ...(live || {}) };
  applySite();
  await handleReturn();
  await load();
})();
