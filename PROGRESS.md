# PROGRESS.md — parkstatus.today

Dated work log. Newest entry first. The builder appends here every turn, in the same
format (tables/bullets, not prose). Ground truth is `git log` — if this file disagrees
with git, git wins and the discrepancy gets flagged.

## Summary

| Area | State (2026-09-07) |
| --- | --- |
| Static site (index.html) | Notifications unified into one Alerts panel; typography on half-mast token system |
| Park/road/dir/beach CSS (`PARK_CSS`) | On the same half-mast type token system as `index.html` — `:root` tokens + `@media(max-width:580px)` tracking loosen; desktop unchanged (Item 3) |
| Mobile map | **DONE + deployed** (`082db6f4`) — `leaflet-gesture-handling` 1.2.2 (vendored) on `pointer:coarse`; `.mapframe` `52vh` on phones. |
| Park pages (build-parks.js) | Entrance fee + reservation block + 4-entry FAQ + `isAccessibleForFree` live; reservation block links to `/reservations/` |
| Reservations (`/reservations/`) | Generated hub from `reservations.json` — 6-park table + "dropped for 2026" block + timed-entry explainer + FAQ JSON-LD (Item 7). Not in `siteNav()`. |
| Road pages (`/road/`) | **21 published** — Item 1's 8 + Old Fall River & Glacier Point (backfilled) + 11 from Item 4 (Newfound Gap, Kuwohi/Clingmans Dome, Road to Paradise, Chinook Pass SR-410, Teton Park Rd, Moose-Wilson Rd, SR-67 North Rim, Generals Hwy, Kings Canyon Scenic Byway, Denali Park Rd, Park Loop Rd). 2 staged (`datesReviewed:false`): stevens-canyon-road, mineral-king-road. Regenerates + deploys on the next daily refresh. |
| CI / deploy | `refresh-park-data.yml` dispatches `deploy.yml` AND now `git add`s `public_html/road` + `public_html/llms.txt` |
| Worker | `/push/unsubscribe`; `detectShutdown()` + blob `shutdown` + `/shutdown-override` (Item 6, `b0388615`); **Item 5**: `roadStatus()` canonical here, hourly → blob `roads` array + Tier-B road-change push (web + native), KV `road:notifylog` 24h cooldown |
| iOS app | Capacitor wrapper; CI ship on `ios-v*` tag working. No pending app task. |
| Prompt-engineer / builder workflow | Set up this session (`.claude/` + coordination files) |

## Log

### 2026-09-10 — Item 8 DONE: four seasonal guide articles

- **New flat guides** in `public_html/guides/` (hand-authored, no generator changes):
  - `national-park-free-days-2026.html` — the 8 NPS 2026 fee-free dates (Feb 16, May 25,
    June 14, July 3–5, Aug 25, Sept 17, Oct 27, Nov 11), the "entrance fee only" fine
    print → `/reservations/`, the new U.S.-residents-only rule, and the days dropped from
    prior years. June 14 rendered as "Flag Day" with a muted note that NPS labels it
    "Flag Day/President Trump's birthday". Source: nps.gov/planyourvisit/passes.htm
    (updated Jan 5, 2026).
  - `national-parks-open-holidays.html` — grounds stay open, visitor centers close
    Thanksgiving / Dec 25 / Jan 1; the 4 fee-free holidays; shutdown override → shutdown guide.
  - `most-visited-national-parks.html` — top-15 `<ol>` by 2025 recreation visits, each
    linked to `/park/<slug>/`; system total 323,014,305 (−2.7% vs 2024). Ranks 1–10 +
    total from the NPS 2025 visitation release; 11–15 from publiclandsdata.com (labeled).
  - `national-parks-open-in-winter.html` — best-in-winter parks (Death Valley, Big Bend,
    Everglades, Joshua Tree, …) vs. parks where snow closes the highlights (Yellowstone,
    Glacier/GTSR, Rocky Mtn/Trail Ridge, Yosemite/Tioga) → `/road/` + road pages.
  - All four: existing guide template (header/nav/strip/footer/scripts, `guides.css`, no
    web fonts) + `<script type="application/ld+json">` `@graph` BreadcrumbList + FAQPage
    (4 dated Qs) + a visible FAQ section + 6–15 internal links each.
