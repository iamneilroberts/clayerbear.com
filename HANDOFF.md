# Handoff: finish clayerbear.com and put it live

You are picking up a small shop website for Claire, who makes one-of-a-kind
polymer clay animal figures. Her dad, Neil, owns the Cloudflare account and
the domain clayerbear.com and is the person you are working with. Claire is a
graphic designer; she will run the shop from her phone and restyle it herself.

This folder is the whole project. Read `README.md` and `wrangler.jsonc` before
doing anything. The goal of this session, in order:

1. Confirm the project runs and its tests pass.
2. Finish search (section 3).
3. Deploy to clayerbear.com and www.clayerbear.com.
4. Verify the live site.
5. If Neil has the keys ready, connect Stripe in test mode. Otherwise leave
   clear instructions.

Stop and ask Neil whenever a step below says to. Do not guess at anything
involving money, DNS or credentials.

## 1. What exists

One Cloudflare Worker with static assets. No framework, no build step, no
WordPress. Free-tier services only.

- `public/` is the shop page (`index.html`, `styles.css`, `shop.js`) and the
  admin pages (`public/admin/`). Plain HTML, CSS and JavaScript.
- `src/worker.js` routes requests. `src/admin.js` is the admin API,
  `src/stripe.js` is checkout, `src/instagram.js` posts to Instagram,
  `src/store.js` holds the database setup, settings and theme.
- D1 database `clayerbear` (binding `DB`): figures, photos, orders, requests,
  settings. Tables create and upgrade themselves on first request.
- R2 bucket `clayerbear-photos` (binding `PHOTOS`): figure photos, logo, font
  uploads, and private photos customers attach to custom requests.
- A daily cron renews the Instagram token.

What the site does:

- **Shop:** figures on a shelf, category filters, text search, close-up view
  with several photos, a bag, and Stripe Checkout with flat shipping. Sold
  figures stay visible with "Make me one like this". A custom-figure request
  form with optional photo upload.
- **Admin** at `/admin/` (shared password): add and edit figures with multiple
  photos, name, description, category, tags, weight, price and status; orders
  and requests; a Look page for colors, typefaces and logo; shop settings;
  a composer that publishes one or several figures to Instagram.

How well each part has been tested:

| Part | State |
|---|---|
| Shop page, admin screens, figure editing, photo upload and ordering | Tested in a browser against `wrangler dev` |
| Checkout holds, webhook, cancel and expiry paths | Tested against a local stand-in for Stripe's API. Never run against real Stripe. |
| Instagram publishing | Tested against a local stand-in for Meta's API. Never run against the real account. |
| Email notice on custom requests | Written, never run. Leave it off. |
| Deployment | Never deployed from this version. Neil may have deployed an earlier version; check (section 4). |

`npm test` runs 11 unit tests (caption parser, webhook signature, theme
safety). There are no browser tests in the repo.

## 2. Rules for this session

- Keep it a no-build, no-framework project. No React, no Tailwind, no bundler,
  no new runtime dependencies. `wrangler` is the only dev dependency.
- Do not redesign. The look comes from Claire's market sign (sage green,
  lavender, cocoa brown, rounded lettering) and the shelf drawn as her white
  tiered display. She dislikes anything that looks AI-generated. Specifically
  do not add: gradients, emoji, icon sets, drop-shadowed card grids, all-caps
  eyebrow labels, text joined with middle dots, arrows on links, entrance
  animations, or marketing copy. Copy is first person, short and plain.
- Colors and fonts in `styles.css` are defaults. The Look page overrides them
  through `/theme.css`. Any new page must use the same CSS variables
  (`--paper`, `--card`, `--cocoa`, `--sage-deep`, `--sage`, `--lavender`,
  `--lilac-wash`, `--font-head`, `--font-body`, `--font-hand`) and load
  `/theme.css` after `styles.css`.
- The admin pages are deliberately plain and do not use the shop theme. Keep
  them that way.
