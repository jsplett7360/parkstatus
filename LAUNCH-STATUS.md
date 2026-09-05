# Park Status Today — launch status

_Snapshot for picking work back up after a context compaction. Updated 2026-09-05._

## Live now (parkstatus.today)
- Static site on Hostinger, deployed by GitHub Actions (`.github/workflows/deploy.yml`, FTP) on any push touching `public_html/**`.
- Status API: Cloudflare Worker `parkstatus-api` (`worker.js` + `wrangler.toml`), deployed via **Cloudflare Workers Builds** (Git integration) on push. Hourly `scheduled()` cron rebuilds the KV blob.
- Daily `refresh-park-data.yml` cron (08:00 UTC) reruns `build-parks.js`, commits the regenerated site, which redeploys.
- Coverage: 474 NPS units + NY/CA/TX/MN state parks + FL (FDEP) + WA (parks.wa.gov scrape) + 112 National Forests (NIFC wildfire proximity) + 358 NY beaches (county hub pages).
- SEO/GEO: baked status + JSON-LD (`TouristAttraction`/`Park`, dated FAQ, `openingHoursSpecification`, `sameAs`), `/beach/` hubs, `llms.txt`, IndexNow ping from the Worker on every status change (key file `public_html/2a821d1da0b1eca28a37f6bbf86e301c.txt`).
- Email alerts: `/subscribe` sends a confirmation email; every email (confirmation + alerts + test) has an unsubscribe link; `/unsubscribe` route (GET confirm page → POST removes). Token derived from `REBUILD_TOKEN`.
- `public_html/privacy.html` + `public_html/support.html` — live, linked in every footer, in the sitemap. Use these two URLs for App Store Connect's Privacy Policy URL / Support URL.

## iOS app (Capacitor) — in progress
- Project: `ios/App/App.xcworkspace`, appId `parkstatus.today.app`, name "Park Status Today", Team `MGK33AG8ZK` (Joshua Splett, individual account).
- Bundles `public_html`; `public_html/app-native.js` registers the APNs token, syncs followed parks + a disaster-alerts pref to the Worker (`/push/native/subscribe`), routes notification taps, opens outbound links in an in-app browser. No-ops on the website.
- Worker: `sendAPNs()` (production APNs, `api.push.apple.com`), native subs in `notifyChanges()`, status changes tagged `disaster` on wildfire/hurricane/flood/etc.
- Icons/splash: placeholder from `node assets/make-icon.js` — swap `assets/icon.png` for real art, then `npm run assets`.
- Deployment target raised 13.0 → 15.0 (clears the App Store Connect "MinimumOSVersion too low" warning).
- **Done:** first build archived + uploaded to App Store Connect (2026-09-05).
- **Next:**
  1. App Store Connect → app → TestFlight → add self as Internal Tester → install via TestFlight app on iPhone.
  2. Test push: allow notifications, follow a park, `curl "https://parkstatus-api.parkstatus.workers.dev/push/native/test?token=<REBUILD_TOKEN>"` → banner.
  3. Fill App Store listing: description, keywords, category, age rating, screenshots (device family is still `1,2` = iPhone+iPad → either provide iPad screenshots or set to `1` iPhone-only), Privacy Policy URL + Support URL (the two pages above).
  4. Submit for App Store review. Guideline 4.2 (webview wrapper) risk is mitigated by native push + in-app browser + offline bundling — note that in App Review notes if needed.
- **CI:** `.github/workflows/ios-testflight.yml` — push a tag `ios-v*` → build + upload to TestFlight via App Store Connect API key. Needs GitHub secrets `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (all added). Uses `gem install fastlane`, no Gemfile.

## Android — deferred
Pending Play Console identity verification (needs a second device). Checklist in `MOBILE.md`.

## Secrets (values NOT in the repo)
- Cloudflare Worker (`npx wrangler secret put` from repo root): `NPS_API_KEY`, `REBUILD_TOKEN`, VAPID keys, `RESEND_API_KEY`, `ARCGIS_API_KEY`, and for native push `APNS_AUTH_KEY` (base64 of the .p8), `APNS_KEY_ID` (HS27L95NZA), `APNS_TEAM_ID` (MGK33AG8ZK), `APNS_BUNDLE_ID` (parkstatus.today.app) — **still need to be set if not already.**
- GitHub Actions secrets: FTP_*, NPS_API_KEY, APPLE_TEAM_ID, ASC_*.
- `.p8` keys live in `~/keys/parkstatus/`. Plaintext secret notes: `~/Desktop/Joshua/Project/parkstatus.today.txt` (outside the repo).

## Environment gotchas
- The repo is under `~/Desktop/Joshua/Project/`, which is **iCloud-synced** (Desktop & Documents). This made bulk git operations take 40+ min. Fix: `mv ~/Desktop/Joshua/Project ~/Projects` (or disable Desktop/Documents iCloud sync). Also keep the data volume under ~85% full.
- `npm ci` on this Mac needs `--cache /tmp/<somedir>` (the default `~/.npm` cache has a perms issue).
- CocoaPods: use plain `pod install` in `ios/App/` (Homebrew Ruby 4.0 breaks `bundle`).