- **Wiring**: `public_html/guides/index.html` 4 → 8 gcards; `build-parks.js` `sitemap()`
  +4 `staticUrls` (fee-free `0.7`/weekly, most-visited `0.7`, winter/holidays `0.6`),
  count `+12` → `+16`; `build-parks.js` `llmsTxt()` +4 `## Guides` bullets. Also
  hand-patched the deployed `public_html/sitemap.xml` (1341 urls) and `public_html/llms.txt`
  so the guide URLs are live on this push, not just after the next cron.
- No workflow change: `refresh-park-data.yml` `git add` covers `public_html/park` etc. but
  not `public_html/guides` — correct, guides are hand-authored; they deploy on push via
  `deploy.yml`. The cron regenerates `sitemap.xml` / `llms.txt` daily and now carries the
  4 URLs from `build-parks.js`.
- **Verified**: `node --check build-parks.js`; all 4 guides' JSON-LD parses (BreadcrumbList +
  FAQPage, 4 Qs), canonical/og:url correct, tags balanced; **every internal
  `/park/<slug>/`, `/road/<slug>/` and sibling-guide link resolves** against
  `parks.json` / published `roads.json` / the guides dir; `sitemap.xml` well-formed;
  rendered in-browser at 1200px + 375px, no horizontal overflow, matches existing guides.
- **Scope**: `build-parks.js` (guide lists only) + `public_html/guides/**` +
  `public_html/sitemap.xml` + `public_html/llms.txt`. `parks-enriched.json` / `parks.json`
  untouched.
- **Backlog candidate**: convert `most-visited` + `free-days` to generated pages later
  (small `visitation.json` / `fee-free.json` → auto-refresh, no year baked in the URL).

### 2026-09-09 — Item 7 DONE: `/reservations/` timed-entry index page

