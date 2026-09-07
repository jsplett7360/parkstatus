# BUILDER-PROMPTS.md — parkstatus.today

The build queue. The prompt-engineer appends items here (status table row + a full prompt
block). The builder (`.claude/commands/builder.md`) runs the next not-done item on "OK,
please complete next step" and marks it done here + logs to `PROGRESS.md`.

Every prompt block is **plan-first**: the builder produces a plan and waits for the
user's approval before implementing. "Complete next step" on a fresh item = deliver the
plan and stop. The next "complete next step" = implement the approved plan.

## Status table

| # | Item | Status | Added | Done / commit |
| --- | --- | --- | --- | --- |
| 1 | Finish road-status first cut (deploy fix + 6 seasonal roads) | READY | 2026-09-07 | — |
| 2 | Mobile map: scroll-trap + height (leaflet-gesture-handling) | READY | 2026-09-07 | — |
| 3 | park.css typography reconciliation to half-mast tokens | BACKLOG | 2026-09-07 | — |
| 4 | Road pages follow-up: remaining ~15–20 roads + BRP ArcGIS feed | BACKLOG | 2026-09-07 | — |
| 5 | App "watch a road for reopening" + Worker `/roads` endpoint | BACKLOG | 2026-09-07 | — |
| 6 | `/shutdown/` live hub | BACKLOG | 2026-09-07 | — |
| 7 | Timed-entry index page + per-park sections | BACKLOG | 2026-09-07 | — |
| 8 | Seasonal guides (fee-free days, holiday hours, most-visited, open-in-winter) | BACKLOG | 2026-09-07 | — |

Backlog items are one-liners until the prompt-engineer promotes one to READY with a full
block below.

---

## Item 1 — Finish the road-status first cut

<role>
You are working on parkstatus.today (see PROJECT-CONTEXT.md). You are a build engineer
finishing a partially-shipped feature.
</role>

<task>
Get the `/road/` seasonal road-status pages fully live: (a) land the `refresh-park-data.yml`
`git add` change so road pages actually deploy, and (b) verify the 6 staged seasonal
roads' seasonal-date data and flip them to `datesReviewed: true` so they publish.
</task>

<why>
Commit `2897960b` shipped the generator, `roads.json` (10 rows), and 4 year-round road
pages — but the 6 highest-value seasonal roads (Going-to-the-Sun, Trail Ridge, Old Fall
River, Tioga, Glacier Point, Beartooth) are staged with `datesReviewed:false`, and the
daily build never commits `public_html/road`, so nothing is on the live site yet. Those
6 are where the search demand is (going-to-the-sun road 22.2k, trail ridge road 14.8k,
"when does X open" at KD 20–26).
</why>

<context>
- `roads.json` (repo root): 10 rows. 4 with `datesReviewed:true` (bear-lake-road,
  blue-ridge-parkway, skyline-drive, hurricane-ridge-road). 6 with `datesReviewed:false`
  (going-to-the-sun-road, trail-ridge-road, old-fall-river-road, tioga-road,
  glacier-point-road, beartooth-highway) — schema complete, `history` / `typicalOpen` /
  `typicalClose` still to confirm.
- `build-parks.js` already has `roadPageHtml` / `roadIndexHtml` / `roadStatus()` /
  `npsAlerts()` and writes `public_html/road/<slug>/` + `public_html/road/index.html`.
  A row publishes only when `datesReviewed:true`; the single publish filter in `main()`
  feeds pages, `/road/` index, sitemap/llms, and the "Roads in this park" reverse index.
- `.github/workflows/refresh-park-data.yml` `git add` line currently:
  `git add public_html/park public_html/parks-enriched.json public_html/parks.json public_html/sitemap.xml`
  — missing `public_html/road` and `public_html/llms.txt`.
- GTTS nuance already encoded in its `accessNote`: only the Logan Pass alpine section is
  seasonal; the "when does it open" answer is about the full transalpine drive.
- Beartooth Highway: `parentIds: []`, `statusUrl` = Montana DOT 511, Tier C only.
</context>

<constraints>
- `refresh-park-data.yml` is normally on the "never touch without asking" list. This item
  is the explicit approval to make ONLY the `git add` line change (add `public_html/road`
  and `public_html/llms.txt`). No other workflow edits.
- No `build-parks.js` logic changes expected — this is data (`roads.json`) + the one
  workflow line. If a generator bug surfaces, stop and flag it as a separate item.
- Seasonal dates: research from nps.gov road-status pages and NPS plow/news releases.
  Every `history` entry needs a source. Do NOT invent a date to fill a row — if a road's
  history can't be sourced, leave it `datesReviewed:false` and say so.
- `parks-enriched.json` / `parks.json` must stay byte-identical.
- Never fabricate dates, sources, or test results.
</constraints>

<reference_material>
- `roads.json`, `build-parks.js` (`roadStatus`, `roadPageHtml`, `main()` publish filter),
  `.github/workflows/refresh-park-data.yml`.
- nps.gov per-park road-status pages (linked as `statusUrl` in each row).
- PROJECT-CONTEXT.md "Build / deploy pipeline" and "Commonly gotten wrong".
</reference_material>

