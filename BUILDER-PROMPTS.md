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
| 2 | Mobile map: scroll-trap + height (leaflet-gesture-handling) | DONE — vendored 1.2.2 (not on cdnjs), `pointer:coarse` gate, `.mapframe` 52vh on phones | 2026-09-07 | 2026-09-08 `082db6f4` (pushed, deploying) |
| 3 | park.css typography reconciliation to half-mast tokens | DONE — `PARK_CSS` `:root` type token block (same names as `index.html` `f286fcd1`, calibrated to park pages' own desktop px) + `@media(max-width:580px)` tracking-loosen block; 10 display selectors re-pointed; base values byte-equal to prior, desktop @1280 verified unchanged | 2026-09-08 | 2026-09-08 `7ede13b5` (pushed `1f700982` deploy) |
| 4 | Road pages follow-up: remaining ~15–20 roads + BRP ArcGIS feed | DONE — +13 roads in `roads.json` (11 published, 2 staged: stevens-canyon-road, mineral-king-road); OFR + Glacier Point Rd backfilled & flipped to published; BRP has no keyless ArcGIS endpoint → stays Tier C, deferred (4b: scrape the `roadclosures.htm` table). No generator change. `parks*.json` byte-identical. | 2026-09-08 | 2026-09-08 `eac83fe7` (pushed `1f700982` deploy) |
| 5 | App "watch a road for reopening" + Worker `/roads` endpoint | DONE — road status moved into the Worker's hourly job (`blob.roads`, additive); `notifyChanges()` fires on Tier-B road transitions (web + native), 24h/slug cooldown; Tier-C calendar flips never notify; `roadStatus()` canonical in worker.js, build-parks.js reads `blob.roads` w/ local fallback; `/road/` pages get a "Notify me" button. No `/roads` route (blob is enough). `app-native.js` unchanged. | 2026-09-08 | 2026-09-08 `0a2166ce` (pushed `1f700982` deploy) |
| 6 | `/shutdown/` live hub (Worker auto-detect + generated page + NPS park section) | DONE + deployed — `detectShutdown()` + blob `shutdown` + `/shutdown-override`; `shutdownPageHtml`; NPS `#shutdown-note`; guide retitled; `git add public_html/shutdown` landed | 2026-09-08 | 2026-09-08 `b0388615` + `5124a997` (Worker auto-deploy; `/shutdown/` page on next cron) |
| 7 | Timed-entry index page + per-park sections | DONE — generated `/reservations/` index from `reservations.json` (6 parks table + "dropped for 2026" block naming Arches/Glacier/Rainier/Yosemite + explainer); `reservationsIndexHtml()` in build-parks.js, wired into `main()`, `sitemap()` (+1), `llmsTxt()`; per-park reservation `<article>` links back to `/reservations/`; NOT in `siteNav()`. `parks*.json` byte-identical. | 2026-09-08 | 2026-09-09 (pending commit) |
| 8 | Seasonal guides (fee-free days, holiday hours, most-visited, open-in-winter) | READY | 2026-09-08 | — |
| 9 | 4b — Blue Ridge Parkway live status: Worker-side scrape of `nps.gov/blri/planyourvisit/roadclosures.htm` (server-rendered per-milepost table + timestamp), `detectShutdown()` mold; promotes BRP from Tier C. Worker + `roadStatus()` change. | BACKLOG | 2026-09-08 | — |

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

---

## Item 3 — park.css typography reconciliation

<role>
parkstatus.today (read PROJECT-CONTEXT.md). Front-end / generator engineer. Rebase on
origin/main first.
</role>

<task>
Bring the `PARK_CSS` template string in build-parks.js onto the same half-mast typography
token system that `index.html` adopted in commit `f286fcd1`, calibrated so current
park-page desktop rendering is visually unchanged.
</task>

<why>
`index.html` runs on the half-mast token system (fluid `clamp()`, tight display
tracking, real 580px breakpoint); `park/park.css` still has ad-hoc values. Same "system,
not scale" goal from the homepage job — this is the pending follow-up noted in that
commit. park.css also styles `/road/` pages, `/park/` directory, and beach hubs, so all
of those benefit.
</why>

<context>
- `park/park.css` is generated from `PARK_CSS` (build-parks.js ~693). It already uses
  `font-weight:900` (not the homepage's 950), a `--font-display` stack that adds
  `"Arial Narrow"`, and a fluid `h1{clamp(30px,5.5vw,50px);letter-spacing:-2px;
  line-height:.96}` — it is ALREADY closer to half-mast than the old homepage was. This
  is a reconciliation, not a port.
- The homepage tokens (from `f286fcd1`, inline in index.html's `<style>`): fluid type
  scale, `--tracking-*` ~ -2px/-3px, display leading ~.84–.96, `@media(max-width:580px)`
  overrides; body stays ~14.5/16px on purpose.
- Item 6 (`/shutdown/`) also ADDS to `PARK_CSS`. Whichever lands first, the other rebases
  and re-checks the merge.
</context>

<constraints>
- Zero new deps. Only ADD/adjust within `PARK_CSS`; do not restructure it.
- Calibrate token VALUES so park-page + road-page + directory + beach-hub DESKTOP
  rendering is visually unchanged at ~1280px. The payoff is clean scaling down to 375px,
  not bigger headings.
- Body copy on park pages keeps its current sizes (`.reason` 15, `article p` 16, etc.) —
  deliberate divergence, same as the homepage. Comment it.
- parks-enriched.json / parks.json byte-identical (this only changes park.css output).
- NO web fonts. Never fabricate test results.
- Plan-first.
</constraints>

<reference_material>
- build-parks.js `PARK_CSS`; index.html's `<style>` token block + the `@media(max-width:580px)`
  block (the reference implementation); commit `f286fcd1`.
</reference_material>

<process>
1. <thinking>: list the PARK_CSS selectors that get token-ified vs. left alone; note the
   580 vs. existing-breakpoint decision; note the Item 6 merge risk.
2. Decide and justify: (a) replicate the homepage token NAMES + calibrated values inside
   PARK_CSS with a comment pointing at index.html as the reference (no shared file
   without a build step), or a tiny shared snippet; (b) keep park.css display at
   `900` + `"Arial Narrow"` (denser park-page look) or unify to `950`; (c) adopt
   `@media(max-width:580px)` or keep park.css's existing breakpoints and add 580 for
   type only.
3. Before/after table: every PARK_CSS selector touched → old value → new token → computed
   px at 1280 and at 375, showing desktop ~unchanged.
4. STOP for approval.
5. Implement. Run build-parks.js if `NPS_API_KEY` is available; otherwise diff `park.css`
   output via the harness pattern and say so.
6. Update PROGRESS.md + this file.
</process>

<output_format>
Plan + before/after table first. Then edited `PARK_CSS` in build-parks.js + regenerated
`park/park.css` + a change summary + a note on how `/road/` and beach-hub pages look at
375px.
</output_format>

<self_check>
1. Constraints met (list, check each).
2. Desktop park/road/directory/beach-hub rendering visually unchanged (state how verified).
3. parks-enriched.json / parks.json byte-identical.
4. Only build-parks.js (PARK_CSS) + park/park.css changed.
5. Coordination files updated, consistent with git.
</self_check>

---

## Item 4 — Road pages follow-up (remaining roads + BRP feed)

<role>
parkstatus.today (read PROJECT-CONTEXT.md). Build engineer extending a shipped feature.
Rebase on origin/main first.
</role>

<task>
Add the next ~15 seasonal park roads to `roads.json` and the `/road/` generator (same
schema, same two-phase date verification as Item 1), and resolve whether Blue Ridge
Parkway gets a live ArcGIS closure feed.
</task>

<why>
Item 1 shipped 8 road pages (4 year-round + Going-to-the-Sun, Trail Ridge, Tioga,
Beartooth). The `/road/` cluster is SEO Priority 1 with weak competition; more sourced
road pages = more of that intent captured and more non-duplicate content for indexation.
</why>

<context>
- Generator is done: `roadPageHtml`/`roadIndexHtml`/`roadStatus()`/`npsAlerts()` Tier B,
  the `published = roads.filter(r => r.datesReviewed === true)` filter in `main()`, the
  "Roads in this park" reverse index. `roads.json` schema is settled (name, parentIds[],
  statusUrl, designation, blurb, seasonal, accessNote, typicalOpen/Close, history[] with
  per-row source, datesReviewed, isScenicDrive, reservationRef).
- `.github/workflows/refresh-park-data.yml` already `git add`s `public_html/road` +
  `public_html/llms.txt`.
- Candidate roads (finalize ~15 by search volume; confirm entity ids against parks.json):
  Old Fall River Rd + Glacier Point Rd (held from Item 1 — backfill dates), Clingmans
  Dome Rd (grsm), Mariposa Grove Rd (yose), Yellowstone road system incl. Dunraven /
  Sylvan Pass (yell), Paradise Rd + Stevens Canyon Rd + Chinook Pass SR-410 (mora),
  Moose-Wilson Rd + Teton Park Rd (grte), Kolob Canyons Rd + Zion Canyon Scenic Dr
  (zion), Generals Hwy + Mineral King Rd + Kings Canyon Scenic Byway CA-180 (seki),
  AZ-67 / North Rim + Cape Royal Rd (grca), Denali Park Rd (dena), Badwater Rd + Artists
  Dr (deva), Chisos Basin Rd (bibe), Cadillac Summit Rd + Park Loop Rd (acad — Cadillac
  also in reservations.json, set reservationRef), Newfound Gap Rd US-441 (grsm,
  year-round).
</context>

<constraints>
- No schema change to `roads.json`. No generator LOGIC change unless a bug surfaces
  (then stop and flag it separately).
- Every `history` row needs a source. Do NOT invent a date — a road that can't be
  sourced to >=3 year-tagged opening dates ships `datesReviewed:false` (staged, not
  published), same rule as Item 1.
- BRP feed pass/fail bar: test the ACTUAL ArcGIS endpoint
  (`.../query?f=json&where=1=1`). If it returns JSON without auth, integrate it for
  blue-ridge-parkway as a keyless server-side fetch (the `FS_BOUNDARIES` pattern in
  build-parks.js). If it's only an embedded web map with no clean endpoint, BRP stays
  Tier C — state that explicitly, defer.
- parks-enriched.json / parks.json byte-identical.
- Never fabricate dates, sources, or test results. Plan-first.
</constraints>

<reference_material>
- `roads.json`, build-parks.js road functions, PROGRESS.md's Item 1 entry (the sourcing
  standard + the 4 published rows' format), nps.gov per-park road-status pages, Mono
  Basin Research Center (Tioga/Glacier Point history).
</reference_material>

<process>
1. <thinking>: the ~15 finalized roads + why; the BRP endpoint test plan; risk of a
   wrong "typically opens" date.
2. Research each road: `typicalOpen`/`typicalClose` + 3–5 sourced `history` rows.
   Present as a table per road. DO NOT flip `datesReviewed` yet.
3. Run the BRP `/query?f=json` test; report the result.
4. STOP and ask the user to confirm the date tables (per PROJECT-CONTEXT, the user
   reviews date rows). Flip `datesReviewed:true` only on approved rows.
5. Add the rows to `roads.json`. If BRP passed, wire its feed into `roadStatus()`.
6. Run build-parks.js if `NPS_API_KEY` available; else the harness path, and say so.
   Confirm `/road/` index groups the new roads, JSON-LD valid, parks-enriched/parks.json
   byte-identical.
7. Commit. Ships via the daily cron.
8. Update PROGRESS.md + this file.
</process>

<output_format>
Per-road sourced-date tables + the BRP test result first (no code). Then `roads.json`
rows + any `roadStatus()` BRP wiring + regenerated `/road/**` + a change summary.
</output_format>

<self_check>
1. Constraints met (list, check each).
2. Every `history` row has a source; no unsourced row published; held rows stay
   `datesReviewed:false`.
3. BRP: either a working `/query` URL integrated, or an explicit "no endpoint, Tier C".
4. parks-enriched.json / parks.json byte-identical.
5. Only roads.json / build-parks.js (if BRP) / generated road pages changed.
6. Coordination files updated, consistent with git.
</self_check>

---

## Item 7 — Timed-entry / reservations index page

<role>
parkstatus.today (read PROJECT-CONTEXT.md). Generator engineer. Rebase on origin/main first.
</role>

<task>
Add a generated `/reservations/` index page, built by build-parks.js from
`reservations.json`, covering which national parks require a timed-entry / vehicle
reservation and which dropped it for 2026.
</task>

<why>
SEO: "national park reservations" (3,600, KD 83) and "[park] reservations" are
commercial-SERP-dominated, but the winnable slice is the fresh, structured
"which parks require reservations in 2026 / [park] timed entry 2026" intent. Per-park
reservation blocks + FAQ already shipped (`0b9a65e7`); this is the hub that ties them
together and targets the list query. Don't over-invest — one clean annually-refreshed
page.
</why>

<context>
- `reservations.json` (repo root): 6 parks, keyed by entity id, verified for 2026
  (season, what's covered, booking URL, one-line summary), with a `_note` to re-verify
  each spring. Arches / Glacier / Mount Rainier / Yosemite are deliberately excluded
  (dropped timed entry for 2026) — the page should NAME them as "no longer required".
- Pattern to mirror: `roadIndexHtml()` -> `public_html/road/index.html`. `main()` already
  reads `reservations.json` (via `RESERVATIONS`).
- `refresh-park-data.yml` `git add` line currently covers park/road/enriched/parks/
  sitemap/llms.
</context>

<constraints>
- Zero new deps. Generated only from `reservations.json` — no new curated file.
- Do NOT add `/reservations/` to `siteNav()`; footer + contextual links only.
- parks-enriched.json / parks.json byte-identical.
- The plan may PROPOSE adding `public_html/reservations` to the `refresh-park-data.yml`
  `git add` line; don't apply unprompted.
- Never touch the "Never touch" list. Plan-first.
</constraints>

<reference_material>
- `reservations.json`, build-parks.js `roadIndexHtml` / `RESERVATIONS` usage / `sitemap()`
  / `llmsTxt()`, the existing per-park reservation block in `pageHtml`.
</reference_material>

<process>
1. <thinking>: page structure; JSON-LD; where the "dropped for 2026" list comes from
   (hardcode the 4 names + link their park pages, with a comment to re-check yearly).
2. New `reservationsIndexHtml(reservations, updatedISO, tally)` -> public_html/reservations/index.html.
   Content: intro ("some national parks require a timed-entry or vehicle reservation");
   a table of the 6 (park link, season, what's covered, "book at" link, summary); a
   "no longer required in 2026" line for Arches/Glacier/Mount Rainier/Yosemite; a short
   "how timed entry works / what it doesn't cover (entrance fee still applies)"
   explainer; JSON-LD BreadcrumbList + FAQPage ("Which national parks require
   reservations in 2026?", "Do I still pay the entrance fee with a timed-entry ticket?").
   Link each row to its `/park/<slug>/`.
3. Wire into `main()`. Add to `sitemap()` (priority ~0.7) + `llmsTxt()`.
4. Cross-link: the per-park reservation block links to `/reservations/`; `/reservations/`
   links back to each park.
5. PROPOSE the `git add` line change.
6. STOP for approval.
7. Implement; run build (or harness); confirm JSON-LD valid, sitemap has it, byte-identical.
8. Update PROGRESS.md + this file.
</process>

<output_format>
Plan first. Then `reservationsIndexHtml` + `main()` wiring + sitemap/llms + the
generated page + a change summary + the proposed workflow line.
</output_format>

<self_check>
1. Constraints met (list, check each).
2. Page renders from reservations.json alone; the 4 "dropped" parks are named + linked.
3. JSON-LD valid; sitemap + llms include /reservations/.
4. parks-enriched.json / parks.json byte-identical.
5. Only build-parks.js + the generated page (+ proposed workflow line) changed.
6. Coordination files updated, consistent with git.
</self_check>

---

## Item 8 — Seasonal guide articles

<role>
parkstatus.today (read PROJECT-CONTEXT.md). Technical writer + front-end. Rebase on
origin/main first.
</role>

<task>
Write four flat guide articles in `public_html/guides/`, matching the existing guide
template: (1) National park free days 2026, (2) Are national parks open on holidays?,
(3) The most visited national parks, (4) National parks open in winter / year-round.
</task>

<why>
Low-effort, publish-and-refresh SEO. Demand: "free national park days" 1,600 (KD 44),
"national park free days 2026" 480, "most visited national parks" 2,900 (KD 41),
"are national parks open on christmas/thanksgiving" ~140 each (KD 24–30, seasonal),
"national parks open in winter". Internal links from these to park pages also help
indexation.
</why>

<context>
- Existing guides: `public_html/guides/*.html` (flat files) + `guides/index.html` +
  `guides.css`. Follow that structure exactly (header/nav/footer, `#shutdown-banner`,
  dated FAQ JSON-LD, `guides.css` classes). See `why-national-parks-close.html` and
  `national-parks-government-shutdown.html` as templates.
- `guides/index.html` lists the guides; `build-parks.js` `sitemap()` + `llmsTxt()`
  hardcode the guide URLs — new guides must be added to all three.
- Facts that need verification before publish: the 2026 fee-free dates (10 of them), the
  2025 NPS visitation ranking numbers.
</context>

<constraints>
- Flat hand-authored HTML, same shape as the existing guides. No generator changes for
  v1 (note in the plan which of these — fee-free days, most-visited — would be worth
  converting to generated later so they auto-refresh).
- No web fonts; reuse `guides.css`. Vanilla only.
- Every factual claim (dates, visitation numbers, fee amounts) must be sourced. Present
  the fee-free date list and the visitation numbers as a table for the user to confirm
  BEFORE publishing — do not ship an unverified date.
- Each guide: cross-links to relevant `/park/<slug>/` pages and the map; dated FAQ
  JSON-LD; added to `guides/index.html`, `sitemap()`, `llmsTxt()`.
- Never fabricate a date, number, or citation. Plan-first.
</constraints>

<reference_material>
- `public_html/guides/why-national-parks-close.html` (structure), `guides.css`,
  build-parks.js `sitemap()` + `llmsTxt()` guide lists, nps.gov fee-free-days page,
  nps.gov visitation stats (irma.nps.gov) for the 2025 ranking.
</reference_material>

<process>
1. <thinking>: the four filenames/slugs; the shared template skeleton; which facts need
   sourcing.
2. Research + present for approval: the 10 fee-free 2026 dates (with source) and the
   2025 most-visited ranking (top ~15, with visitation numbers + source). STOP here.
3. On approval: draft all four articles against the existing template. Each ~500–900
   words, an FAQ block, internal links, JSON-LD.
4. Add all four to `guides/index.html`, `sitemap()`, `llmsTxt()`.
5. STOP and present the drafts for review before they count as done.
6. On approval: finalize. Ships via push (guides are in `public_html/`) — confirm with
   the user whether to push or wait for the cron.
7. Update PROGRESS.md + this file.
</process>

<output_format>
Sourced fact tables first (fee-free dates, visitation). Then four `.html` files +
updated `guides/index.html` + `sitemap()`/`llmsTxt()` edits + a summary.
</output_format>

<self_check>
1. Constraints met (list, check each).
2. Every date / number / fee is sourced and user-confirmed; nothing fabricated.
3. All four guides use `guides.css` + the existing structure; JSON-LD valid.
4. Added to guides/index.html + sitemap + llms.
5. Only `public_html/guides/**` + build-parks.js (guide lists) changed.
6. Coordination files updated, consistent with git.
</self_check>

---

## Item 5 — "Watch a road for reopening" (Worker road status + web & native push)

<role>
parkstatus.today (read PROJECT-CONTEXT.md). Full-stack: Cloudflare Worker (worker.js),
page generator (build-parks.js), the unified Alerts panel (index.html), and the
Capacitor shim (app-native.js). Rebase on origin/main first. This is the largest item so
far — the plan phase will be substantial.
</role>

<task>
Let users follow a road and get a push notification (web AND native iOS) when it changes
status — the headline case being a seasonal road reopening for the season. Move road
status computation into the Worker's hourly job so it's fresh, expose it on the blob,
and have `notifyChanges()` fire on road transitions.
</task>

<why>
Validated demand: "is trail ridge road open" 1,600, "when does going to the sun road
open" 720, strong spring seasonality — people actively wait for these. It's the app's
most differentiated notification type (NPS app / AllTrails don't do it) and it reuses the
follow + push plumbing that already exists.
</why>

<context>
- TODAY: `roadStatus()` + `npsAlerts()` (Tier B NPS-alert matching, Tier C seasonal/
  year-round statement) live in build-parks.js and run ONLY at the daily build. The blob
  has NO road data. `/road/` pages bake a static verdict + show the parent park's live
  status via the existing blob refetch.
- Worker `scheduled()` rebuilds the KV blob hourly; `notifyChanges()` diffs old vs new
  park status and sends web push (`sub:push:*`) + native APNs (`push:native:*`).
  `changeMatchesSub(ch, sub)` gates a change against a subscriber's scope. Scope:
  `{kind:"all"|"parks"|"geo", parks?, ... , disasters?}`. `sanitizeScope` (web) /
  `sanitizeNativeScope` (native, keeps `disasters`).
- Follow plumbing: `localStorage.ps_follows` = `[{id,name}]`; the unified Alerts panel
  (commit `a9a49f80`) manages it; `app-native.js` syncs it to `/push/native/subscribe`;
  web push subscribes via `/push/subscribe`. `ps_push_state` tracks web sub state.
- `roads.json` rows are keyed by slug; `parentIds` may be empty (Beartooth).
- Item 4 (more roads) and Item 6 (`/shutdown/` adds `shutdown` to the blob + edits
  `scheduled()`) also touch this surface — coordinate merge order; note it in the plan.
</context>

<constraints>
- Worker: adding a `roads` array to the `GET /` blob is additive/non-breaking — THIS
  ITEM AUTHORIZES that addition. Do not change existing blob fields.
- build-parks.js stays zero-dependency. It must STOP computing road status and instead
  read `blob.roads`. `roadStatus()`/`npsAlerts()` logic moves to worker.js — accept the
  duplication risk (no shared module without a build step); the plan states how the two
  copies stay in sync (e.g. one canonical copy in worker.js, build-parks.js only reads).
- parks-enriched.json / parks.json byte-identical.
- Road ids use a `road:` prefix (e.g. `road:going-to-the-sun-road`) so they coexist with
  park ids in `ps_follows` and in scope `parks[]`. `changeMatchesSub` must match them;
  road change objects carry `id: "road:<slug>"`.
- Notification policy (plan decides + justifies): fire on Tier B transitions (an NPS
  alert confirms open/closed). For Tier C seasonal roads, do NOT notify purely because
  the calendar `inSeason()` flipped — that's a guess, not an event. Debounce/flap
  guard like the park path.
- Web push AND native APNs both get road notifications this pass.
- Never touch: Worker/GitHub secrets, deploy.yml, ios-testflight.yml, KV namespace ids,
  existing blob fields. Never fabricate test results — test the transition path with a
  simulated alert fixture.
- Plan-first.
</constraints>

<reference_material>
- worker.js: `scheduled()`, `notifyChanges()`, `changeMatchesSub()`, `sanitizeScope` /
  `sanitizeNativeScope`, the KV blob assembly + the old-vs-new diff, `/push/subscribe`
  and `/push/native/subscribe`.
- build-parks.js: `roadStatus()`, `npsAlerts()`, `roadPageHtml` (verdict block + the
  blob-refetch `<script>`), the "Roads in this park" block, `main()` road assembly.
- index.html: the unified Alerts panel (`ps_follows` / `ps_push_state` handling).
- app-native.js: `currentScope()` and the `ps_follows` sync.
</reference_material>

<process>
1. <thinking>: enumerate every file touched (worker.js, build-parks.js, index.html,
   app-native.js) and the data-flow change (road status: build-time → hourly Worker →
   blob → generator + clients). Risks: a bad Tier B match spamming every follower; the
   two copies of road-status logic drifting; scope changes breaking existing park subs.
2. WORKER:
   - Port `roadStatus()` + `npsAlerts()` into worker.js. In `scheduled()`, compute a
     `roads` array (slug, name, cls, status, tier, reason, since/date, parentIds) and
     put it on the blob + persist it in the diffed KV state.
   - Extend the old-vs-new diff to emit road change objects; `notifyChanges()` sends
     them per the notification policy above, to web + native subs whose scope includes
     `road:<slug>`.
   - Extend `sanitizeScope` / `sanitizeNativeScope` / `changeMatchesSub` to accept
     `road:` ids in `parks[]`. Message copy for a road reopening ("Going-to-the-Sun Road
     is open for the season") + APNs/web payload shape.
   - Optional `/roads` GET route if useful beyond the blob (plan decides; blob may be
     enough).
3. GENERATOR: build-parks.js reads `blob.roads` for each `/road/` page's baked verdict
   and for the "Roads in this park" block; delete the local road-status computation (or
   keep `roadStatus()` as a pure fallback used only if `blob.roads` is missing — plan
   decides). `roadPageHtml` gains a "Notify me when this reopens" control that adds
   `{id:"road:<slug>", name}` to `ps_follows` and opens the Alerts panel / triggers the
   push subscribe, same pattern as a park follow.
4. WEB PANEL: the unified Alerts panel lists followed roads alongside followed parks;
   web `/push/subscribe` scope carries the `road:` ids.
5. NATIVE: confirm `app-native.js` `currentScope()` forwards `road:` ids through
   `/push/native/subscribe` unchanged, or make the change.
6. STOP and present the plan for approval — especially the notification policy, the
   logic-duplication strategy, and the scope/`changeMatchesSub` changes.
7. On approval: implement. Worker deploys on push; generator + panel ship via daily cron
   / a push (confirm which).
8. Update PROGRESS.md + this file.
</process>

<output_format>
Plan first: the blob `roads` schema, the notification policy with rationale, the
worker.js changes (scheduled/notifyChanges/changeMatchesSub/sanitize*), the build-parks.js
read-from-blob change + the "notify me" control, the panel + app-native changes, and a
QA checklist. Then, after approval: edited files + a change summary + test results
(simulated Tier B open/closed transition → correct web + native payloads; a Tier C
calendar flip → NO notification; existing park subs unaffected; parks-enriched/parks.json
byte-identical; `/road/` page verdict now sourced from the blob).

<self_check>
1. Every constraint met (list, check each).
2. `roads` is additive on the blob; no existing field changed; park subs still work.
3. Tier B transition notifies (web + native); Tier C calendar flip does NOT; flap guard
   present.
4. Road-status logic has ONE canonical home; build-parks.js only reads it.
5. parks-enriched.json / parks.json byte-identical.
6. No file outside worker.js / build-parks.js / index.html / app-native.js changed.
7. Coordination files updated, consistent with git.
</self_check>