- **build-parks.js `reservationsIndexHtml(reservations, entities, updatedISO, tally)`** →
  `public_html/reservations/index.html`. Generated wholly from `reservations.json` (the
  `RESERVATIONS` map) — no new curated file. Structure mirrors `roadIndexHtml` /
  `beachIndexHtml` (GA + INDEXERNOW head, `siteNav()` header, baked `stripHtml` strip,
  `.related` cards, shutdown-banner refetch).
  - `<table class="resv">` — Park (→ `/park/<slug>/`, slug resolved from `entities`) ·
    What's covered (`.name`) · When (`.season`) · Book (`.url`), 6 rows sorted by park name.
  - `.resv-dropped` block: Arches / Glacier / Mount Rainier / Yosemite named + linked to
    their park pages. **Hardcoded `DROPPED_IDS` array with a "RE-CHECK EVERY SPRING" comment.**
  - "How timed entry works" (3 paras) + "Do I still pay the entrance fee?" — drawn from the
    common patterns in the `reservations.json` summaries; no new facts.
  - JSON-LD `@graph`: `BreadcrumbList` + `FAQPage` (2 Qs — "Which national parks require a
    reservation in 2026?" lists all 6 + names the 4 dropped; "Do I still pay the entrance
    fee…" → yes) + `ItemList` of the 6.
- **Wiring**: `main()` writes `public_html/reservations/index.html`; `sitemap()` gains
  `{loc:/reservations/, monthly, 0.7}` (+ console count `+11`→`+12`); `llmsTxt()` gains a
  `## Reservations & timed entry` section.
- **Cross-link**: the per-park `en.reservation` `<article>` in `pageHtml` now ends with
  `<a href="/reservations/">All national park reservations & timed entry →</a>` (6 parks).
- **PARK_CSS**: +8 lines — `.resv-wrap` (overflow-x scroll), `.resv` table, `.resv-dropped`
  card. `park.css` output regenerated; additive only.
- **NOT** added to `siteNav()` (constraint) — reached from park pages + the sitemap/llms.
- **Verified** (`node` harness, 26/26): 6 table rows each linking `/park/<slug>/` + a Book
  link to the `reservations.json` url; all 4 dropped parks named + linked; single `ld+json`
  block parses, graph = Breadcrumb/FAQPage/ItemList, FAQ names the dropped parks,
  ItemList count == 6; canonical + og:url = `/reservations/`; no `/reservations/` in
  `siteNav()`; `sitemap()` + `llmsTxt()` include it. Browser render checked at 1280px.
  `public_html/reservations/index.html` regenerated against the LIVE blob tally + `updated`.
- **Byte-identical**: `parks-enriched.json` / `parks.json` untouched. `git diff` = build-parks.js
  + public_html/park/park.css + new public_html/reservations/index.html.
- **PROPOSED (not applied)** `refresh-park-data.yml` `git add` line — add `public_html/reservations`:
  `git add public_html/park public_html/road public_html/roads.json public_html/reservations public_html/shutdown public_html/parks-enriched.json public_html/parks.json public_html/sitemap.xml public_html/llms.txt`
- **Deploy**: ships via `deploy.yml` on push (`public_html/**`); daily cron keeps it fresh
  once the `git add` line lands.

### 2026-09-08 — Item 5 DONE: "watch a road for reopening" (Worker road status + web & native push)

Data-flow change: road status moves from the daily build to the Worker's hourly job.

- **worker.js**
  - Ported `roadStatus()` from build-parks.js — now the CANONICAL copy (inline `_roadClip`
    replaces `clip`; drops the `NPS_KEY` gate since the Worker always has alerts in hand).
  - `rebuild()`: fetches `SITE/roads.json` (same delivery as `forests.json`), computes a
    `roads` array `[{slug,name,status,cls,tier,reason,date,since,parentIds}]`, adds it to
    the KV blob next to `shutdown` (additive — no existing field touched).
  - Road-change diff → appends `{id:"road:<slug>", isRoad:true, roadStatus, to, url, …}` to
    the existing `changes` array **only when the NEW state is Tier B** (a real NPS alert).
    A Tier-C `inSeason()` calendar flip never notifies. 24h per-slug cooldown via KV
    `road:notifylog` (at most one road notification/slug/day even if `roadStatus()`
    oscillates on a borderline alert).
  - `notifyChanges()`: `appUrl()` returns `/road/<slug>/` for `isRoad`; title copy
    "<name> is open for the season." / "is now closed." / ": partial closure in effect.".
    Web-push, APNs and email loops already gate on `changeMatchesSub` / `sc.parks.includes`
    — unchanged, they match `road:` ids as-is.
  - `pingIndexNow()`: pings `/road/<slug>/` + `/road/` on a road change.
  - `changeMatchesSub` / `sanitizeScope` / `sanitizeNativeScope`: **comments only** —
    `road:<slug>` (≤26 chars) already passes the `parks[]` cap and the exact-id match.
- **build-parks.js**
  - `main()` reads `data.roads` (blob) for each `/road/` verdict; `roadStatus()` +
    `npsAlerts()` now run ONLY as a fallback for slugs the blob doesn't carry (first
    deploy race / Worker error). Alerts fetched only when there's something to fall back for.
  - Writes `public_html/roads.json` (verbatim `JSON.stringify(ROADS)`) so the Worker can
    read it hourly.
  - `roadPageHtml`: new `#road-follow` button in `.acts` ("Notify me when it reopens" /
    "if it closes") + a standalone `<script>` that toggles `road:<slug>` in
    `localStorage.ps_follows` and bounces to `/#alerts` on web; in-app, `app-native.js`'s
    existing `ps_follows` hook re-subscribes.
- **public_html/index.html**: Alerts-panel chips prefix road follows with 🛣; empty-state
  copy mentions the road-page "Notify me" button. `alScope()` already sends `follows.map(f=>f.id)`
  (road ids included) to `/push/subscribe` — no logic change.
- **app-native.js**: unchanged — `currentScope()` already forwards `road:` ids; the tap
  handler already routes `data.url`'s pathname to `/road/<slug>/`.
- **Not done:** no `/roads` GET route (blob is enough); "Roads in this park" block on park
  pages not wired to live cls (deferred, low value).
- **Tests** (`node` harness, 26/26): Tier-B open/closed fixtures → correct `roadStatus`;
  Tier-C→Tier-B fires; Tier-C→Tier-C calendar flip does NOT; 24h cooldown (1st fires, 2
  more within 24h suppressed, next-day fires); `changeMatchesSub` matches a road follower,
  ignores a non-follower, still matches existing park subs and doesn't spam them with road
  changes; title/`appUrl` copy; `roadPageHtml` renders the button, honors the blob verdict,
  ld+json still valid. True APNs/web-push sends need live secrets+endpoints — not run
  locally (payload objects asserted instead).
- **Byte-identical:** `parks-enriched.json` / `parks.json` untouched. `git diff` scope:
  worker.js, build-parks.js, public_html/index.html, + new public_html/roads.json.
