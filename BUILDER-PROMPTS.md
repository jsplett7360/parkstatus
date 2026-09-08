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
| 1 | Finish road-status first cut (deploy fix + 6 seasonal roads) | DONE — published GTTS/Trail Ridge/Tioga/Beartooth; Glacier Point + Old Fall River held | 2026-09-07 | 2026-09-07, see `git log` |
| 2 | Mobile map: scroll-trap + height (leaflet-gesture-handling) | DONE — vendored 1.2.2 (not on cdnjs), `pointer:coarse` gate, `.mapframe` 52vh on phones; committed, not pushed | 2026-09-07 | 2026-09-08, `git log` |
| 3 | park.css typography reconciliation to half-mast tokens | BACKLOG | 2026-09-07 | — |
| 4 | Road pages follow-up: remaining ~15–20 roads + BRP ArcGIS feed | BACKLOG | 2026-09-07 | — |
| 5 | App "watch a road for reopening" + Worker `/roads` endpoint | BACKLOG | 2026-09-07 | — |
| 6 | `/shutdown/` live hub (Worker auto-detect + generated page + NPS park section) | READY | 2026-09-08 | — |
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

---

## Item 6 — `/shutdown/` live hub

<role>
You are working on parkstatus.today (read PROJECT-CONTEXT.md first). For this item you
are a full-stack engineer: Cloudflare Worker (worker.js), the page generator
(build-parks.js), and a touch of the static homepage (index.html).
Rebase on origin/main before starting — the local checkout may be behind (CI refresh commits).
</role>

<task>
Build a live "/shutdown/" hub — "Are the national parks open during the government
shutdown?" — generated by build-parks.js, backed by a Worker that auto-detects a lapse
in federal appropriations. Add a shutdown section to NPS-unit park pages. Keep the
existing guide. Evergreen when there's no shutdown, live when there is.
</task>

<why>
SEO Priority 3, time-boxed. US demand (Semrush): "national parks government shutdown"
1,300 (KD 34), "government shutdown national parks" 1,000 (KD 36), "are national parks
open during government shutdown" 390 (KD 38) — near-zero baseline, huge spikes during an
actual lapse. NPS is funded through end of FY2026 (Sep 30, 2026); next funding-cliff
spike is ~3 weeks out. The page only wins if already built and indexed before it. Being
genuinely live is the edge over NPS.gov and news sites.
</why>

<context>
- worker.js (`parkstatus-api`): hourly `scheduled()` rebuilds a KV blob; `GET /` serves
  it. Deploys on push via Cloudflare Workers Builds — no manual deploy.
- build-parks.js: zero-dependency Node. `main()` (~1106) fetches the Worker blob + NPS
  API + Wikipedia, then writes park pages, `/road/` pages, beach hubs,
  parks-enriched.json, parks.json, sitemap.xml, llms.txt. `siteNav()` = single nav
  source. `pageHtml(e, en, updatedISO, tally, roadsHere)` (~407) already emits a client
  `<script>` that re-fetches the blob to live-update the status verdict.
  `roadPageHtml`/`roadIndexHtml` = the new-page-type pattern. `sitemap()` (~801) /
  `llmsTxt()` (~826) hardcode a guide-URL list then append entities.
- public_html/shutdown.json: static, `{ active, headline, message, url, cta }`, fetched
  by `#shutdown-banner` on every generated page via `fetch("/shutdown.json")`.
- Existing guide public_html/guides/national-parks-government-shutdown.html (flat file,
  sitemap priority 0.9). Stays — it's the explainer; /shutdown/ is the live status page.
- .github/workflows/refresh-park-data.yml `git add` line (authorized territory, edited
  once already):
  `git add public_html/park public_html/road public_html/parks-enriched.json public_html/parks.json public_html/sitemap.xml public_html/llms.txt`
- The Worker CANNOT write to the repo or Hostinger — only KV + the served blob.
  Everything in public_html/ is produced by build-parks.js and FTP-deployed.
</context>

<constraints>
- build-parks.js stays dependency-free (Node stdlib only). Vanilla JS, no framework, no
  build step for the static site. Front-end libs only from cdnjs, pinned.
- Reuse park.css classes + half-mast tokens (--ink #0e1726, --navy #0b1b35, --red
  #ee263b, --paper #f4f6f9, --line #dfe4ec, --muted #667185; --font-display
  "Arial Black",Impact,Arial,sans-serif 950; --font-sans Arial). NO web fonts. Only ADD
  to PARK_CSS — Item 3 (park.css typography reconciliation) is pending; keep new rules
  minimal and token-driven.
- parks-enriched.json and parks.json output must stay BYTE-IDENTICAL. Shutdown data
  goes on the blob, not in them.
- GET / blob: adding a new top-level `shutdown` object is additive and non-breaking —
  THIS ITEM AUTHORIZES exactly that addition. Do not change any existing blob field.
- refresh-park-data.yml: the plan may PROPOSE adding `public_html/shutdown` to the
  `git add` line; do not apply unprompted.
- Never touch without approval: Worker/GitHub secrets, deploy.yml, ios-testflight.yml,
  KV namespace ids, existing blob fields.
- Never fabricate data, detection results, or test output. The NPS operating-status
  scrape must be tested against real fixture HTML for both a lapse and a no-lapse state.
