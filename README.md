# Specimen Finder Pro

Hosted **$4/month** upgrade for [Specimen Finder](https://theoryofshadows.github.io/specimen-finder/) — saved GBIF specimen searches, private notes, and CSV/JSON export.

The free open tool stays free and unpaywalled:

- App: https://theoryofshadows.github.io/specimen-finder/
- Source: https://github.com/TheoryofShadows/specimen-finder

This repo is the **hosted workflow** only. Paid features are accounts, saved searches, server-side GBIF pulls, private annotations, batch species lists, and exports of *your* last fetch.

## What this is not

- Not a paywall on the GitHub Pages app.
- Not photo identification. Pl@ntNet’s free/research key is **non-commercial** — Pro does not call or market Pl@ntNet.
- Not a marketplace or dump of iNaturalist or herbarium images. We do not sell or redistribute publisher content.
- Context links go to **GBIF**, **Wikipedia**, **Wikidata**, and **POWO (Kew)** with attribution.

## Features (MVP)

- Landing page (free tool link + honest Pro benefits)
- Email + password auth (JWT cookie, bcrypt)
- SQLite via `better-sqlite3` with volume-friendly `DB_PATH` (default `/data/specimen-finder-pro.db`)
- Free: account + **3 saved searches**
- Pro: unlimited searches, batch species list, CSV + JSON export
- Server-side GBIF species match + preserved-specimen pull (User-Agent, ~1 req/s throttle, attribution)
- Private notes per search and per GBIF record
- Stripe Checkout for Pro ($4/mo) + webhook to unlock / revoke Pro
- `GET /health` → `{"ok":true,"service":"specimen-finder-pro"}`

## Requirements

- Node.js **18+**
- A Stripe account (for Pro billing)
- Railway (or any host with a persistent volume for SQLite)

## Quick start (local)

```bash
cp .env.example .env
# set JWT_SECRET at minimum; Stripe optional for local
npm install
npm start
# open http://localhost:3000
```

```bash
npm test
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Default `3000` |
| `APP_URL` | yes (prod) | Public base URL, no trailing slash |
| `JWT_SECRET` | yes | Long random string for signing auth cookies |
| `DB_PATH` | recommended | Absolute SQLite path on a volume (`/data/specimen-finder-pro.db`) |
| `STRIPE_SECRET_KEY` | for Pro | Stripe secret key |
| `STRIPE_PRICE_PRO` | fallback | Used only if lookup key `specimen-finder-pro` ($4/mo) is missing |
| `STRIPE_WEBHOOK_SECRET` | for Pro | Webhook signing secret |
| `NODE_ENV` | no | Set `production` on Railway |

## Create Stripe Product / Price (Dashboard)

If you are not creating prices via API:

1. Open [Stripe Dashboard → Products](https://dashboard.stripe.com/products).
2. **Add product** → name `Specimen Finder Pro`.
3. Pricing: **Recurring**, **$4.00 USD / month**. Lookup key `specimen-finder-pro` (already live). `STRIPE_PRICE_PRO` is only a fallback.
4. Save and copy the **Price ID** (`price_...`) into `STRIPE_PRICE_PRO`.
5. Developers → **Webhooks** → Add endpoint:
   - URL: `https://YOUR_APP_URL/webhooks/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
6. Copy the webhook **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
7. Put your secret key into `STRIPE_SECRET_KEY` (test or live).

Use **test mode** until you are ready to charge real cards. This app never creates charges outside Checkout; do not paste live secrets into logs.

## Deploy on Railway

1. Create a new Railway project named **SpecimenFinderPro** → **Deploy from GitHub** → select `TheoryofShadows/specimen-finder-pro`.
2. Add a **Volume** mounted at `/data`.
3. Set variables (Railway → Variables):

   ```
   APP_URL=https://YOUR_RAILWAY_DOMAIN
   JWT_SECRET=<long random>
   DB_PATH=/data/specimen-finder-pro.db
   NODE_ENV=production
   STRIPE_SECRET_KEY=sk_...
   STRIPE_PRICE_PRO=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

4. Start command is `npm start` (default from `package.json`).
5. Generate a public domain under Settings → Networking.
6. Point the Stripe webhook at `https://YOUR_DOMAIN/webhooks/stripe`.
7. Smoke-check: `GET https://YOUR_DOMAIN/health` → `{"ok":true,"service":"specimen-finder-pro"}`.

Railway compiles `better-sqlite3` during the Nixpacks/Railpack install. One replica is enough for this MVP; SQLite is on the volume.

## GBIF usage

Fetches go to `api.gbif.org` with an identifying User-Agent, a ~1 request/second process throttle, and a cap of 100 preserved-specimen records per pull (`basisOfRecord=PRESERVED_SPECIMEN`). Result pages and exports include GBIF attribution. Respect [GBIF API terms](https://www.gbif.org/terms) and publisher licenses on individual records (often CC0, CC BY, or CC BY-NC). This product is a personal research workflow, not a redistribution of GBIF datasets.

## API / routes (overview)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Landing |
| GET/POST | `/signup`, `/login` | Auth forms |
| POST | `/logout` | Clear cookie |
| GET | `/dashboard` | Saved searches |
| POST | `/searches` | Save a search |
| POST | `/searches/batch` | Pro: batch species list |
| GET | `/searches/:id` | Notes, fetch, results |
| POST | `/searches/:id/fetch` | Server-side GBIF pull |
| GET | `/searches/:id/export.csv` | Pro CSV |
| GET | `/searches/:id/export.json` | Pro JSON |
| POST | `/billing/checkout` | Stripe Checkout |
| POST | `/webhooks/stripe` | Stripe webhooks |
| GET | `/health` | Health check |
| POST | `/api/signup`, `/api/login` | JSON helpers |
| GET/POST | `/api/searches` | JSON search list / create |

## License

ISC
