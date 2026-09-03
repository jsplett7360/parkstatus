# Park Status Today — iOS app (Capacitor)

The app is a **Capacitor shell** around the same static site in [`public_html/`](public_html/).
It bundles the site so it works offline, calls the Cloudflare Worker API for live
data, and adds **native push** so followed-park closures and natural-disaster
alerts arrive as real iOS notifications that deep-link back into the app.

- Web ↔ native glue: [`public_html/app-native.js`](public_html/app-native.js) — no-ops on the website, on device it registers the push token, keeps the Worker in sync with your followed parks + disaster preference, routes notification taps, and opens outbound links in an in-app browser.
- Backend: `worker.js` gained `/push/native/subscribe`, an APNs sender (`sendAPNs`), and native-subscriber handling in `notifyChanges()`. Status changes whose reason mentions a wildfire / hurricane / flood / evacuation etc. are tagged `disaster: true`.
- iOS project: [`ios/`](ios/) (committed). Icons/splash: [`assets/`](assets/) (`node assets/make-icon.js` regenerates the placeholder — swap `assets/icon.png` for real art and run `npm run assets`).

Android is **not set up yet** — do the Play Console verification first (see bottom).

---

## One-time credentials

### A. Cloudflare Worker secrets — so the Worker can send iOS push

Run in the repo (`npx wrangler secret put <NAME>` prompts for the value):

| Secret | Value |
| --- | --- |
| `APNS_AUTH_KEY` | **base64 of** the APNs `.p8` file: `base64 -i ~/keys/parkstatus/AuthKey_HS27L95NZA.p8` |
| `APNS_KEY_ID` | `HS27L95NZA` |
| `APNS_TEAM_ID` | `MGK33AG8ZK` |
| `APNS_BUNDLE_ID` | `parkstatus.today.app` |

Until these are set, `sendAPNs` throws and is caught — email + web push keep working.

### B. GitHub Actions secrets — so CI can upload to TestFlight

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `APPLE_TEAM_ID` | `MGK33AG8ZK` |
| `ASC_KEY_ID` | your App Store Connect API key id (e.g. `T3B57QK45Z`, or the App-Manager one you regenerate) |
| `ASC_ISSUER_ID` | `a570cf74-ada0-443d-aee4-78e3a7c5ae79` |
| `ASC_KEY_P8_BASE64` | `base64 -i ~/keys/parkstatus/AuthKey_T3B57QK45Z.p8` |
| `NPS_API_KEY` | already set (the workflow rebuilds the bundled site) |

---

## First build — do this one locally in Xcode

CI signing is fussy for a brand-new app; the first TestFlight build is easiest from your Mac.

```bash
# one-time Mac setup
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo gem install cocoapods            # or: brew install cocoapods

# in the repo
npm ci
npm run build:site                    # regenerate public_html (needs NPS_API_KEY in env)
npx cap sync ios                      # copy web assets + pod install
npx cap open ios                      # opens ios/App/App.xcworkspace in Xcode
```

In Xcode:
1. Select the **App** target → **Signing & Capabilities** → check **Automatically manage signing**, Team = *Joshua Splett (MGK33AG8ZK)*.
2. Confirm **Push Notifications** and **Background Modes → Remote notifications** capabilities are present (they're in `Info.plist`; add the capability rows if Xcode asks).
3. Set a real device or "Any iOS Device" as the destination → **Product → Archive**.
4. In the Organizer: **Distribute App → App Store Connect → Upload**.
5. App Store Connect → your app → TestFlight → add yourself as an internal tester.

## Ongoing releases — CI

Once the first build is up and the GitHub secrets are set:

```bash
git tag ios-v1.0.1 && git push origin ios-v1.0.1
```

The **iOS · TestFlight** workflow rebuilds the site, `cap sync`s, and uploads a new
build (build number = the run number). Or run it from the Actions tab.

## Testing push end-to-end

1. Install a TestFlight build, allow notifications, follow a park in the app.
2. `curl "https://parkstatus-api.parkstatus.workers.dev/push/native/test?token=<REBUILD_TOKEN>"` → returns `{ ok, ios_devices, results:[200] }` and a banner appears.
3. Real alerts fire from the hourly `rebuild()` when a followed park's status flips (or any park when a disaster reason appears and you have disaster alerts on).

---

## Android (deferred)

Needs the Play Console identity verification (a step wants a second device). When ready:

1. `npm i @capacitor/android && npx cap add android`
2. Remove `android/` from `.gitignore`, commit the project.
3. Firebase project `parkstatus-today-app` → add Android app `parkstatus.today.app` → put `google-services.json` in `android/app/` (gitignored — add as a CI secret).
4. Firebase → Project settings → Service accounts → generate key → Worker secret `FCM_SERVICE_ACCOUNT` (JSON). Add an FCM branch to `notifyChanges` (mirrors `sendAPNs`).
5. `keytool -genkey -v -keystore parkstatus-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000` → back it up; add base64 + passwords as GitHub secrets.
6. Add a Play upload service account + an `android-play.yml` workflow.
