import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, esc, jsonLd, figurePage, sitemap, robots } from '../src/pages.js';

const HOSTILE = `</script><img src=x onerror=alert(1)> "quoted" 'single' & more`;

test('slug is lowercase ascii with single hyphens, capped, with a fallback', () => {
  assert.equal(slugify('Round Calico Cat'), 'round-calico-cat');
  assert.equal(slugify('  Crème brûlée -- bunny!! '), 'creme-brulee-bunny');
  assert.equal(slugify('Ñandú & Co.'), 'nandu-co');
  assert.equal(slugify('!!!'), 'figure');
  assert.equal(slugify(''), 'figure');
  assert.equal(slugify('猫'), 'figure');
  const long = slugify('a'.repeat(59) + ' bbbbbbbb');
  assert.ok(long.length <= 60 && !long.endsWith('-'), long);
  assert.equal(long, 'a'.repeat(59));
});

test('html escaping covers & < > " and \'', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('json-ld cannot close its script tag and still parses back', () => {
  const out = jsonLd({ name: HOSTILE });
  assert.ok(!out.includes('<') && !out.includes('>'));
  assert.equal(JSON.parse(out).name, HOSTILE);
});

test('a figure page escapes hostile names, descriptions, tags and categories everywhere', () => {
  const item = {
    id: 'fabc123', title: HOSTILE, description: HOSTILE, category: `Cats"><b>`, tags: [`x"><script>`, 'cat & dog'],
    grams: 20, price_cents: 2000, status: 'available', photos: ['/img/items/fabc123/a.jpg'], permalink: null,
  };
  const html = figurePage(item, { checkout: true });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('"quoted"'));
  assert.ok(!html.replace(/<script type="application\/ld\+json">.*?<\/script>/s, '').includes(`'single'`));
  assert.ok(!html.includes('<b>'));
  assert.equal(html.match(/<script\b/g).length, 1, 'only the JSON-LD script tag');
  assert.equal(html.match(/<\/script>/g).length, 1);
  assert.ok(html.includes('<h1>&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &#39;single&#39; &amp; more</h1>'));
  assert.ok(html.includes('href="/?category=Cats%22%3E%3Cb%3E"'));
  assert.ok(html.includes('href="/?q=cat%20%26%20dog"'));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(ld.name, HOSTILE);
  assert.equal(ld.offers.price, '20.00');
  assert.equal(ld.offers.availability, 'https://schema.org/InStock');
  assert.deepEqual(ld.image, ['https://clayerbear.com/img/items/fabc123/a.jpg']);
  assert.ok(html.includes('href="/?add=fabc123">Add to bag'));
});

test('sitemap lists the home page and each figure with its last change date', () => {
  const xml = sitemap([
    { id: 'fa1', title: 'Round calico cat', updated_at: Date.UTC(2026, 10, 3, 12), posted_at: Date.UTC(2026, 9, 1) },
    { id: 'fb2', title: 'Pony & friend', updated_at: null, posted_at: Date.UTC(2026, 9, 20) },
  ]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<url><loc>https://clayerbear.com/</loc><lastmod>2026-11-03</lastmod></url>'));
  assert.ok(xml.includes('<url><loc>https://clayerbear.com/figure/round-calico-cat-fa1</loc><lastmod>2026-11-03</lastmod></url>'));
  assert.ok(xml.includes('<url><loc>https://clayerbear.com/figure/pony-friend-fb2</loc><lastmod>2026-10-20</lastmod></url>'));
  assert.equal(xml.match(/<url>/g).length, 3);
  assert.equal(sitemap([]).match(/<url>/g).length, 1);
});

test('robots.txt keeps crawlers out of admin and api and points at the sitemap', () => {
  const txt = robots();
  assert.match(txt, /^Disallow: \/admin$/m);
  assert.match(txt, /^Disallow: \/api\/$/m);
  assert.match(txt, /^Sitemap: https:\/\/clayerbear\.com\/sitemap\.xml$/m);
});
