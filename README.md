# clayerbear.com

Claire's shop for tiny polymer clay animals. Runs on Cloudflare's free tier:
no WordPress, no server, no monthly bill beyond the domain. Stripe takes its
per-sale fee when card checkout is on.

## How Claire runs the shop

Everything is done at **clayerbear.com/admin/** (works on a phone).

| Tab | What it is for |
|---|---|
| **Figures** | Add and edit figures: several photos each (first one is the shelf photo), name, description, category, tags, weight, price, and where it is (draft, on the shelf, sold, hidden). Tick one or more figures to make an Instagram post from them. |
| **Orders** | Paid orders with the shipping address, and custom-figure requests. Mark them sent or done. |
| **Look** | Colors (with presets), typefaces for headings / reading text / price tags, her own uploaded fonts, logo, browser tab icon and front page photo. A preview updates as she changes things. |
| **Shop settings** | Front page headline and intro, price per gram, shipping price, optional free pickup, default Instagram hashtags, and whether Stripe and Instagram are connected. |

Notes on how things behave:

- **Price** is weight x price-per-gram unless a price is typed in.
- **Sold** figures stay on the shelf, marked sold, with "Make me one like this".
- **Categories** become the filter buttons on the shop. **Tags** feed search
  and the "More like this" links.
- Photos are shrunk in the browser before upload, so phone photos are fine.
- Colors and fonts saved in **Look** reach the shop within about a minute.

## Buying

With Stripe connected, buyers add figures to a bag and pay on Stripe's page,
which collects the shipping address and adds the flat shipping charge.

- While someone is paying, their figures show "On hold" for up to 30 minutes
  so nobody else can buy the same one.
- When payment succeeds the figures become **Sold** on their own and the order
  appears under **Orders**.
- If the buyer backs out, the hold is released.

Without Stripe connected the button says "I'd like this one" and sends Claire
a request instead.

Not handled yet: sales tax, shipping outside the US, refunds from the admin
page (do those in the Stripe dashboard), and a "your order shipped" email.

## Instagram

**Posting from the site** (Figures tab): pick photos, edit the drafted caption
and hashtags, publish. One photo makes a normal post, several make a carousel.
Instagram only accepts photos between portrait 4:5 and wide 1.91:1, so taller
photos are trimmed top and bottom for the post (the shop keeps the original).

**Pulling Instagram posts into the shop** is switched off. The earlier code
for it is parked in `src/deferred/instagram-import.js`.

## What's in here

| Path | What it is |
|---|---|
| `public/index.html`, `styles.css`, `shop.js` | The shop page. Layout and shapes live in `styles.css`; colors and fonts there are only the defaults that **Look** overrides. |
| `public/admin/` | The admin pages |
| `public/fonts/` | Bundled open-licensed typefaces |
| `public/sample/` | Sample figures shown while the shelf is empty |
| `src/worker.js` | Public API, photos, theme stylesheet |
| `src/admin.js` | Admin API |
| `src/stripe.js` | Checkout, holds, webhook |
| `src/instagram.js` | Posting to Instagram, token renewal |
| `src/store.js` | Database setup, settings, theme |
| `wrangler.jsonc` | Cloudflare settings |

No build step. Edit a file, run `npm run deploy`.

## Deploying

Needs Node 20+ and the Cloudflare account that holds clayerbear.com.

**Already deployed the first version?** Keep the `database_id` you put in
`wrangler.jsonc` (copy it into this version's file), then `npm install` and
`npm run deploy`. The database upgrades itself on the first request and keeps
existing figures.

**First time:**

    npm install
    npx wrangler login
    npx wrangler d1 create clayerbear          # paste the database_id into wrangler.jsonc
    npx wrangler r2 bucket create clayerbear-photos
    npx wrangler secret put ADMIN_PASSWORD     # pick a long one
    npm run deploy

R2 has to be switched on once in the Cloudflare dashboard (it asks for a card
even though the free allowance is far more than this needs).

Until the first real figure is on the shelf, the shop shows the samples. Set
`SHOW_SAMPLES` to `"false"` in `wrangler.jsonc` to turn that off for good.

## Connecting Stripe

Do this in **test mode** first.

1. Create a Stripe account in Claire's name (the money goes to whoever owns it).
2. Developers > API keys: copy the secret key (`sk_test_...`).
   `npx wrangler secret put STRIPE_SECRET_KEY`
3. Developers > Webhooks: add an endpoint
   `https://clayerbear.com/api/stripe/webhook` listening for
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded` and
   `checkout.session.async_payment_failed`.
4. Copy that endpoint's signing secret (`whsec_...`).
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
5. Buy something with Stripe's test card 4242 4242 4242 4242. Check that the
   figure turns Sold and the order shows under Orders with its address.
6. Repeat steps 2 to 4 with the live key and a live-mode webhook.

**Shop settings > Connections** shows whether both secrets are in place. If
only the key is set, people can pay but figures will not be marked sold.

## Connecting Instagram

Uses Meta's "Instagram API with Instagram Login". Meta rearranges its
developer dashboard often, so treat the click path as approximate.

1. @clayerbearshop must be a Business or Creator account.
2. At developers.facebook.com create an app, add the **Instagram** product,
   choose "API setup with Instagram login".
3. Add @clayerbearshop to the app and accept the invitation inside Instagram.
4. Generate a token for the account with the `instagram_business_basic` and
   `instagram_business_content_publish` permissions.
5. `npx wrangler secret put IG_ACCESS_TOKEN`
6. Open **Shop settings**: it should say "connected as @clayerbearshop".

The token lasts 60 days; the site renews it weekly. If it lapses, the admin
page shows the error; repeat steps 4 and 5.

Posting has been tested only against a stand-in for Meta's API. Whether a
development-mode app may publish to its own account without Meta's App Review
needs confirming with the first real post.

## Email when a request comes in (optional, untested)

Turn on Email Routing for clayerbear.com, verify Claire's address, then
uncomment the `send_email` block in `wrangler.jsonc` and add `NOTIFY_FROM`
and `NOTIFY_TO` vars. Without it, requests wait in **Orders**. Paid orders do
not send an email from this site; Stripe can email Claire on each payment
(Stripe dashboard > Settings > Communication preferences).

## Working on it locally

    npm run dev        # http://localhost:8787 with a local database and bucket
    npm test

Put `ADMIN_PASSWORD=whatever` in a file named `.dev.vars`. Stripe test keys
work locally; Instagram posting does not, because Instagram has to download
the photos from a public address.

## Worth doing next

- Cloudflare Access (free) in front of `/admin*` and `/api/admin/*` for a real
  login instead of a shared password.
- Cloudflare Turnstile on the request form if spam shows up.
- Sales tax (Stripe Tax) once Claire knows what she owes where.
- A shipped-notification email and a returns / shipping policy page.