- **PROPOSED (not applied)** `refresh-park-data.yml` `git add` line — add
  `public_html/roads.json`:
  `git add public_html/park public_html/road public_html/roads.json public_html/shutdown public_html/parks-enriched.json public_html/parks.json public_html/sitemap.xml public_html/llms.txt`
- **Deploy:** worker.js ships on push (Cloudflare Git). Until `public_html/roads.json`
  deploys, the Worker's fetch 404s → `blob.roads` `[]` → generator uses local fallback →
  self-heals next cron. build-parks.js + index.html + roads.json ship via the daily cron
  (needs the proposed git-add line) or a `deploy.yml` push.

### 2026-09-08 — Item 4 DONE: +13 road rows (11 published, 2 staged); BRP stays Tier C

- **roads.json**: added 13 rows (schema unchanged). Published (`datesReviewed:true`, 11):
  `newfound-gap-road` (US-441, year-round), `clingmans-dome-road` (filed "Kuwohi Road
  (Clingmans Dome Road)"; fixed Dec 1–Mar 31 closure), `paradise-road` (Longmire–Paradise,
  year-round, nightly gate), `chinook-pass-sr-410` (WSDOT history 2019–2026; 2024 washout
  noted), `teton-park-road` (fixed Nov 1–Apr 30), `moose-wilson-road`, `az-67-north-rim-road`
  (SR-67; ADOT gate dates + 2025 Dragon Bravo Fire aftermath in accessNote),
  `generals-highway` (CA-198, year-round), `kings-canyon-scenic-byway` (CA-180; 2023
  flood/2024-late anomalies in history rows), `denali-park-road` (Pretty Rocks bridge
  completed Sep 2026 — phased 2026 hiker / 2027 bus in accessNote), `park-loop-road`
  (fixed Dec 1–Apr 15; 2023–25 all Apr 15). Staged (`datesReviewed:false`, 2):
  `stevens-canyon-road` (only 1 clean sourced year after a 2-yr rehab),
  `mineral-king-road` (2025–2027 rehab disrupts the normal Wed-before-Memorial-Day →
  last-Wed-of-October schedule).
- **Old Fall River Rd** + **Glacier Point Rd**: were staged from Item 1 — backfilled with
  sourced opening dates (OFR: NPS RMNP releases 2019/21/23/24/25; GPR: NPS Yosemite's
  official 1970–2025 road-opening dataset) and flipped to `datesReviewed:true`.
- Every `history` row carries a source; every stated date is sourced (no per-year date
  invented — AZ-67 keeps `history:[]` with sourced ADOT gate dates in the accessNote
  rather than guessing openings).
- **Blue Ridge Parkway ArcGIS feed**: tested. No NPS-owned keyless Feature Service
  (`mapservices.nps.gov` has no roads layer; `arcgis.com` only third-party layers;
  `nps.gov/blri/planyourvisit/roadclosures.htm` has no embed). BRP stays **Tier C**.
  Deferred as 4b: the `roadclosures.htm` page renders a server-side per-milepost status
  table with a timestamp — a Worker-side scrape candidate in the `detectShutdown()` mold,
  which is a generator/Worker change out of scope here.
- No generator logic change. `parks-enriched.json` / `parks.json` untouched (only
  `roads.json` in `git diff`). Regeneration of `public_html/road/**` happens in the daily
  `refresh-park-data.yml` run (real NPS key; its `git add` already covers `public_html/road`).
- Verified via a local module harness (require build-parks.js with `main()` stubbed):
  all 21 published road pages render, every `ld+json` block parses, all 21 group under
  their parent park in `/road/` index (+ "Other scenic roads" for Beartooth), the
  Yosemite park page's "Roads in this park" block lists Glacier Point + Tioga.

### 2026-09-08 — Item 3 DONE: `PARK_CSS` typography reconciliation

- **build-parks.js `PARK_CSS`**: added a `:root` type-token block using the SAME names as
  `index.html`'s `<style>` (commit `f286fcd1`), calibrated so every token's max/fixed
  value equals the park pages' *current* ~1280px px — desktop rendering is unchanged.
  Roles: `--type-hero` `clamp(30px,5.5vw,50px)` (`h1`), `--type-verdict`
  `clamp(19px,3.2vw,26px)` (`.verdict .line`), `--type-section` 24 (`article h2`,
  `.visitor h2`), `--type-subsection` 22 (`.related h2`), `--type-road-group` 19,
  `--type-card-title` 17 (`.gcard .t`), `--type-note-title` 16 (`.shutdown-note h2`),
  `--type-wordmark` 22; matching `--tracking-*` / `--leading-*`.
