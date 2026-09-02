# parkstatus.today

Live open / partially-closed / closed status for U.S. national parks and state park
systems (NY, CA, TX, MN) plus NY beaches, on a browsable map.

- **Site:** https://parkstatus.today — static, hosted on Hostinger, lives in [`public_html/`](public_html/)
- **Status API:** [`worker.js`](worker.js) — a Cloudflare Worker (`parkstatus-api`) that polls
  every source hourly and serves the combined blob at `/`
- **Page builder:** [`build-parks.js`](build-parks.js) — regenerates the per-park static pages
  and enrichment JSON from the API + the NPS API + Wikipedia

## Repo layout

| Path | What it is |
| --- | --- |
| `public_html/` | The whole website. `index.html` is the map app; `park/<slug>/` are the 879 per-park pages; `parks-enriched.json` feeds the click-card and park pages. |
| `worker.js` / `wrangler.toml` | The Cloudflare Worker and its config (the KV namespace id in the toml is an identifier, not a secret). |
| `build-parks.js` | Node script, no dependencies. Writes into `public_html/park/**`, `parks-enriched.json`, `parks.json`, `sitemap.xml`. |

## Automation (GitHub Actions)

| Workflow | Trigger | Does |
| --- | --- | --- |
| `.github/workflows/deploy.yml` | push to `main` touching `public_html/**`, or manual | FTP-syncs `public_html/` to Hostinger |
| `.github/workflows/refresh-park-data.yml` | 1st of each month 08:00 UTC, or manual | runs `build-parks.js`, commits changed files (which then triggers `deploy.yml`) |
| `.github/workflows/deploy-worker.yml` | manual only | `wrangler deploy` of `worker.js` |

### Required repository secrets

Settings → Secrets and variables → Actions → **New repository secret**. This repo is
**public** — none of these values are in the code.

| Secret | Used by | Where to get it |
| --- | --- | --- |
| `FTP_SERVER` | deploy | Hostinger hPanel → Files → FTP Accounts → *Host* (e.g. `ftp.parkstatus.today` or `srvNNN.hstgr.io`) |
| `FTP_USERNAME` | deploy | same panel — the FTP account username |
| `FTP_PASSWORD` | deploy | same panel (set/reset the FTP password there) |
| `NPS_API_KEY` | refresh-park-data | https://www.nps.gov/subjects/developer/get-started.htm |
| `CLOUDFLARE_API_TOKEN` | deploy-worker *(optional)* | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-worker *(optional)* | Cloudflare dashboard → Workers & Pages → Account ID |

### Optional repository variable

| Variable | Default | Set it if |
| --- | --- | --- |
| `FTP_SERVER_DIR` | `./` | your FTP account lands *above* the web root — then set it to `./public_html/` |

The FTP step is a **sync**: files removed from `public_html/` are removed on the server.
`.htaccess` and `.well-known/` are excluded so server-managed files are never deleted.

## Local development

```bash
npm install                 # only dev dep is wrangler

# regenerate park pages + enrichment (~10 min; hits NPS + Wikipedia)
NPS_API_KEY=xxxxxxxx node build-parks.js

# work on the Worker
npx wrangler dev            # local
npx wrangler deploy         # publish

# preview the static site
cd public_html && python3 -m http.server 8080
```

Worker secrets are managed with `npx wrangler secret put <NAME>` and are not stored here.
