# PROGRESS.md — parkstatus.today

Dated work log. Newest entry first. The builder appends here every turn, in the same
format (tables/bullets, not prose). Ground truth is `git log` — if this file disagrees
with git, git wins and the discrepancy gets flagged.

## Summary

| Area | State (2026-09-07) |
| --- | --- |
| Static site (index.html) | Notifications unified into one Alerts panel; typography on half-mast token system |
| Mobile map | **Not done** — one-finger scroll trap + `.mapframe` still `74vh`. Planned, not started. |
| Park pages (build-parks.js) | Entrance fee + reservation block + 4-entry FAQ + `isAccessibleForFree` live |
| Road pages (`/road/`) | **Partial** — `2897960b` shipped generator + `roads.json` (10 rows); 4 year-round roads publish, 6 seasonal staged (`datesReviewed:false`) |
| CI / deploy | `refresh-park-data.yml` now dispatches `deploy.yml`. **Open:** its `git add` line still omits `public_html/road` + `public_html/llms.txt` |
| Worker | `/push/unsubscribe` added during the notifications work; no other pending change |
| iOS app | Capacitor wrapper; CI ship on `ios-v*` tag working. No pending app task. |
| Prompt-engineer / builder workflow | Set up this session (`.claude/` + coordination files) |

## Log

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