- Secrets go in with `npx wrangler secret put NAME` and Neil types the value.
  Never invent, echo, log or write a secret to a file.
- Only edit DNS records for clayerbear.com and www.clayerbear.com, and only
  after showing Neil what you will change. Never touch MX or TXT records.
- Do not invent business policy: shipping prices, return terms, tax, turnaround
  times. If a page needs such wording, ask Neil or leave a clearly marked
  placeholder and list it in your report.
- Commit your work in small commits on a branch if this is a git repo. Do not
  push unless Neil asks.

One quirk: under `wrangler dev`, the `routes` block makes `request.url` report
the host as clayerbear.com, so checkout return links built locally point at
production. That is expected. Do not "fix" it by removing the routes.

## 3. Finish search

Two things are meant by search here. Neil asked for search to be finished
without saying which, so do both and say in your report what you did.

### 3a. Search on the shop page

What exists: a search box above the shelf. `matches()` in `public/shop.js`
filters the figures already loaded in the page by every typed word against
name, description, category and tags. Category buttons and an "Available
only" tick box filter the same list. Tags in the close-up view run a search.

Finish it:

- Make the current search and category part of the address, so a search or a
  category can be linked and survives reload and the Back button. Use query
  parameters on the shop page (for example `?q=cat&category=Cats`). The page
  already reads `?order=` and `?hold=` on return from Stripe in
  `handleReturn()`; do not break that.
- Match word starts and simple plurals so "cats" finds "cat" and "pon" finds
  "pony". Keep it a small function, no search library.
- Show how many figures match when a search or filter is active, and offer one
  control that clears search and filters together.
- Keep the empty result message, and add a way from it to the custom-figure
  form, since "you don't have a giraffe" is a custom order lead.
- Check it by keyboard and with a screen reader label, and at phone width.

### 3b. Being found by search engines

What exists: almost nothing. Figures are drawn by JavaScript from
`/api/items`, there are no per-figure addresses, no sitemap and no robots
file. A crawler that does not run scripts sees an empty shelf.

Finish it:

- Give every listed figure (status available or sold, with a photo and price)
  its own address served by the Worker, for example `/figure/<slug>-<id>`,
  as real HTML: name, photos, description, price, availability, category,
  tags, and the same buy or "make me one like this" actions. Reuse the shop's
  stylesheet and header. The close-up dialog on the shop page should link to
  and share this address.
- On those pages include a title, meta description, canonical link, Open Graph
  and Twitter card tags with the first photo, and JSON-LD `Product` with
  `Offer` (price, currency USD, `InStock` or `SoldOut`).
- Escape every piece of figure text you put into HTML or JSON-LD. Names and
  descriptions are typed by a person and must not be able to inject markup.
- Serve `/sitemap.xml` from the Worker listing the home page and every listed
  figure with its last change date. Serve `/robots.txt` allowing everything
  except `/admin/` and `/api/`, and pointing at the sitemap.
- Add the new paths to `run_worker_first` in `wrangler.jsonc`.
- Draft and hidden figures must return 404 on their address and stay out of
  the sitemap.
