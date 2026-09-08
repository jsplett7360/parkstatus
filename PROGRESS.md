# PROGRESS.md — parkstatus.today

Dated work log. Newest entry first. The builder appends here every turn, in the same
format (tables/bullets, not prose). Ground truth is `git log` — if this file disagrees
with git, git wins and the discrepancy gets flagged.

## Summary

| Area | State (2026-09-07) |
| --- | --- |
| Static site (index.html) | Notifications unified into one Alerts panel; typography on half-mast token system |
| Mobile map | **DONE + deployed** (`082db6f4`) — `leaflet-gesture-handling` 1.2.2 (vendored) on `pointer:coarse`; `.mapframe` `52vh` on phones. |
| Park pages (build-parks.js) | Entrance fee + reservation block + 4-entry FAQ + `isAccessibleForFree` live |
| Road pages (`/road/`) | **First cut complete** — 8 published: 4 year-round + Going-to-the-Sun, Trail Ridge, Tioga, Beartooth. Glacier Point + Old Fall River still staged (`datesReviewed:false`). `public_html/road/` generates + deploys on the next daily refresh. |
| CI / deploy | `refresh-park-data.yml` dispatches `deploy.yml` AND now `git add`s `public_html/road` + `public_html/llms.txt` |
| Worker | `/push/unsubscribe` added during the notifications work; no other pending change |
| iOS app | Capacitor wrapper; CI ship on `ios-v*` tag working. No pending app task. |
| Prompt-engineer / builder workflow | Set up this session (`.claude/` + coordination files) |

## Log

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