- New `@media(max-width:580px){:root{…}}` (park.css had no type media query) loosens 7
  tracking tokens for phone-size headings — mirrors the homepage technique. No size /
  leading / weight change there; existing 620/680px layout queries untouched.
- Display weight stays `900` + the `"Arial Narrow"` stack (denser park-page look, `h1`
  runs to 50px) — NOT unified to the homepage's `950`. `--font-display` untouched.
- 10 selectors re-pointed to tokens; body copy (`article p` 16, `.reason`/`.vi` 15,
  tables 14, `.plist` 14) deliberately kept literal + commented, same call as the homepage.
- Verified: base values byte-equal to prior; `getComputedStyle` at 1280px on
  `/park/…/` matches pre-change exactly (h1 50/−2px/.96, verdict 26/−.8px/1.15,
  h2 24/−1.2px, related 22/−1px, gcard 17/−.6px/1.1, wordmark 22/−1.4px). At ≤580px
  tracking loosens as designed, no horizontal overflow on park + road-index pages.
- `PARK_CSS` has no `${}` interpolation, so `park/park.css` regenerated by extracting
  the literal (byte-identical to what `build-parks.js` writes); `git diff --stat` shows
  only `build-parks.js` + `public_html/park/park.css`. parks-enriched.json / parks.json
  untouched.

### 2026-09-08 — Item 6 DONE + deployed: `/shutdown/` live hub

- Pushed `b0388615` + `5124a997` (the `git add public_html/shutdown` CI fix). Worker
  auto-deploys via Cloudflare Git; retitled guide FTP-syncs now; `/shutdown/` page +
  NPS `#shutdown-note` sections generate on the next daily cron.
- Post-deploy: verify `shutdown.active` is `false` at the Worker root. `/shutdown-override`
  route (REBUILD_TOKEN) pins it if the NPS-page scrape ever misfires.

- **worker.js**: `detectShutdown(env, prevRaw)` scrapes the NPS "National Park System
  Operating Status" page hourly in `rebuild()`. Signals: `SD_NO_LAPSE` = "there are no
  systemwide alerts or closures" (confident clear), `SD_LAPSE` = lapse-in-appropriations
  / government-shutdown / contingency-plan phrases (confident active). Hysteresis: flips
  ON immediately; only flips OFF on the explicit NO_LAPSE sentence; ambiguous page holds
  the previous state. Fetch fail / `<500` bytes → carry previous `shutdown`, `stale:true`,
  no flip. Manual override wins: KV `shutdown:override` with an ISO `until`.
  New blob key `shutdown: { active, since, source, summary, checkedAt, stale }` — additive,
  no existing field touched.
- **worker.js**: `GET /shutdown-override?token=REBUILD_TOKEN&active=…&note=…&until=…&since=…`
  (and `&clear=1`), modeled on `/rebuild`; writes/deletes the KV key then rebuilds.
- **build-parks.js**: `shutdownPageHtml(sd, updatedISO, tally)` → `public_html/shutdown/index.html`,
  wired in `main()` from `data.shutdown`. Two baked states (`#sd-inactive` / `#sd-active`
  toggled by `hidden`); verdict block reuses `.verdict`/`.pill`; JSON-LD BreadcrumbList +
  FAQPage (3 Qs, state-dependent answers); refetch `<script>` swaps state + timestamp from
  the blob; no-JS fallback = baked. `/shutdown/` deliberately NOT in `siteNav()`.
- **build-parks.js**: `pageHtml` gains `sd` param + an NPS-only `#shutdown-note` `<section>`
  (hidden unless `sd.active`); the existing blob-refetch script toggles it. State parks /
  forests / beaches get nothing.
- **build-parks.js**: `sitemap()` adds `/shutdown/` (daily, pri 0.9); `llmsTxt()` gets a
  `## Government shutdown` section (live page + explainer).
- **build-parks.js**: `PARK_CSS` += `.shutdown-note` rules (additive).
- **guide** `national-parks-government-shutdown.html`: retitled to the *explainer* angle
  ("What a government shutdown means for the national parks"), H1 + og:title + description
  updated, top banner links to `/shutdown/`. Anti-cannibalization: `/shutdown/` owns "is
  it open right now", the guide owns "what happens / why / history".
