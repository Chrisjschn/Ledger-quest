# Bangkok Hotel Ledger

A single-page web app for one trip: **Bangkok, Sat 1 May → Thu 6 May 2027, two adults.**
It lists every hotel in American Express **Fine Hotels + Resorts (FHR)** and **The Hotel Collection (THC)**
on a map with photos, keeps a running price log per hotel, and plans how to spread the five nights
across four $300 Platinum hotel credits. The dates are baked in, so you never re-enter them.

There is no build step. Open `index.html` from a static server (GitHub Pages works), or use the
published claude.ai artifact, which adds a shared store so prices and the plan sync across devices.

## What it does

- **Map + photos.** 28 hotels (16 FHR, 12 THC, as listed on americanexpress.com in Sept 2026) on a
  vector map of central Bangkok built from OpenStreetMap: the river, main roads, BTS/MRT/ARL lines
  and stations, parks and landmarks. Unpriced hotels are dots; once you log a price the pin shows it.
- **One-click Amex links with your dates.** Amex Travel's dated links need Amex's numeric hotel id,
  which only appears after you press *Check availability* once on a property page. Paste that page's
  address into the hotel's drawer (or use the bookmarklet on the Prices tab) and the app rebuilds
  the link with 1–6 May 2027 from then on. Booking.com links always carry the dates, as a reference
  price. FHR/THC rates are normally the hotel's flexible rate plus the perks.
- **Price log.** Log a nightly rate per hotel (USD or THB, per night or total), see the change since
  the last check, a history chart, and a comparison chart across hotels. Or paste the whole Amex
  results page and let the parser match prices to hotels; you review before saving.
- **Credit planner.** Split the five nights into bookings, assign each booking a hotel and a credit,
  and see cost, credit applied and what you actually pay. *Suggest a split* finds the pattern that
  captures the most credit for a given nightly rate (for most rates under $300/night that is
  2 + 1 + 1 + 1). It knows the rules: prepaid "Pay Now" bookings only; the half-year is decided by
  the **charge date**, not the stay (so a May 2027 trip can use both the Jul–Dec 2026 and the
  Jan–Jun 2027 credits); Hotel Collection bookings need 2+ nights; back-to-back bookings at one hotel
  count as one stay for the on-property perks.
- **Shortlist, notes, hide, add.** Star hotels, keep notes, hide ones you have ruled out, add a hotel
  that joins a program later (Settings).

## Files

| Path | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app |
| `data/hotels.json` | the hotel list (edit this, then run `node scripts/build_data.mjs`) |
| `data/hotels.js`, `data/photos.js` | generated wrappers so the page needs no `fetch()` |
| `data/basemap.js` | generated OpenStreetMap base map (© OpenStreetMap contributors, ODbL) |
| `photos/` | freely licensed hotel photos + `credits.json` (attribution shown in the app) |
| `vendor/` | Leaflet 1.9.4 |
| `scripts/` | build scripts, run by the GitHub Actions workflow |
| `../.github/workflows/bkk-assets.yml` | fetches the base map, photo candidates and geo checks on a runner |

## Refreshing generated data

Run the **Bangkok hotels · generated assets** workflow from the Actions tab (or push a change under
`bangkok-hotels/scripts/`). It rebuilds `data/basemap.js`, downloads up to five candidate photos per
hotel into `photos/candidates/` with licensing in `photos/candidates.json`, and writes
`data/geo_check.json` comparing each pin with Wikidata, Wikipedia and OpenStreetMap. Pick the photo
you want per hotel, copy it to `photos/<id>.jpg`, record it in `photos/credits.json`, and run
`node scripts/build_data.mjs`.

## Publishing

- **GitHub Pages:** serve the repository (or this folder) from the branch; nothing else is needed.
- **claude.ai artifact:** `node scripts/build_artifact.mjs` writes `dist/artifact.html`, the same page
  as a body fragment. Publish it together with `styles.css`, `app.js`, `vendor/*`, `data/*.js` and
  `photos/*.jpg` as supporting files, with the `db`, `assets` and `downloads` capabilities.

## Data notes

- Program membership was read from each hotel's americanexpress.com property page title
  ("Fine Hotels + Resorts" vs "The Hotel Collection") in September 2026 and matches nextcard.com's
  independent count of 28 Bangkok hotels. Hotels that used to be in the programmes but no longer
  have a page (Shangri-La, Okura, Sukhothai, Banyan Tree, Athenee, lebua, …) are left out.
- Coordinates marked `checked` agree with OpenStreetMap and/or Wikidata within about 50 m; the rest are
  approximate (within ~150 m).
- Prices are never fetched automatically: Amex Travel has no public API, and scraping a logged-in
  session is fragile and against its terms. Logging takes one click per hotel, or one paste for all.