<process>
1. `<thinking>`: restate the goal, list files you'll touch (`roads.json`,
   `refresh-park-data.yml`, and whatever `node build-parks.js` regenerates), note the
   risk that a wrong seasonal date ships to a high-traffic page.
2. Research and fill the 6 staged rows: `typicalOpen`, `typicalClose`, and 3–5 dated
   `history` entries with a source URL each. Present them as a table for the user to
   review — DO NOT flip `datesReviewed` yet.
3. STOP and ask the user to confirm the date table (per PROJECT-CONTEXT: the user
   reviews date rows before approval). Only after approval, set `datesReviewed:true` on
   the rows they approved; leave any they don't.
4. Edit the `refresh-park-data.yml` `git add` line to include `public_html/road` and
   `public_html/llms.txt`.
5. Run `node build-parks.js` locally (needs `NPS_API_KEY`; if unavailable, say so and
   run whatever pure paths you can — do not claim a full build you didn't do). Confirm
   `public_html/road/<slug>/` generates for the now-published roads and the `/road/`
   index lists them under their parent park.
6. Verify `parks-enriched.json` / `parks.json` are byte-identical to pre-change.
7. Commit. Do not push/deploy unless the user says to (this category ships via the daily
   cron once merged; confirm which they want).
8. Update PROGRESS.md and this file's status table.
</process>

<output_format>
Edited files in place (`roads.json`, `refresh-park-data.yml`, regenerated
`public_html/road/**`, `sitemap.xml`, `llms.txt`) + a change-summary table + the
sourced-dates table you got approved.
</output_format>

<self_check>
1. Every constraint above met (list, check each).
2. Every `history` date has a source URL; no row flipped to `datesReviewed:true` without
   user approval.
3. `parks-enriched.json` / `parks.json` byte-identical.
4. `refresh-park-data.yml` change is the `git add` line ONLY.
5. `git status` shows only intended files.
6. PROGRESS.md + BUILDER-PROMPTS.md updated and consistent with `git log`.
</self_check>

---

## Item 2 — Mobile map: scroll-trap + height

<role>
You are working on parkstatus.today (see PROJECT-CONTEXT.md). Front-end engineer,
`public_html/index.html` only.
</role>

<task>
Fix the mobile homepage map: a one-finger drag starting on the map pans the map instead
of scrolling the page, and the map is so tall (`.mapframe` height `clamp(440px,74vh,720px)`)
there's little room to scroll past it.
</task>

<why>
Direct user complaint. The map eats the primary scroll gesture on phones and dominates
the viewport.
</why>

<context>
- `index.html` (~line 145): `.mapframe{...height:clamp(440px,74vh,720px)}`. There is
  already an `@media(max-width:820px)` block (mobile column reorder) — the mobile height
  rule belongs there.
- Map init: `L.map("usmap", { scrollWheelZoom:false, minZoom:3, maxZoom:12,
  zoomControl:true, worldCopyJump:false, center:[39.5,-98.5], zoom:4 })`. `dragging` is
  Leaflet default (on) → the one-finger trap on touch. `#zoomhint` overlay text is
  desktop-only wording; `map.on("click")` enables scrollWheelZoom.
- markercluster is in use — any gesture fix must not break cluster tap/spiderfy.
</context>

<constraints>
- Vanilla JS, inline `<style>`/`<script>` in index.html. No framework.
- Any library only from cdnjs, pinned (candidate: `leaflet-gesture-handling@1.2.2`, JS +
  its small CSS `<link>`). It's a map-level handler — layers untouched.
- Keep desktop behavior acceptable — decide whether to accept gesture-handling's
  ctrl+scroll on desktop or enable it only on `matchMedia('(pointer:coarse)')`.
- Don't leave two overlapping hint overlays on mobile.
- Never fabricate test results — actually load it on a mobile viewport.
</constraints>

<reference_material>
- `index.html` map init + `.mapframe` + `#zoomhint` + the `@media(max-width:820px)` block.
- leaflet-gesture-handling docs (`gestureHandling:true` map option, `gestureHandlingOptions.text`).
</reference_material>

<process>
1. `<thinking>`: goal, exact CSS rule + value proposed, gesture approach, desktop
   decision, what happens to `#zoomhint`.
2. Present the plan (CSS rule, cdnjs URLs + load order, desktop decision, hint
   reconciliation) and STOP for approval.
3. On approval: implement. Test on a 375-wide viewport — one finger scrolls past, two
   fingers pan, pinch zooms, tapping a pin/cluster still opens it; desktop still usable.
4. Commit. Don't push/deploy unless told.
5. Update PROGRESS.md + this file.
</process>

<output_format>
Edited `index.html` + a change summary + the manual test results (iOS Safari + Android
Chrome or emulated equivalents).
</output_format>

<self_check>
1. Constraints met (list, check each).
2. One-finger page scroll works over the map; cluster tap still works.
3. Only `index.html` changed.
4. Coordination files updated, consistent with `git log`.
</self_check>