- Add JSON-LD for the home page (`Organization` or `Store` with the Instagram
  profile https://www.instagram.com/clayerbearshop/ as `sameAs`).
- Sample figures (shown only while the shelf is empty and `SHOW_SAMPLES` is
  `"true"`) must not get pages or sitemap entries.

Add unit tests for the slug function, the HTML escaping and the sitemap
output. Run `npm test`.

## 4. Deploy

1. Check Node is 20 or newer. `npm install`, `npm test`. Stop if tests fail.
2. `npx wrangler whoami`. If not logged in, `npx wrangler login` and wait for
   Neil. Confirm the account holds the clayerbear.com zone. If there is more
   than one account, ask which.
3. Find out whether an earlier version is deployed:
   `npx wrangler d1 list` and `npx wrangler r2 bucket list`.
   - If a D1 database named `clayerbear` exists, put its id in
     `wrangler.jsonc` in place of `PASTE-ID-FROM-wrangler-d1-create`. Do not
     create a second one. Its data upgrades itself; do not drop or recreate
     tables.
   - If not, `npx wrangler d1 create clayerbear` and use the new id.
   - If the bucket `clayerbear-photos` does not exist,
     `npx wrangler r2 bucket create clayerbear-photos`. If R2 is not enabled
     on the account, stop and tell Neil; he has to enable it in the dashboard.
4. `npx wrangler secret list`. If `ADMIN_PASSWORD` is missing, run
   `npx wrangler secret put ADMIN_PASSWORD` and let Neil type it.
5. `npx wrangler deploy --dry-run`, show Neil the bindings, then
   `npx wrangler deploy`.
6. If the deploy fails because DNS records already exist for the two
   hostnames, list them and ask Neil before changing anything.

Leave `SHOW_SAMPLES` as `"true"` unless Neil says Claire has real figures in.

## 5. Verify the live site

Show Neil the output of each. A new custom domain certificate can take a few
minutes; retry before calling something a failure.

- `https://clayerbear.com/` and `https://www.clayerbear.com/` return 200.
- `/api/site` returns JSON. `/api/items` returns JSON (sample figures with
  `"demo": true` if the shelf is empty).
- `/theme.css` returns CSS with a `:root` block.
- `/admin/` loads. `GET /api/admin/overview` without a password returns 401.
- `/robots.txt` and `/sitemap.xml` return what section 3b describes.
- Create a draft figure in the admin, add a photo, put it on the shelf, open
  its figure page, search for it by a tag, then delete it. Ask Neil before
  doing this on a shelf that already has Claire's real figures, and never
  delete a figure you did not create.

## 6. Stripe, if Neil has the keys

The Stripe account must be Claire's. Use test mode first.

1. `npx wrangler secret put STRIPE_SECRET_KEY` (Neil pastes an `sk_test_`
   key).
2. In the Stripe dashboard a webhook endpoint is needed at
   `https://clayerbear.com/api/stripe/webhook` for
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded` and
   `checkout.session.async_payment_failed`. Neil creates it and copies the
   signing secret.
3. `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. With Neil, buy a test figure using card 4242 4242 4242 4242 and confirm:
   the figure shows "On hold" during payment, turns Sold after, and the order
   appears in Admin > Orders with name, email, address, shipping and total.
   Also start a checkout and cancel it, and confirm the hold is released.
5. If the address is missing from the order, look at the webhook payload in
   the Stripe dashboard. `stripeWebhook()` in `src/stripe.js` reads
   `collected_information.shipping_details` and falls back to
   `shipping_details`. Fix it against the real payload and add a test.

Do not switch to live keys in this session unless Neil asks.

Shipping is a placeholder: $5 flat, US addresses only, set in Admin > Shop
settings. Sales tax is not collected. Leave both alone and list them as open.

## 7. Instagram, only if Neil asks

Posting needs Claire's Business account, a Meta developer app, and a token
with `instagram_business_basic` and `instagram_business_content_publish`
stored as the `IG_ACCESS_TOKEN` secret. README has the steps. It can only be
tried on the live site because Instagram downloads the photos itself. It is
not known whether Meta lets an unreviewed app publish to its own account; the
first real post will show. Importing posts from Instagram is deferred; leave
`src/deferred/` alone.

## 8. Out of scope unless Neil asks

Cloudflare Access on the admin, Turnstile on the forms, order or shipping
emails, sales tax, shipping outside the US, refunds from the admin, a policy
page with real terms.

## 9. Finish with a report

- Live addresses and whether each check in section 5 passed.
- What you built for search, in two short lists (shop page, search engines).
- Every file you changed and why.
- The D1 database id in use and whether it was new or existing.
- What is connected (Stripe test or live, Instagram) and what is not.
- Open items that need Neil or Claire: shipping price, sales tax, policy
  wording, real figures and copy, any placeholder you left.
- Anything that did not verify.