- **Tested** (worker: extracted `detectShutdown` against padded no-lapse / lapse / fetch-fail
  / ambiguous / explicit-clear / override / override-expired fixtures — all pass, `since`
  parsed, summary is the meaningful sentence). Generator: `shutdownPageHtml` renders both
  states, JSON-LD valid, `/shutdown/` not in nav, guide linked; NPS park has `#shutdown-note`
  (hidden when inactive), TX state park does not; sitemap + llms carry `/shutdown/`.
  Visual check of both states in a browser (park.css styling, correct pill/verdict/copy).
- **NOT run**: full `node build-parks.js` (no `NPS_API_KEY`; keyless build would wipe NPS
  enrichment). `parks-enriched.json` / `parks.json` untouched by the diff.
- **PROPOSED, not applied**: `refresh-park-data.yml` `git add` needs `public_html/shutdown`
  (same gap as roads had) or `/shutdown/` won't deploy. The guide retitle deploys on its
  own (FTP on `public_html/**`), so its `/shutdown/` link will 404 until that lands + a
  refresh runs.
- Worker deploys on push (Cloudflare Git). Not pushed — Item 6 ships on your say.
- Changed: `worker.js`, `build-parks.js`, `public_html/guides/national-parks-government-shutdown.html`,
  coordination files.

### 2026-09-08 — Item 2 DONE: mobile map scroll-trap + height — committed, not pushed

- `.mapframe` gets `height:clamp(300px,52vh,460px)` on `@media(max-width:820px)` —
  placed AFTER the base rule (a copy inside the earlier `.board` media block lost on
  source-order specificity; caught in testing).
- `leaflet-gesture-handling@1.2.2` **vendored** to `public_html/vendor/` (18 KB JS +
  1 KB CSS) — it is NOT on cdnjs (404 / "Library not found"); jsDelivr was the source.
  Loaded after `leaflet.min.js`, before markercluster + the inline script.
- Map init: `gestureHandling: coarse` where `coarse = matchMedia("(pointer:coarse)").matches`.
  `gestureHandlingOptions.text.touch = "Use two fingers to move the map"`.
- Desktop (fine pointer) = **unchanged**: `gestureHandling:false` → handler inert;
  `#zoomhint` + `map.on("click")` scroll-zoom-enable + 6 s auto-kill kept (wrapped in
  the `else`). On coarse, `#zoomhint` is removed (plugin shows its own overlay) and the
  click-to-enable is skipped.
- Tested at 375×812 (Chrome mobile emulation): map height 422 px = 52 % of viewport
  (was 601 px / 74 %); one-finger drag on the map shows the two-finger warning and does
  NOT pan (page scroll freed); marker tap opens the detail drawer; markers/clusters
  render (49). At 1280×860: map back to 74 vh; wheel over the map does not trigger the
  plugin; click-to-enable-zoom + hint-dismiss still work.
- Changed: `public_html/index.html`, `public_html/vendor/leaflet-gesture-handling.min.{js,css}` (new),
  coordination files. **Not pushed** — Item 2 process step: commit only unless told to deploy.

### 2026-09-07 — Item 1 DONE: road-status first cut finished

- Researched historical opening dates for the 6 staged seasonal roads (NPS news
  releases + Mono Basin Research Center + local press). Every `history` row carries a
  `source`.
- User approved publishing 4: **Going-to-the-Sun Rd** (8 yrs, 2018–25),
  **Trail Ridge Rd** (2002 record + 2021–25), **Tioga Rd** (8 yrs, 2016–23),
  **Beartooth Hwy** (2021–26). `datesReviewed` flipped to `true`.
- Held: **Glacier Point Rd** (only 2016 + 2022 closure + 2026 sourceable) and
  **Old Fall River Rd** (no ≥3 year-tagged dates) — stay `datesReviewed:false`,
  `history:[]`. Backfill = a follow-up.
- `.github/workflows/refresh-park-data.yml` `git add` line now includes
  `public_html/road` and `public_html/llms.txt` (was the pre-existing deploy gap).
- Verified via a scratch harness (`build-parks.js` road path, no `NPS_API_KEY`): all 8
  published roads render; JSON-LD valid (BreadcrumbList + FAQPage, + TouristAttraction
  for `isScenicDrive` rows with an NPS parent); GTTS uses the "full … over Logan Pass"
  FAQ; `/road/` index groups by park + "Other scenic roads" (Beartooth). Beartooth
  (empty `parentIds`) renders "Not inside a national park unit", no crash.
