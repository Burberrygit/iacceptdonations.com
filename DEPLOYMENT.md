# Free Hosting Plan

## Goal

Keep hosting at $0/year while still letting Stripe receive the exact amount selected on the homepage.

## Architecture

- GitHub Pages hosts the static website.
- Cloudflare proxies `www.iacceptdonations.com`.
- Cloudflare Worker handles only `/api/create-checkout-session`.
- Stripe secret key lives only in Cloudflare Worker secrets.
- PayPal continues to use the hosted PayPal payment link with the selected amount in the URL.

## Stripe Worker Setup

1. In Cloudflare, create a Worker using `cloudflare-worker.mjs`.
2. Set the Worker route:
   `https://www.iacceptdonations.com/api/create-checkout-session`
3. Add the Stripe secret key as a Worker secret:
   `STRIPE_SECRET_KEY`
4. Keep these Worker variables:
   - `SITE_URL`: `https://www.iacceptdonations.com`
   - `ALLOWED_ORIGIN`: `https://www.iacceptdonations.com`
   - `PRODUCT_IMAGE_URL`: `https://www.iacceptdonations.com/assets/stripe-money-trash-product-1024.jpg`

## Local Files

- `script.js` calls `/api/create-checkout-session` for Stripe.
- `cloudflare-worker.mjs` creates a Stripe Checkout Session using the selected amount.
- `wrangler.toml` documents the Worker settings.

## Notes

- Do not put the Stripe secret key in frontend JavaScript.
- If the Worker is not deployed yet, the Stripe button falls back to the existing Stripe Payment Link.
- The Worker validates amounts from `$1` to `$10,000`.