- Plan-first: no code until the user approves the plan.
</constraints>

<reference_material>
- worker.js: `scheduled()`, the fetch handler routing (`/rebuild` uses `REBUILD_TOKEN` —
  model the manual-override route on it), blob assembly + KV storage.
- NPS.gov "National Park System Operating Status"
  (https://www.nps.gov/planyourvisit/national-park-system-operating-status.htm) — states
  a lapse explicitly. Quote the exact phrases/structure the detector keys on.
- build-parks.js: `roadPageHtml`/`roadIndexHtml`, `pageHtml`'s blob-refetch `<script>`,
  `siteNav()`, `sitemap()`, `llmsTxt()`, `PARK_CSS`.
- PROJECT-CONTEXT.md: build/deploy pipeline, "Never touch", SEO stack.
</reference_material>

<process>
1. Think first in <thinking>: restate the goal; list every file touched (worker.js,
   build-parks.js, public_html/index.html, sitemap/llms via generator); note risks — a
   false-positive detection puts an alarming banner sitewide; the blob change must not
   break existing consumers.
2. WORKER — detector design:
   - In `scheduled()`, fetch + parse the NPS operating-status page. Produce
     `active: boolean`, `since` (start date if stated), `source`
     ("nps-operating-status" | "manual"), `summary` (short official snippet),
     `checkedAt`. Monotonic/cache logic so a transient fetch failure does NOT flip
     `active` off.
   - Manual override: an authed route (REBUILD_TOKEN, like /rebuild) forcing `active`
     true/false with a note + expiry, taking precedence over the scrape.
   - Put a small, stable `shutdown` object on the `GET /` blob.
   - Specify the exact strings/DOM structure matched, plus false-positive guardrails.
3. GENERATOR — /shutdown/ page:
   - New `shutdownPageHtml(blobShutdown, updatedISO, tally)` -> public_html/shutdown/index.html;
     wire into `main()` (already has the blob).
   - INACTIVE: evergreen explainer — "There is no federal government shutdown right
     now," what happens to NPS sites during a lapse, how to check, links to the guide +
     the NPS operating-status page.
   - ACTIVE: lead NPS — open / closed / unstaffed / limited, `since` date, official
     summary, prominent "last checked" timestamp.
   - Both: a "State parks, national forests, and NY beaches are NOT affected by a
     federal shutdown" section (own search intent; link to the map).
   - JSON-LD: BreadcrumbList + FAQPage — "Are the national parks open during a
     government shutdown?", "Which parks close during a shutdown?", "Are state parks
     affected by a federal shutdown?" — answers reflect current state, dated.
   - Client `<script>`: re-fetch the blob, swap evergreen/live copy, refresh the
     timestamp (pageHtml pattern). Baked state = no-JS fallback.
   - Do NOT add /shutdown/ to `siteNav()`; link it from the homepage footer, the guide,
     and the park-page shutdown section.
4. GENERATOR — park-page shutdown section (NPS units only):
   - In `pageHtml`, when `e.source === "nps"`, emit a shutdown `<section>` hidden when
     `shutdown.active` is false, shown when true. GENERIC copy keyed to the state — no
     per-park specifics. Links to /shutdown/. Live-updates via the existing refetch
     script (extend it); baked state = fallback. State parks / forests / beaches get
     nothing.
5. GUIDE — cross-links: guide -> /shutdown/ ("check live status") near the top;
   /shutdown/ -> guide ("full explainer"). Note how you keep them from cannibalizing
   (distinct titles/H1s; /shutdown/ owns "is it open" intent, guide owns "what happens
   / why").
6. sitemap.xml + llms.txt: add /shutdown/ (pick weekly vs daily changefreq, justify).
   PROPOSE adding `public_html/shutdown` to the refresh-park-data.yml `git add` line.
7. STOP and present the plan for approval. No code before that.
8. On approval: implement. Worker deploys on push; /shutdown/ + park sections ship via
   the daily refresh cron.
9. Update PROGRESS.md and BUILDER-PROMPTS.md's status table.
</process>

<output_format>
Plan first (no code): Worker detector design (matched strings, guardrails, blob
`shutdown` schema, manual-override route); shutdownPageHtml structure for both states;
the pageHtml section change; guide cross-links; sitemap/llms + proposed workflow line;
QA checklist. Then, after approval: edited files in place + a change-summary table +
test results (Worker scrape vs lapse and no-lapse fixtures; /shutdown/ in both states;
NPS park page vs state park page; JSON-LD validity; parks-enriched.json/parks.json
byte-identical).
</output_format>

<self_check>
Before reporting done:
1. Every constraint met (list each, check it).
2. Worker: `shutdown` is additive; no existing blob field changed; detector tested vs
   real lapse + no-lapse fixtures; transient fetch failure doesn't flip active off;
   manual override works and expires.
3. Generator: /shutdown/ renders in BOTH states; park shutdown section appears only for
   `source === "nps"` and only when active; parks-enriched.json / parks.json
   byte-identical; sitemap has /shutdown/.
4. Guide still resolves; cross-links both directions; #shutdown-banner still works.
5. No unrelated file changed. refresh-park-data.yml `git add` change is proposed, not
   applied (unless approved).
6. PROGRESS.md + BUILDER-PROMPTS.md updated and consistent with git.
</self_check>