- Did NOT run a full `node build-parks.js` (no `NPS_API_KEY` — a keyless build would
  wipe NPS enrichment and violate the byte-identical constraint). `public_html/road/`
  pages generate + deploy on the next daily refresh cron.
- `parks-enriched.json` / `parks.json` / `public_html/park/**` untouched.
- Changed: `roads.json`, `.github/workflows/refresh-park-data.yml`, coordination files.

### 2026-09-07 — Prompt-engineer + builder workflow

- Added `.claude/commands/prompt-engineer.md` (slash command), `.claude/agents/prompt-engineer.md`
  (subagent), `.claude/commands/builder.md` (slash command), and the coordination files
  `PROJECT-CONTEXT.md` / `PROGRESS.md` / `BUILDER-PROMPTS.md`. Merged from the generic
  `PROMPTENGINEERTEMPLATE.md` / `BUILDERRESUMETEMPLATE.md` kept one level up.
- Adds: file-based state (this workflow), a `rehydrate` trigger on both sides, batched
  interview, and a builder that advances one queued item per "OK, please complete next
  step".
- Not yet committed at time of writing.

### 2026-09-07 — Road-status pages, first cut (partial) — commit `2897960b`

| Item | State |
| --- | --- |
| `roads.json` (10 rows) | shipped |
| `roadPageHtml` / `roadIndexHtml`, `roadStatus()`, `npsAlerts()` Tier B, `siteNav()` helper, "Roads in this park" block | shipped in build-parks.js |
| 4 year-round roads (Bear Lake Rd, Blue Ridge Parkway, Skyline Drive, Hurricane Ridge Rd) | `datesReviewed:true` — publish |
| 6 seasonal roads (Going-to-the-Sun, Trail Ridge, Old Fall River, Tioga, Glacier Point, Beartooth) | `datesReviewed:false` — staged, need historical-dates verification then flag flip |
| `refresh-park-data.yml` `git add` for `public_html/road` + `public_html/llms.txt` | **PROPOSED, not applied** — road pages won't deploy until this lands |
| Remaining ~15–20 roads, BRP ArcGIS live feed, app "watch a road" + Worker `/roads` | not started (follow-up) |

### 2026-09-07 — Park-page enrichment — commits `0b9a65e7`, `0abc6c50`, refresh `bb456ef0`

- `npsFee()` surfaces the already-fetched NPS `entranceFees`; fee row in `visitorBlock`,
  "How much does it cost to enter…" FAQ, `isAccessibleForFree` in JSON-LD.
- `reservations.json` (6 parks) verified against nps.gov + recreation.gov for 2026;
  reservation block + "Does … require a reservation?" FAQ on affected pages, a "no
  reservation required" line elsewhere.
- Deferred: holiday-hours exceptions (stale NPS dates), winter heuristic (needs curated
  data), `/state/` + `/road/` cross-links (built later).
- Verified live on parkstatus.today (RMNP, Muir Woods, Yellowstone, a sparse state park).

### 2026-09-07 — CI deploy fix — commit `57ca1169`

- `refresh-park-data.yml` was committing regenerated pages that never deployed — a
  `GITHUB_TOKEN` push doesn't trigger `on: push` workflows. It now runs
  `gh workflow run deploy.yml --ref main` after each commit. The manual deploy that day
  also flushed two stuck prior daily-refresh commits.

### 2026-09-07 — Typography → half-mast token system — commit `f286fcd1`

- `index.html` adopted half-mast's token *system* (fluid `clamp()`, tight tracking, real
  580px breakpoint) calibrated so desktop rendering is unchanged; body stays ~14.5/16px
  on purpose. half-mast uses no web fonts; our stacks already matched.
- **Follow-up still open:** `park/park.css` typography reconciliation to the same tokens.

### 2026-09-07 — Notifications unified — commit `a9a49f80`

- Replaced the two overlapping notification flows (map-card "Follow" + bottom "Watch")
  with one "Alerts" panel used everywhere (web + in-app). localStorage keys:
  `ps_follows`, `ps_alert_prefs`, `ps_push_state`. Added Worker `/push/unsubscribe`.
  Permission priming, distinct error states, subscription status + off switch.
