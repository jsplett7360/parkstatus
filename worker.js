/**
 * parkstatus.today — NPS + NY status Worker + notification sender
 *
 * Sources: NPS Data API (national); NY DOH Beach Advisory feed; scrapes of
 * curated parks.ny.gov and tpwd.texas.gov (TX) alert pages; the California
 * State Parks "Park Unit Current Status" ArcGIS layer (all units); and the
 * MN DNR compass feature_detail JSONP endpoint per Minnesota park.
 *
 *   scheduled()          -> hourly: refresh statuses, and email/push subscribers about CHANGES
 *   GET  /               -> serve cached status blob (public API)
 *   GET  /rebuild?token= -> refresh now (no notifications)
 *   GET  /stats?token=   -> subscriber + status counts
 *   GET  /test-notify?token=&email=  -> send a test email (to `email`) and a test push (to all)
 *   POST /subscribe      -> store email signup   (KV: sub:email:<email>)
 *   POST /push/subscribe -> store push sub        (KV: sub:push:<hash>)
 *
 * Secrets:
 *   wrangler secret put NPS_API_KEY
 *   wrangler secret put REBUILD_TOKEN
 *   wrangler secret put VAPID_PRIVATE     (Web Push signing; public key is below)
 *   wrangler secret put RESEND_API_KEY    (email sending via Resend)
 *   wrangler secret put ARCGIS_API_KEY    (optional — only for token-secured Esri layers)
 */

const API = "https://developer.nps.gov/api/v1";
const NY_BEACH_API = "https://beachadvisory.health.ny.gov/doh7/beachesadvisory/beaches";
const SITE = "https://parkstatus.today";
const VAPID_PUBLIC = "BN13jzaTmu-9k91rWOMlOFTjtIyowSvH2r8V8JugZgS-sMQQkFtn68a6tdS9wgMJJYcCmEU2iP99balHlTJofUA";
const VAPID_SUBJECT = "mailto:alerts@parkstatus.today";
const MAIL_FROM = "Park Status Today <alerts@parkstatus.today>";
const STATUS_TEXT = { open: "open", partially_closed: "partially closed", closed: "closed" };

// --- Editorial: force EVERY park closed for a 2013-style total lockout.
const SHUTDOWN_ACTIVE = false;
const SHUTDOWN_NOTE = "Federal government shutdown in effect. Park access and staffing may be limited; verify with the park before visiting.";

// ===================== status classification (v2) ==========================
const REOPEN  = /\b(now open|reopened|has reopened|have reopened|back open|open again)\b/i;
const CLOSURE = /\b(closed|closure|closures|closing|will close|to close|now closed)\b/i;
const FULL    = /\b(entire park|whole park|park is closed|park will be closed|park closed (for|until|due)|all of the park( is)? closed|government shutdown|lapse in appropriations)\b/i;
const DANGER  = /\b(hazard|flash flood|flooding|wildfire|active fire|evacuat|life[- ]threatening|do not enter|rockfall|dangerous conditions|swift water|search and rescue)\b/i;
const CAUTION = /\b(caution|be aware|advisory|use care|slippery|limited service|reduced service|fire restriction|burn ban|restrictions in effect)\b/i;

function classify(a) {
  const t = `${a.title || ""} ${a.description || ""}`;
  const cat = (a.category || "").toLowerCase();
  if (REOPEN.test(t) && !CLOSURE.test(t) && !FULL.test(t)) return "info";
  if (FULL.test(t)) return "full_closure";
  if (CLOSURE.test(t) || cat === "park closure") return "partial_closure";
  if (DANGER.test(t) || cat === "danger") return "danger";
  if (CAUTION.test(t) || cat === "caution") return "caution";
  return "info";
}
const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Resolve a park's hours string for a given Date (exception ranges override standard).
function hoursForDate(park, d) {
  const dow = DOW[d.getDay()];
  const iso = d.toISOString().slice(0, 10);
  let anyOpen = false, allClosed = true, saw = false;
  for (const g of park.operatingHours || []) {
    let hrs = (g.standardHours || {})[dow];
    for (const ex of g.exceptions || []) {
      if (ex.startDate && ex.endDate && iso >= ex.startDate && iso <= ex.endDate)
        hrs = (ex.exceptionHours || {})[dow] ?? hrs;
    }
    if (hrs == null || hrs === "") continue;
    saw = true;
    if (hrs.trim().toLowerCase() === "closed") continue;
    anyOpen = true; allClosed = false;
  }
  return { saw, anyOpen, allClosed: saw && allClosed };
}

function scheduledClosedToday(park) {
  if (!(park.operatingHours || []).length) return false;
  return hoursForDate(park, new Date()).allClosed;
}

// First upcoming day the park is scheduled to be open again — a weekday name if
// within a week, else "Mon, Jan 6"; null if it can't be determined.
function nextScheduledOpen(park) {
  if (!(park.operatingHours || []).length) return null;
  const today = new Date();
  for (let i = 1; i <= 21; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    if (hoursForDate(park, d).anyOpen) {
      return i <= 6
        ? d.toLocaleDateString("en-US", { weekday: "long" })
        : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    }
  }
  return null;
}
function derive(park, alerts) {
  const kinds = alerts.map(classify);
  let status, reason;
  let scheduledOnly = false;
  if (SHUTDOWN_ACTIVE) { status = "closed"; reason = SHUTDOWN_NOTE; }
  else if (kinds.includes("full_closure")) { status = "closed"; reason = alerts[kinds.indexOf("full_closure")].title || "Full closure in effect."; }
  else if (scheduledClosedToday(park)) {
    status = "closed"; scheduledOnly = true;
    const nx = nextScheduledOpen(park);
    reason = nx ? `Closed today per scheduled operating hours — reopens ${nx}.` : "Closed today per scheduled operating hours.";
  }
  else if (kinds.some(k => k === "partial_closure" || k === "danger")) {
    const i = kinds.findIndex(k => k === "partial_closure" || k === "danger");
    status = "partially_closed"; reason = alerts[i].title || "Active closures or hazards in parts of the park.";
  } else if (kinds.includes("caution")) { status = "open"; reason = alerts[kinds.indexOf("caution")].title || "Open, with cautions posted."; }
  else { status = "open"; reason = "No active closures or hazards reported."; }
  const count = k => kinds.filter(x => x === k).length;
  return { status, reason, scheduledOnly, counts: {
    full_closure: count("full_closure"), partial_closure: count("partial_closure"),
    danger: count("danger"), caution: count("caution"), info: count("info") } };
}

// ===================== beaches (NY pilot) ===================================
// NY's own status vocabulary, kept distinct from park status per design call:
//   1 Open -> "open"
//   2 Closed to Swimming -> "closed"
//   3 Under Water Quality Advisory -> "advisory"
//   4 Not in Operation -> "not_in_operation"   (seasonal/off-season facility)
//   5 Status Updated by Another Entity -> "pending"  (another agency owns it; show as-is)
const NY_STATUS_MAP = { 1: "open", 2: "closed", 3: "advisory", 4: "not_in_operation", 5: "pending" };
const BEACH_STATUS_TEXT = {
  open: "Open", closed: "Closed to swimming", advisory: "Water quality advisory",
  not_in_operation: "Not in operation", pending: "Status updated by another entity",
};

function deriveBeachReason(b) {
  // Check statusId 4/5 FIRST — these override any leftover activity text,
  // since "pending" specifically means the status shown may not match the
  // most recent activity record (another agency owns the update).
  if (b.statusId === 4) return "Beach is not currently in operation (seasonal facility).";
  if (b.statusId === 5) return `Status is maintained by ${b.jurisdiction?.name || "another agency"} — check their site for the latest.`;
  const act = b.beachActivity;
  if (act && act.activityType && act.activityType.description) return act.activityType.description;
  if (act && act.activityType && act.activityType.name) return act.activityType.name;
  return "No active advisories reported.";
}

const CRAWL_UA = "ParkStatusToday/1.0 (+https://parkstatus.today; hourly polling, contact via site)";

async function fetchNYBeaches() {
  const r = await fetch(NY_BEACH_API, { headers: { "User-Agent": CRAWL_UA } });
  if (!r.ok) throw new Error(`ny-beaches ${r.status}`);
  const rows = await r.json();
  return rows.map(b => {
    const status = NY_STATUS_MAP[b.statusId] || "pending";
    const act = b.beachActivity;
    return {
      id: `ny-${b.epa_beach_id || b.name}`,
      name: b.name,
      state: "NY",
      lat: b.latitude, lon: b.longitude,
      status,
      statusLabel: BEACH_STATUS_TEXT[status],
      reason: deriveBeachReason(b),
      jurisdiction: b.jurisdiction?.name || null,
      jurisdictionUrl: b.jurisdiction?.url || null,
      waterbody: b.waterbody?.name || null,
      county: b.county?.name || null,
      startDate: act?.notificationStartDate || null,
      endDate: act?.notificationEndDate || null,
      updatedAt: b.updatedAt || null,
      source: "ny-doh",
    };
  });
}

// ===================== NY state parks (OPRHP) ==============================
// NY OPRHP publishes NO alerts feed. Each parks.ny.gov park page renders a
// server-side `.c-alert` block, so we scrape a curated set of high-traffic
// parks (one subrequest each). Cloudflare Workers Free allows 50 subrequests
// per invocation; NPS(~4) + beaches(1) + this list must stay under that, so
// keep NY_PARKS at roughly 40 or fewer. Everything else in NY is covered by
// the beach-advisory feed. Coordinates from data.ny.gov (9uuk-x7vh).
const NY_PARK_BASE = "https://parks.ny.gov/visit/state-parks/";
const NY_PARKS = [
  { slug: "letchworth-state-park", name: "Letchworth State Park", lat: 42.64592, lon: -77.97577, county: "Livingston/Wyoming" },
  { slug: "niagara-falls-state-park", name: "Niagara Falls State Park", lat: 43.08675, lon: -79.06702, county: "Niagara" },
  { slug: "watkins-glen-state-park", name: "Watkins Glen State Park", lat: 42.36754, lon: -76.90013, county: "Schuyler" },
  { slug: "jones-beach-state-park", name: "Jones Beach State Park", lat: 40.59601, lon: -73.51643, county: "Nassau" },
  { slug: "montauk-point-state-park", name: "Montauk Point State Park", lat: 41.07145, lon: -71.88139, county: "Suffolk" },
  { slug: "bear-mountain-state-park", name: "Bear Mountain State Park", lat: 41.299, lon: -73.9924, county: "Rockland/Orange" },
  { slug: "saratoga-spa-state-park", name: "Saratoga Spa State Park", lat: 43.05089, lon: -73.80394, county: "Saratoga" },
  { slug: "taughannock-falls-state-park", name: "Taughannock Falls State Park", lat: 42.54074, lon: -76.60977, county: "Tompkins" },
  { slug: "green-lakes-state-park", name: "Green Lakes State Park", lat: 43.04698, lon: -75.98188, county: "Onondaga" },
  { slug: "minnewaska-state-park-preserve", name: "Minnewaska State Park Preserve", lat: 41.71582, lon: -74.29324, county: "Ulster" },
  { slug: "harriman-state-park", name: "Harriman State Park", lat: 41.23733, lon: -74.1017, county: "Rockland/Orange" },
  { slug: "robert-h-treman-state-park", name: "Robert H. Treman State Park", lat: 42.40058, lon: -76.57954, county: "Tompkins" },
  { slug: "buttermilk-falls-state-park", name: "Buttermilk Falls State Park", lat: 42.40403, lon: -76.51226, county: "Tompkins" },
  { slug: "hudson-highlands-state-park-preserve", name: "Hudson Highlands State Park Preserve", lat: 41.43376, lon: -73.96211, county: "Dutchess/Putnam" },
  { slug: "moreau-lake-state-park", name: "Moreau Lake State Park", lat: 43.23321, lon: -73.73378, county: "Saratoga" },
  { slug: "grafton-lakes-state-park", name: "Grafton Lakes State Park", lat: 42.78419, lon: -73.44286, county: "Rensselaer" },
  { slug: "hamlin-beach-state-park", name: "Hamlin Beach State Park", lat: 43.36009, lon: -77.9551, county: "Monroe" },
  { slug: "evangola-state-park", name: "Evangola State Park", lat: 42.6058, lon: -79.10186, county: "Erie" },
  { slug: "chittenango-falls-state-park", name: "Chittenango Falls State Park", lat: 42.98148, lon: -75.84666, county: "Madison" },
  { slug: "hither-hills-state-park", name: "Hither Hills State Park", lat: 41.01606, lon: -72.02131, county: "Suffolk" },
  { slug: "golden-hill-state-park", name: "Golden Hill State Park", lat: 43.36946, lon: -78.48016, county: "Niagara" },
  { slug: "fort-niagara-state-park", name: "Fort Niagara State Park", lat: 43.26163, lon: -79.05259, county: "Niagara" },
  { slug: "wellesley-island-state-park", name: "Wellesley Island State Park", lat: 44.32924, lon: -76.01545, county: "Jefferson" },
  { slug: "selkirk-shores-state-park", name: "Selkirk Shores State Park", lat: 43.55566, lon: -76.19844, county: "Oswego" },
  { slug: "gilbert-lake-state-park", name: "Gilbert Lake State Park", lat: 42.58658, lon: -75.13246, county: "Otsego" },
  { slug: "chenango-valley-state-park", name: "Chenango Valley State Park", lat: 42.21554, lon: -75.83624, county: "Broome" },
  { slug: "verona-beach-state-park", name: "Verona Beach State Park", lat: 43.17801, lon: -75.71659, county: "Oneida" },
  { slug: "stony-brook-state-park", name: "Stony Brook State Park", lat: 42.51856, lon: -77.69297, county: "Steuben" },
  { slug: "darien-lakes-state-park", name: "Darien Lakes State Park", lat: 42.91181, lon: -78.41149, county: "Genesee" },
  { slug: "gantry-plaza-state-park", name: "Gantry Plaza State Park", lat: 40.74652, lon: -73.95815, county: "Queens" },
  { slug: "bethpage-state-park", name: "Bethpage State Park", lat: 40.74752, lon: -73.4568, county: "Nassau" },
  { slug: "fair-haven-beach-state-park", name: "Fair Haven Beach State Park", lat: 43.34171, lon: -76.69131, county: "Cayuga" },
  { slug: "cayuga-lake-state-park", name: "Cayuga Lake State Park", lat: 42.89795, lon: -76.75531, county: "Seneca" },
  { slug: "delta-lake-state-park", name: "Delta Lake State Park", lat: 43.29097, lon: -75.42187, county: "Oneida" },
  { slug: "keewaydin-state-park", name: "Keewaydin State Park", lat: 44.32343, lon: -75.92971, county: "Jefferson" },
  { slug: "cumberland-bay-state-park", name: "Cumberland Bay State Park", lat: 44.73335, lon: -73.42118, county: "Clinton" },
  { slug: "higley-flow-state-park", name: "Higley Flow State Park", lat: 44.4983, lon: -74.91464, county: "St. Lawrence" },
  { slug: "glimmerglass-state-park", name: "Glimmerglass State Park", lat: 42.79363, lon: -74.86868, county: "Otsego" },
  { slug: "heckscher-state-park", name: "Heckscher State Park", lat: 40.70866, lon: -73.16492, county: "Suffolk" },
];

// Pull the `.c-alert` blocks (title / message / date) off a parks.ny.gov page.
// Returns { url, alerts:[...] }  or  alerts:null when the fetch itself failed.
async function scrapeNYParkAlerts(slug) {
  const url = NY_PARK_BASE + slug;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": CRAWL_UA }, cf: { cacheTtl: 1800, cacheEverything: true } });
  } catch (_) { return { url, alerts: null }; }
  if (!res.ok) { await res.body?.cancel?.(); return { url, alerts: res.status === 404 ? [] : null }; }

  const alerts = [];
  let cur = null;
  const finish = () => { if (cur && (cur.title || cur.message)) alerts.push(cur); cur = null; };
  const rw = new HTMLRewriter()
    .on(".c-alert", {
      element(el) { finish(); cur = { title: "", message: "", date: "" }; el.onEndTag(finish); },
    })
    .on(".c-alert__title", { text(t) { if (cur) cur.title += t.text; } })
    .on(".c-alert__message", { text(t) { if (cur) cur.message += t.text; } })
    .on(".c-alert__date", { text(t) { if (cur) cur.date += t.text; } });
  await rw.transform(res).arrayBuffer();
  finish();

  const clean = s => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return {
    url,
    alerts: alerts
      .map(a => ({ title: clean(a.title), message: clean(a.message), date: clean(a.date) }))
      .filter(a => a.title || a.message),
  };
}

function deriveNYPark(alerts) {
  const kinds = alerts.map(a => classify({ title: a.title, description: a.message }));
  let status, reason;
  if (kinds.includes("full_closure")) { status = "closed"; reason = alerts[kinds.indexOf("full_closure")].title; }
  else if (kinds.some(k => k === "partial_closure" || k === "danger")) {
    const i = kinds.findIndex(k => k === "partial_closure" || k === "danger");
    status = "partially_closed"; reason = alerts[i].title || "Active closures or hazards in parts of the park.";
  } else if (kinds.includes("caution")) {
    status = "open"; reason = alerts[kinds.indexOf("caution")].title || "Open, with advisories posted.";
  } else if (alerts.length) {
    status = "open"; reason = alerts[0].title || "Open; informational notices posted.";
  } else {
    status = "open"; reason = "No active alerts posted on the park's page.";
  }
  const c = k => kinds.filter(x => x === k).length;
  return { status, reason, counts: {
    full_closure: c("full_closure"), partial_closure: c("partial_closure"),
    danger: c("danger"), caution: c("caution"), info: c("info") } };
}

async function fetchNYStateParks() {
  const settled = await Promise.allSettled(NY_PARKS.map(async p => {
    const { url, alerts } = await scrapeNYParkAlerts(p.slug);
    if (alerts === null) throw new Error("ny-park scrape failed: " + p.slug);
    const d = deriveNYPark(alerts);
    return {
      id: "nysp-" + p.slug,
      name: p.name,
      state: "NY",
      county: p.county || null,
      lat: p.lat, lon: p.lon,
      status: d.status, reason: d.reason, counts: d.counts,
      alertCount: alerts.length,
      alerts: alerts.slice(0, 6),
      url,
      source: "ny-oprhp",
    };
  }));
  const parks = settled.filter(r => r.status === "fulfilled").map(r => r.value);
  return parks.length ? parks : null;
}

// ===================== generic ArcGIS FeatureServer adapter ================
// Reads any public (or token-secured) Esri FeatureServer/MapServer layer and
// returns raw GeoJSON features. Reused per state — pass a `map` fn to shape.
//   fetchArcGIS(layerUrl, { where, outFields, apiKey, pageSize })
async function fetchArcGIS(layerUrl, opts = {}) {
  const { where = "1=1", outFields = "*", apiKey, pageSize = 1000 } = opts;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const p = new URLSearchParams({
      where, outFields, f: "geojson", returnGeometry: "true", outSR: "4326",
      resultRecordCount: String(pageSize), resultOffset: String(offset),
    });
    if (apiKey) p.set("token", apiKey);
    const r = await fetch(`${layerUrl}/query?${p}`, { headers: { "User-Agent": CRAWL_UA } });
    if (!r.ok) throw new Error(`arcgis ${r.status} ${layerUrl}`);
    const gj = await r.json();
    if (gj.error) throw new Error(`arcgis ${gj.error.code}: ${gj.error.message}`);
    const feats = gj.features || [];
    out.push(...feats);
    if (feats.length < pageSize || offset > 40000) break;
  }
  return out;
}

// ===================== California state parks (CA State Parks) =============
// CSPParkUnit_CurrentStatus is CA State Parks' own operational-status layer:
// every unit carries Status = OPEN | "Partial Closure" | "Full Closure",
// so no text classification is needed. Public layer — no token required; the
// ARCGIS_API_KEY secret is kept only for future token-secured layers.
const CA_PARK_STATUS_URL =
  "https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/CSPParkUnit_CurrentStatus/FeatureServer/0";
const CA_STATUS_MAP = { "OPEN": "open", "Partial Closure": "partially_closed", "Full Closure": "closed" };

function caFacilityTags(a) {
  const t = [];
  const add = (closed, total, label) => {
    const c = Number(closed) || 0;
    if (c > 0) t.push(total ? `${c} of ${total} ${label} closed` : `${c} ${label} closed`);
  };
  add(a.closed_campsites, a.total_campsites, "campsites");
  add(a.closed_milestrail, a.total_milestrail, "trail miles");
  add(a.closed_parkingares, a.total_parkingares, "parking areas");
  add(a.closed_restroooms, a.total_restrooms, "restrooms");
  add(a.closed_concessions, a.total_concessions, "concessions");
  return t;
}

function normalizeCAParks(features) {
  const rows = [];
  for (const f of features || []) {
    const a = f.properties || {};
    if ((a.closure_reason || "") === "Always Closed to Public") continue; // not a visitor closure
    const coords = f.geometry && f.geometry.coordinates;
    if (!coords || coords.length < 2) continue;
    const [lon, lat] = coords;
    const status = CA_STATUS_MAP[a.Status] || "open";

    let reason;
    if (status === "open") {
      reason = "No closures reported by California State Parks.";
    } else {
      const r = ((a.closure_reason === "Other" ? a.closure_reason_other : a.closure_reason) || "").trim();
      const note = (a.status_notes_pub || "").replace(/\s+/g, " ").trim();
      if (r && note && !note.toLowerCase().startsWith(r.toLowerCase())) reason = `${r} — ${note.slice(0, 200)}`;
      else reason = note || r || (status === "closed" ? "Full closure in effect." : "Partial closure in effect.");
    }
    let reopen = null;
    if (a.StatusReopenDate) { try { reopen = new Date(a.StatusReopenDate).toISOString().slice(0, 10); } catch (_) {} }
    else if (a.StatusReopenUnknown) reopen = String(a.StatusReopenUnknown);

    rows.push({
      id: "casp-" + (a.UNITNUM || a.UNITNAME),
      name: a.UNITNAME,
      state: "CA",
      county: a.County ? String(a.County).replace(/_/g, " ").replace(/,(\S)/g, ", $1") : null,
      district: a.District || null,
      lat, lon,
      status,
      reason,
      reopen,
      tags: caFacilityTags(a),
      url: a.website || "https://www.parks.ca.gov/",
      source: "ca-state-parks",
    });
  }
  return rows;
}

async function fetchCAStateParks(env) {
  const feats = await fetchArcGIS(CA_PARK_STATUS_URL, {
    outFields: [
      "UNITNAME", "UNITNUM", "County", "District", "website", "Status",
      "closure_reason", "closure_reason_other", "status_notes_pub",
      "StatusReopenDate", "StatusReopenUnknown",
      "closed_campsites", "total_campsites", "closed_milestrail", "total_milestrail",
      "closed_parkingares", "total_parkingares", "closed_restroooms", "total_restrooms",
      "closed_concessions", "total_concessions",
    ].join(","),
    // ARCGIS_API_KEY is intentionally NOT sent here — this layer is public and a
    // stray token can trigger 498s on some configs. Wire it in only for secured layers.
  });
  const parks = normalizeCAParks(feats);
  return parks.length ? parks : null;
}

// ===================== Texas state parks (TPWD) ===========================
// TPWD has no feed; each /state-parks/<slug>/alert page server-renders a
// single `.notice-message` div holding all alerts as <h3> title + <p> text
// pairs. We collect the h3 titles + full body text and classify the blob.
const TX_PARK_BASE = "https://tpwd.texas.gov/state-parks/";
const TX_PARKS = [
  { slug: "garner", name: "Garner State Park", lat: 29.58764, lon: -99.73878, county: "Uvalde" },
  { slug: "enchanted-rock", name: "Enchanted Rock State Natural Area", lat: 30.51501, lon: -98.80155, county: "Llano" },
  { slug: "pedernales-falls", name: "Pedernales Falls State Park", lat: 30.30595, lon: -98.24548, county: "Blanco" },
  { slug: "balmorhea", name: "Balmorhea State Park", lat: 30.94221, lon: -103.7705, county: "Reeves" },
  { slug: "dinosaur-valley", name: "Dinosaur Valley State Park", lat: 32.25081, lon: -97.81264, county: "Somervell" },
  { slug: "colorado-bend", name: "Colorado Bend State Park", lat: 31.04503, lon: -98.48058, county: "San Saba" },
  { slug: "inks-lake", name: "Inks Lake State Park", lat: 30.73329, lon: -98.36968, county: "Burnet" },
  { slug: "caprock-canyons", name: "Caprock Canyons State Park", lat: 34.44406, lon: -101.06231, county: "Briscoe" },
  { slug: "davis-mountains", name: "Davis Mountains State Park", lat: 30.60438, lon: -103.93044, county: "Jeff Davis" },
  { slug: "guadalupe-river", name: "Guadalupe River State Park", lat: 29.86619, lon: -98.49421, county: "Comal" },
  { slug: "lost-maples", name: "Lost Maples State Natural Area", lat: 29.82773, lon: -99.58921, county: "Bandera" },
  { slug: "goose-island", name: "Goose Island State Park", lat: 28.14642, lon: -96.99716, county: "Aransas" },
  { slug: "galveston-island", name: "Galveston Island State Park", lat: 29.2015, lon: -94.965, county: "Galveston" },
  { slug: "brazos-bend", name: "Brazos Bend State Park", lat: 29.38143, lon: -95.60295, county: "Fort Bend" },
  { slug: "lake-livingston", name: "Lake Livingston State Park", lat: 30.66206, lon: -95.00382, county: "Polk" },
  { slug: "huntsville", name: "Huntsville State Park", lat: 30.62124, lon: -95.53034, county: "Walker" },
  { slug: "bastrop", name: "Bastrop State Park", lat: 30.11501, lon: -97.23469, county: "Bastrop" },
  { slug: "buescher", name: "Buescher State Park", lat: 30.0655, lon: -97.17582, county: "Bastrop" },
  { slug: "mckinney-falls", name: "McKinney Falls State Park", lat: 30.18517, lon: -97.72276, county: "Travis" },
  { slug: "cedar-hill", name: "Cedar Hill State Park", lat: 32.60793, lon: -96.99462, county: "Dallas" },
  { slug: "eisenhower", name: "Eisenhower State Park", lat: 33.81908, lon: -96.61046, county: "Grayson" },
  { slug: "lake-mineral-wells", name: "Lake Mineral Wells State Park", lat: 32.84346, lon: -98.03001, county: "Parker" },
  { slug: "possum-kingdom", name: "Possum Kingdom State Park", lat: 32.8686, lon: -98.56555, county: "Palo Pinto" },
  { slug: "ray-roberts-lake", name: "Ray Roberts Lake State Park", lat: 33.38703, lon: -97.107, county: "Denton" },
  { slug: "lake-somerville", name: "Lake Somerville State Park", lat: 30.31063, lon: -96.62779, county: "Burleson" },
  { slug: "blanco", name: "Blanco State Park", lat: 30.09341, lon: -98.42727, county: "Blanco" },
  { slug: "government-canyon", name: "Government Canyon State Natural Area", lat: 29.57297, lon: -98.76261, county: "Bexar" },
  { slug: "kickapoo-cavern", name: "Kickapoo Cavern State Park", lat: 29.61184, lon: -100.44813, county: "Kinney" },
  { slug: "south-llano-river", name: "South Llano River State Park", lat: 30.4311, lon: -99.80048, county: "Kimble" },
  { slug: "seminole-canyon", name: "Seminole Canyon State Park", lat: 29.68804, lon: -101.31069, county: "Val Verde" },
  { slug: "franklin-mountains", name: "Franklin Mountains State Park", lat: 31.92359, lon: -106.49916, county: "El Paso" },
  { slug: "hueco-tanks", name: "Hueco Tanks State Park", lat: 31.91717, lon: -106.04389, county: "El Paso" },
  { slug: "fort-boggy", name: "Fort Boggy State Park", lat: 31.1882, lon: -95.98602, county: "Leon" },
  { slug: "sea-rim", name: "Sea Rim State Park", lat: 29.69476, lon: -94.03345, county: "Jefferson" },
  { slug: "choke-canyon", name: "Choke Canyon State Park", lat: 28.47043, lon: -98.25079, county: "Live Oak" },
  { slug: "lyndon-b-johnson", name: "Lyndon B. Johnson State Park", lat: 30.23971, lon: -98.60699, county: "Gillespie" },
  { slug: "tyler", name: "Tyler State Park", lat: 32.47703, lon: -95.29478, county: "Smith" },
  { slug: "daingerfield", name: "Daingerfield State Park", lat: 33.00887, lon: -94.69585, county: "Morris" },
  { slug: "lake-arrowhead", name: "Lake Arrowhead State Park", lat: 33.75761, lon: -98.39046, county: "Clay" },
];

async function scrapeTXParkAlerts(slug) {
  const url = TX_PARK_BASE + slug + "/alert";
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": CRAWL_UA }, cf: { cacheTtl: 1800, cacheEverything: true } });
  } catch (_) { return { url, body: null, headings: null }; }
  if (!res.ok) { await res.body?.cancel?.(); return { url, body: res.status === 404 ? "" : null, headings: res.status === 404 ? [] : null }; }

  const titles = [];
  let curTitle = null, body = "";
  const rw = new HTMLRewriter()
    .on(".notice-message h3", {
      element(el) { if (curTitle !== null) titles.push(curTitle); curTitle = "";
        el.onEndTag(() => { titles.push(curTitle); curTitle = null; }); },
      text(t) { if (curTitle !== null) curTitle += t.text; },
    })
    .on(".notice-message", { text(t) { body += t.text + " "; } });
  await rw.transform(res).arrayBuffer();
  if (curTitle) titles.push(curTitle);

  const clean = s => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return { url: TX_PARK_BASE + slug + "/", body: clean(body).slice(0, 1200), headings: titles.map(clean).filter(Boolean) };
}

// TX alert pages are noisy — burn bans, future dated event closures and
// "reservations recommended" are the norm and don't mean the park is shut.
// So only flag on PRESENT-TENSE closure/hazard language.
function deriveTXPark(headings, body) {
  const t = (headings.join(" · ") + " " + body).toLowerCase();
  const fullNow = /\bpark (is|currently) closed\b|\bpark remains closed\b|\bclosed until further notice\b|\bentire park (is )?closed\b|\bpark closed due to\b/;
  const partialNow = /\b(is|are) closed\b|\bcurrently closed\b|\btemporarily closed\b|\bclosed for the season\b|\b(flash flood|flooding|wildfire|active fire|evacuat|do not enter|water outage|power outage)\b/;
  const cautionOnly = /\bburn ban\b|\badvisory\b|\bcaution\b|\brestrictions? in effect\b|\btropical (storm|disturbance)\b/;
  let status, reason;
  const closeHead = headings.find(h => /clos/i.test(h));
  if (fullNow.test(t)) { status = "closed"; reason = closeHead || "Park closure in effect."; }
  else if (partialNow.test(t)) { status = "partially_closed"; reason = closeHead || headings.find(h => /flood|fire|outage|hazard/i.test(h)) || "Active closures or hazards in parts of the park."; }
  else if (cautionOnly.test(t)) { status = "open"; reason = headings[0] || "Open, with advisories posted."; }
  else { status = "open"; reason = headings[0] || "No closures reported by Texas Parks & Wildlife."; }
  return { status, reason };
}

async function fetchTXStateParks() {
  const settled = await Promise.allSettled(TX_PARKS.map(async p => {
    const r = await scrapeTXParkAlerts(p.slug);
    if (r.headings == null) throw new Error("tx-park scrape failed: " + p.slug);
    const d = deriveTXPark(r.headings, r.body || "");
    return {
      id: "txsp-" + p.slug, name: p.name, state: "TX", county: p.county || null,
      lat: p.lat, lon: p.lon,
      status: d.status, reason: d.reason,
      counts: { partial_closure: d.status === "partially_closed" ? 1 : 0, full_closure: d.status === "closed" ? 1 : 0, danger: 0, caution: 0, info: r.headings.length },
      alertCount: r.headings.length,
      alerts: r.headings.slice(0, 6).map(h => ({ title: h, message: "" })),
      url: r.url, source: "tx-tpwd",
    };
  }));
  const parks = settled.filter(r => r.status === "fulfilled").map(r => r.value);
  return parks.length ? parks : null;
}

// ===================== Minnesota state parks (MN DNR) =====================
// MN DNR renders park pages client-side from a JSONP endpoint. We call it
// directly, strip the wrapper, and read result.alert / .is_burning /
// .seasonal_update. One request per park.
const MN_PARK_API = "https://maps.dnr.state.mn.us/cgi-bin/compass/feature_detail.cgi";
const MN_PARKS = [
  { id: "spk00142", name: "Father Hennepin State Park", lat: 46.13805, lon: -93.48054 },
  { id: "spk00145", name: "Flandrau State Park", lat: 44.29423, lon: -94.45941 },
  { id: "spk00148", name: "Forestville/Mystery Cave State Park", lat: 43.63366, lon: -92.23064 },
  { id: "spk00151", name: "Fort Ridgely State Park", lat: 44.4479, lon: -94.72669 },
  { id: "spk00154", name: "Fort Snelling State Park", lat: 44.87137, lon: -93.19599 },
  { id: "spk00157", name: "Franz Jevne State Park", lat: 48.64169, lon: -94.0585 },
  { id: "spk00160", name: "Frontenac State Park", lat: 44.52183, lon: -92.34328 },
  { id: "spk00163", name: "George Crosby Manitou State Park", lat: 47.47945, lon: -91.12301 },
  { id: "spk00166", name: "Glacial Lakes State Park", lat: 45.54167, lon: -95.53347 },
  { id: "spk00167", name: "Glendalough State Park", lat: 46.31145, lon: -95.67996 },
  { id: "spk00172", name: "Gooseberry Falls State Park", lat: 47.13986, lon: -91.47335 },
  { id: "spk00173", name: "Grand Portage State Park", lat: 47.99893, lon: -89.59363 },
  { id: "spk00174", name: "Hayes Lake State Park", lat: 48.64387, lon: -95.54525 },
  { id: "spk00175", name: "Myre-Big Island State Park", lat: 43.64041, lon: -93.30898 },
  { id: "spk00176", name: "Hill Annex Mine State Park", lat: 47.32585, lon: -93.2775 },
  { id: "spk00177", name: "John A. Latsch State Park", lat: 44.17255, lon: -91.83834 },
  { id: "spk00178", name: "Interstate State Park", lat: 45.39492, lon: -92.66784 },
  { id: "spk00181", name: "Itasca State Park", lat: 47.25003, lon: -95.21224 },
  { id: "spk00187", name: "Jay Cooke State Park", lat: 46.66159, lon: -92.39908 },
  { id: "spk00193", name: "Judge C.R. Magney State Park", lat: 47.81741, lon: -90.05375 },
  { id: "spk00196", name: "Kilen Woods State Park", lat: 43.73218, lon: -95.0688 },
  { id: "spk00197", name: "Lac Qui Parle State Park", lat: 45.02111, lon: -95.89407 },
  { id: "spk00205", name: "Lake Bemidji State Park", lat: 47.54064, lon: -94.8358 },
  { id: "spk00208", name: "Lake Bronson State Park", lat: 48.73146, lon: -96.63468 },
  { id: "spk00211", name: "Lake Carlos State Park", lat: 46.00044, lon: -95.33295 },
  { id: "spk00214", name: "Lake Louise State Park", lat: 43.53596, lon: -92.50918 },
  { id: "spk00217", name: "Lake Maria State Park", lat: 45.31741, lon: -93.93167 },
  { id: "spk00220", name: "Lake Shetek State Park", lat: 44.09479, lon: -95.6808 },
  { id: "spk00226", name: "McCarthy Beach State Park", lat: 47.6689, lon: -93.03154 },
  { id: "spk00229", name: "Maplewood State Park", lat: 46.54998, lon: -95.95418 },
  { id: "spk00232", name: "Mille Lacs Kathio State Park", lat: 46.13541, lon: -93.72447 },
  { id: "spk00235", name: "Minneopa State Park", lat: 44.15634, lon: -94.09136 },
  { id: "spk00238", name: "Monson Lake State Park", lat: 45.31832, lon: -95.27596 },
  { id: "spk00239", name: "Moose Lake State Park", lat: 46.43637, lon: -92.73581 },
  { id: "spk00241", name: "Nerstrand Big Woods State Park", lat: 44.34177, lon: -93.09104 },
  { id: "spk00244", name: "Great River Bluffs State Park", lat: 43.93727, lon: -91.42939 },
  { id: "spk00247", name: "Old Mill State Park", lat: 48.36141, lon: -96.56557 },
  { id: "spk00250", name: "Rice Lake State Park", lat: 44.09556, lon: -93.06351 },
  { id: "spk00253", name: "St. Croix State Park", lat: 46.01201, lon: -92.61789 },
  { id: "spk00254", name: "Wild River State Park", lat: 45.52421, lon: -92.75447 },
  { id: "spk00256", name: "Sakatah Lake State Park", lat: 44.21784, lon: -93.53233 },
  { id: "spk00259", name: "Savanna Portage State Park", lat: 46.75729, lon: -93.24989 },
  { id: "spk00262", name: "Scenic State Park", lat: 47.70294, lon: -93.5668 },
  { id: "spk00263", name: "Schoolcraft State Park", lat: 47.22281, lon: -93.80659 },
  { id: "spk00265", name: "Sibley State Park", lat: 45.31129, lon: -95.00908 },
  { id: "spk00266", name: "Split Rock Lighthouse State Park", lat: 47.20565, lon: -91.36825 },
  { id: "spk00267", name: "Split Rock Creek State Park", lat: 43.89595, lon: -96.36717 },
  { id: "spk00268", name: "Temperance River State Park", lat: 47.55266, lon: -90.87747 },
  { id: "spk00269", name: "Tettegouche State Park", lat: 47.33987, lon: -91.19635 },
  { id: "spk00280", name: "Whitewater State Park", lat: 44.06292, lon: -92.0432 },
  { id: "spk00283", name: "William O'Brien State Park", lat: 45.22535, lon: -92.76357 },
  { id: "spk00284", name: "Zippel Bay State Park", lat: 48.84439, lon: -94.85 },
  { id: "spk00285", name: "Lake Vermilion-Soudan Underground Mine State Park", lat: 47.8167, lon: -92.24886 },
];

const mnStrip = h => String(h == null ? "" : h)
  .replace(/<[^>]+>/g, " ").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();

// MN visitor alerts are a grab-bag (hours, amenity notes, seasonal shutoffs).
// Only flag when a closure is tied to a real access feature in the same
// sentence — and ignore external highway/road-project closures.
const MN_FEATURE = /\b(trail|trails|road within|park road|campground|campsite|beach|boat launch|water access|entrance|overlook|tower|cave|bridge|loop|picnic area|day.?use|swimming area|backpack|cart-in|group camp)\b/i;
const MN_CLOSED = /\bclos(ed|ure|ing)\b/i;
const MN_EXTERNAL = /\b(hwy|highway|mndot|mn dot|interstate|us-?\d|state highway|county (road|hwy)|detour|spillway)\b/i;
function mnRealPartial(text) {
  return text.split(/(?<=[.!?])\s+/).some(s =>
    MN_CLOSED.test(s) && MN_FEATURE.test(s) &&
    !/reopen|will open|now open|has reopened|back open/i.test(s) &&
    !MN_EXTERNAL.test(s));
}
function deriveMNPark(alertText, seasonalText, burning) {
  if (burning) return { status: "partially_closed", reason: "Active wildfire reported in or near the park." };
  const blob = `${alertText} ${seasonalText}`;
  if (/\bpark is (now )?closed\b|\bpark (is )?closed (for the season|until|due to)\b|\bpark (has|is) permanently closed\b/i.test(blob))
    return { status: "closed", reason: "Park closure in effect." };
  if (mnRealPartial(blob) || /\bflash flood|flooding\b|\bevacuat|\bhigh water\b|\btrees? (are )?down\b/i.test(blob))
    return { status: "partially_closed", reason: "Trail, road, or area closures in effect — see the park's alert." };
  return { status: "open", reason: alertText ? "Open — visitor notes posted on the park's page." : "No alerts posted by the Minnesota DNR." };
}

async function fetchMNPark(p) {
  let res;
  try {
    res = await fetch(`${MN_PARK_API}?callback=j&id=${p.id}`,
      { headers: { "User-Agent": CRAWL_UA }, cf: { cacheTtl: 1800, cacheEverything: true } });
  } catch (_) { return null; }
  if (!res.ok) return null;
  const txt = await res.text();
  const m = txt.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  let data; try { data = JSON.parse(m ? m[1] : txt); } catch (_) { return null; }
  const r = (data && data.result) || data || {};

  const alertTxt = mnStrip(typeof r.alert === "string" ? r.alert : (r.alert && (r.alert.text || r.alert.body)));
  const su = r.seasonal_update || {};
  const seasonalTxt = ["trails", "campgrounds", "roads"].map(k => mnStrip(su[k])).filter(Boolean).join(" ");
  const burning = r.is_burning === true || r.is_burning === "true" || r.is_burning === 1 || r.is_burning === "1";

  const d = deriveMNPark(alertTxt, seasonalTxt, burning);
  const tags = [];
  if (burning) tags.push("active wildfire");
  const sumHead = mnStrip(r.alert_summary);
  if (sumHead) tags.push(sumHead.slice(0, 80));

  const pt = (r.point && (r.point["epsg:4326"] || r.point.coordinates)) || null;
  return {
    id: "mnsp-" + p.id, name: r.name || p.name, state: "MN",
    county: r.nearest_town ? "near " + r.nearest_town : null,
    lat: Array.isArray(pt) ? Number(pt[1]) : p.lat,
    lon: Array.isArray(pt) ? Number(pt[0]) : p.lon,
    status: d.status, reason: d.reason,
    counts: { partial_closure: d.status === "partially_closed" ? 1 : 0, full_closure: d.status === "closed" ? 1 : 0, danger: burning ? 1 : 0, caution: 0, info: alertTxt ? 1 : 0 },
    alertCount: alertTxt ? 1 : 0,
    alerts: alertTxt ? [{ title: sumHead || "Park visitor alert", message: alertTxt.slice(0, 400) }] : [],
    tags,
    url: `https://www.dnr.state.mn.us/state_parks/park.html?id=${p.id}`,
    source: "mn-dnr",
  };
}

async function fetchMNStateParks() {
  const settled = await Promise.allSettled(MN_PARKS.map(fetchMNPark));
  const parks = settled.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
  return parks.length ? parks : null;
}

async function get(endpoint, key, params = {}) {
  const out = []; let start = 0; const limit = 500;
  for (;;) {
    const q = new URLSearchParams({ ...params, start, limit }).toString();
    const r = await fetch(`${API}/${endpoint}?${q}`, { headers: { "X-Api-Key": key } });
    if (!r.ok) throw new Error(`${endpoint} ${r.status}`);
    const page = await r.json();
    out.push(...page.data);
    start += Number(page.limit || page.data.length || limit);
    if (start >= Number(page.total || 0) || !page.data.length) break;
  }
  return out;
}

async function rebuild(env, { notify = false } = {}) {
  const key = env.NPS_API_KEY;
  const [alerts, parks, beaches, nyParks, caParks, txParks, mnParks] = await Promise.all([
    get("alerts", key),
    get("parks", key, { fields: "operatingHours,latLong,designation,states,url" }),
    fetchNYBeaches().catch(e => { console.error("ny-beaches fetch failed:", e); return null; }),
    fetchNYStateParks().catch(e => { console.error("ny-parks fetch failed:", e); return null; }),
    fetchCAStateParks(env).catch(e => { console.error("ca-parks fetch failed:", e); return null; }),
    fetchTXStateParks().catch(e => { console.error("tx-parks fetch failed:", e); return null; }),
    fetchMNStateParks().catch(e => { console.error("mn-parks fetch failed:", e); return null; }),
  ]);
  const byPark = {};
  for (const a of alerts) (byPark[a.parkCode || ""] ||= []).push(a);
  const parksOut = parks.map(p => {
    const d = derive(p, byPark[p.parkCode] || []);
    return { parkCode: p.parkCode, fullName: p.fullName, designation: p.designation,
      states: p.states, lat: Number(p.latitude || 0), lon: Number(p.longitude || 0),
      url: p.url, status: d.status, reason: d.reason, scheduledOnly: d.scheduledOnly, counts: d.counts };
  });

  const prevRaw = await env.PARKS_KV.get("status:latest");
  const tally = { open: 0, partially_closed: 0, closed: 0 };
  for (const p of parksOut) tally[p.status]++;

  // Beaches: if this run's fetch failed, fall back to the last good cached
  // beach list rather than wiping beach data off the site on a transient error.
  let beachesOut = beaches;
  let beachStale = false;
  if (!beachesOut) {
    beachStale = true;
    try {
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      beachesOut = (prev && prev.beaches) || [];
    } catch (_) { beachesOut = []; }
  }
  const beachTally = { open: 0, closed: 0, advisory: 0, not_in_operation: 0, pending: 0 };
  for (const b of beachesOut) beachTally[b.status] = (beachTally[b.status] || 0) + 1;

  // NY state parks: same last-good fallback as beaches on a transient failure.
  let nyParksOut = nyParks;
  let nyParkStale = false;
  if (!nyParksOut) {
    nyParkStale = true;
    try { const prev = prevRaw ? JSON.parse(prevRaw) : null; nyParksOut = (prev && prev.nyParks) || []; }
    catch (_) { nyParksOut = []; }
  }
  const nyParkTally = { open: 0, partially_closed: 0, closed: 0 };
  for (const p of nyParksOut) nyParkTally[p.status] = (nyParkTally[p.status] || 0) + 1;

  // California state parks: same last-good fallback.
  let caParksOut = caParks;
  let caParkStale = false;
  if (!caParksOut) {
    caParkStale = true;
    try { const prev = prevRaw ? JSON.parse(prevRaw) : null; caParksOut = (prev && prev.caParks) || []; }
    catch (_) { caParksOut = []; }
  }
  const caParkTally = { open: 0, partially_closed: 0, closed: 0 };
  for (const p of caParksOut) caParkTally[p.status] = (caParkTally[p.status] || 0) + 1;

  // Texas + Minnesota state parks: same last-good fallback pattern.
  const withFallback = (fresh, kvKey) => {
    if (fresh) return [fresh, false];
    try { const prev = prevRaw ? JSON.parse(prevRaw) : null; return [(prev && prev[kvKey]) || [], true]; }
    catch (_) { return [[], true]; }
  };
  const [txParksOut, txParkStale] = withFallback(txParks, "txParks");
  const [mnParksOut, mnParkStale] = withFallback(mnParks, "mnParks");
  const tally3 = list => { const t = { open: 0, partially_closed: 0, closed: 0 }; for (const p of list) t[p.status] = (t[p.status] || 0) + 1; return t; };
  const txParkTally = tally3(txParksOut);
  const mnParkTally = tally3(mnParksOut);

  // ---- unified status-change diff across every source (drives notifications) ----
  const nowIndex = indexEntities({ parks: parksOut, nyParks: nyParksOut, caParks: caParksOut,
    txParks: txParksOut, mnParks: mnParksOut, beaches: beachesOut });
  let changes = [];
  try {
    const prevIndex = indexEntities(prevRaw ? JSON.parse(prevRaw) : {});
    for (const id in nowIndex) {
      const n = nowIndex[id], o = prevIndex[id];
      if (o && o.status !== n.status)
        changes.push({ id, name: n.name, from: o.status, to: n.status, reason: n.reason,
          url: n.url, lat: n.lat, lon: n.lon, scheduledOnly: n.scheduledOnly, county: n.county });
    }
  } catch (_) {}

  await env.PARKS_KV.put("status:latest", JSON.stringify({
    updated: new Date().toISOString(),
    tally, parks: parksOut,
    beachTally, beaches: beachesOut, beachStale,
    nyParkTally, nyParks: nyParksOut, nyParkStale,
    caParkTally, caParks: caParksOut, caParkStale,
    txParkTally, txParks: txParksOut, txParkStale,
    mnParkTally, mnParks: mnParksOut, mnParkStale,
  }));

  if (notify && changes.length) await notifyChanges(env, changes);
  if (changes.length) await pingIndexNow(changes);
  return { tally, count: parksOut.length, changes: changes.length,
    beachTally, beachCount: beachesOut.length, beachStale,
    nyParkTally, nyParkCount: nyParksOut.length, nyParkStale,
    caParkTally, caParkCount: caParksOut.length, caParkStale,
    txParkTally, txParkCount: txParksOut.length, txParkStale,
    mnParkTally, mnParkCount: mnParksOut.length, mnParkStale };
}

// ===================== IndexNow ===========================================
// Ping IndexNow (Bing, Yandex, Seznam, Naver…) with the specific pages whose
// status just changed, so a fresh closure gets re-crawled in minutes instead
// of on the search engines' own schedule. Key is public — it's published at
// https://parkstatus.today/<key>.txt and only proves we control the domain.
const INDEXNOW_KEY = "2a821d1da0b1eca28a37f6bbf86e301c";
const INDEXNOW_HOST = "parkstatus.today";

// Beach-hub slug — must match build-parks.js grouping ("<state>-<county>-county").
function beachCountySlug(county) {
  const c = String(county || "").trim();
  if (!c) return "";
  return ("NY-" + c + (/count(y|ies)$/i.test(c) ? "" : "-county"))
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function pingIndexNow(changes) {
  try {
    if (!changes || !changes.length) return;

    // id -> our page slug, from the deployed static list
    const slugById = {};
    try {
      const r = await fetch(SITE + "/parks.json", { cf: { cacheTtl: 300 } });
      if (r.ok) { const d = await r.json(); for (const p of d.parks || []) slugById[p.id] = p.slug; }
    } catch (_) {}

    const urls = new Set([SITE + "/", SITE + "/park/"]);
    let beachTouched = false;
    for (const ch of changes) {
      if (String(ch.id).startsWith("ny-")) {
        beachTouched = true;
        const s = beachCountySlug(ch.county);
        if (s) urls.add(SITE + "/beach/" + s + "/");
      } else {
        const s = slugById[ch.id];
        if (s) urls.add(SITE + "/park/" + s + "/");
      }
    }
    if (beachTouched) urls.add(SITE + "/beach/");

    const urlList = [...urls].slice(0, 9000);
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: INDEXNOW_HOST, key: INDEXNOW_KEY, keyLocation: SITE + "/" + INDEXNOW_KEY + ".txt", urlList }),
    });
    console.log("indexnow:", res.status, urlList.length, "urls,", changes.length, "changes");
  } catch (e) {
    console.error("indexnow failed:", e);
  }
}

// ===================== subscribers =========================================
const STATUS_TEXT_X = { ...STATUS_TEXT, no_data: "no data" };
const mapBeachStatus = s => s === "advisory" ? "partially_closed" : (s === "open" || s === "closed") ? s : "no_data";

// Flatten every status-bearing entity into { id -> {status, name, lat, lon, ...} }.
function indexEntities(b) {
  const m = {};
  const add = (arr, pfx, namef, statusf) => {
    for (const e of arr || []) {
      const raw = e.parkCode || e.id;
      if (!raw) continue;
      const id = pfx + raw;
      m[id] = { id, name: namef(e), status: statusf ? statusf(e.status) : e.status,
        reason: e.reason || "", lat: Number(e.lat), lon: Number(e.lon),
        url: e.url || SITE, scheduledOnly: !!e.scheduledOnly, county: e.county || "" };
    }
  };
  add(b.parks, "nps:", e => e.fullName);
  add(b.nyParks, "", e => e.name);
  add(b.caParks, "", e => e.name);
  add(b.txParks, "", e => e.name);
  add(b.mnParks, "", e => e.name);
  add(b.beaches, "", e => e.name, mapBeachStatus);
  return m;
}

function haversineMi(la1, lo1, la2, lo2) {
  if ([la1, lo1, la2, lo2].some(v => typeof v !== "number" || isNaN(v))) return Infinity;
  const R = 3958.8, toR = Math.PI / 180;
  const dLa = (la2 - la1) * toR, dLo = (lo2 - lo1) * toR;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * toR) * Math.cos(la2 * toR) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Normalize old ("all" | "<parkCode>") and new (object) scope shapes.
function normScope(scope) {
  if (!scope) return { kind: "all" };
  if (typeof scope === "string") return scope === "all" ? { kind: "all" } : { kind: "parks", parks: ["nps:" + scope] };
  return scope;
}

// Does this change match a subscriber's scope + date window?  (scheduled-hours
// closures are filtered out by the caller.)
function changeMatchesSub(ch, sub) {
  const sc = normScope(sub.scope);
  const todayISO = new Date().toISOString().slice(0, 10);
  if (sc.from && todayISO < sc.from) return false;
  if (sc.to && todayISO > sc.to) return false;
  if (sc.kind === "all") return true;
  if (sc.kind === "parks") return Array.isArray(sc.parks) && sc.parks.includes(ch.id);
  if (sc.kind === "geo") return haversineMi(sc.lat, sc.lon, ch.lat, ch.lon) <= (sc.radiusMi || 50);
  return false;
}

async function listSubs(env, prefix) {
  const out = []; let cursor;
  do {
    const res = await env.PARKS_KV.list({ prefix, cursor });
    for (const k of res.keys) {
      const v = await env.PARKS_KV.get(k.name);
      if (v) { try { const o = JSON.parse(v); o._key = k.name; out.push(o); } catch (_) {} }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

async function notifyChanges(env, changes) {
  // Never notify for a purely scheduled-operating-hours closure.
  const real = changes.filter(ch => !(ch.to === "closed" && ch.scheduledOnly));
  if (!real.length) return;
  const [emailSubs, pushSubs] = await Promise.all([listSubs(env, "sub:email:"), listSubs(env, "sub:push:")]);
  for (const ch of real) {
    const c = { ...ch, fullName: ch.name, parkCode: ch.id };
    for (const s of emailSubs.filter(sub => changeMatchesSub(ch, sub)))
      await sendEmail(env, s.email, `${ch.name} is now ${STATUS_TEXT_X[ch.to]}`, emailHtml(c)).catch(() => {});
    for (const s of pushSubs.filter(sub => changeMatchesSub(ch, sub))) {
      try {
        const st = await sendPush(env, s.subscription, {
          title: `${ch.name} is now ${STATUS_TEXT_X[ch.to]}`,
          body: ch.reason || "", url: ch.url || SITE, tag: ch.id });
        if (st === 404 || st === 410) await env.PARKS_KV.delete(s._key);
      } catch (_) {}
    }
  }
}

function emailHtml(ch) {
  const color = { open: "#14785d", partially_closed: "#9a6a0f", closed: "#ee263b" }[ch.to] || "#0b1b35";
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0e1726">
    <p style="font:700 12px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#667185;margin:0 0 6px">Park Status Today</p>
    <h1 style="font-family:'Arial Black',Arial,sans-serif;font-size:22px;margin:0 0 4px;color:${color}">${esc(ch.fullName)} is now ${STATUS_TEXT_X[ch.to] || ch.to}.</h1>
    <p style="font-size:15px;color:#33405a;margin:8px 0 16px">${esc(ch.reason || "")}</p>
    <p style="font-size:14px;margin:0 0 20px">Previously: ${STATUS_TEXT_X[ch.from] || ch.from}.</p>
    <a href="${esc(ch.url || SITE)}" style="background:#0b1b35;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 16px;border-radius:9px;display:inline-block">View the official park page →</a>
    <p style="font-size:11px;color:#8a93a3;margin:24px 0 0">You're receiving this because you follow this park on parkstatus.today. Status is our reading of NPS data — always confirm with the park.</p>
  </div>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ===================== email (Resend) ======================================
async function sendEmail(env, to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
  });
  return r.status;
}

// ===================== Web Push (RFC 8291 aes128gcm + VAPID) ================
const enc = new TextEncoder();
const b64uToBytes = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const bytesToB64u = b => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const jsonB64u = o => bytesToB64u(enc.encode(JSON.stringify(o)));
const cat = (...as) => { let n = as.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n), i = 0; for (const a of as) { o.set(a, i); i += a.length; } return o; };
const pubToXY = p => ({ x: bytesToB64u(p.slice(1, 33)), y: bytesToB64u(p.slice(33, 65)) });
async function hmac(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, dataBytes));
}
async function importEcdhPublic(pub) {
  const { x, y } = pubToXY(pub);
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
}
async function encryptPayload(ua_public, auth_secret, payload) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const as_public = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const uaKey = await importEcdhPublic(ua_public);
  const ecdh_secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, kp.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const PRK_key = await hmac(auth_secret, ecdh_secret);
  const key_info = cat(enc.encode("WebPush: info"), new Uint8Array([0]), ua_public, as_public);
  const IKM = await hmac(PRK_key, cat(key_info, new Uint8Array([1])));
  const PRK = await hmac(salt, IKM);
  const CEK = (await hmac(PRK, cat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const NONCE = (await hmac(PRK, cat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey("raw", CEK, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: NONCE, tagLength: 128 }, aesKey, cat(payload, new Uint8Array([2]))));
  const header = cat(salt, new Uint8Array([0, 0, 0x10, 0x00]), new Uint8Array([as_public.length]), as_public);
  return cat(header, ct);
}
async function vapidAuth(env, endpoint) {
  const origin = new URL(endpoint).origin;
  const { x, y } = pubToXY(b64uToBytes(VAPID_PUBLIC));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE, x, y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const si = `${jsonB64u({ typ: "JWT", alg: "ES256" })}.${jsonB64u({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(si)));
  return `vapid t=${si}.${bytesToB64u(sig)}, k=${VAPID_PUBLIC}`;
}
async function sendPush(env, sub, payloadObj) {
  const ua_public = b64uToBytes(sub.keys.p256dh);
  const auth = b64uToBytes(sub.keys.auth);
  const body = await encryptPayload(ua_public, auth, enc.encode(JSON.stringify(payloadObj)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
               Urgency: "normal", Authorization: await vapidAuth(env, sub.endpoint) },
    body,
  });
  return res.status;
}

// ===================== HTTP ================================================
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const readJSON = async req => { try { return await req.json(); } catch (_) { return null; } };
async function sha1(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Validate a subscriber scope object from the signup form.
function sanitizeScope(raw) {
  if (typeof raw === "string") return raw === "all" ? { kind: "all" } : { kind: "parks", parks: ["nps:" + raw.slice(0, 40)] };
  if (!raw || typeof raw !== "object") return { kind: "all" };
  const s = { kind: ["all", "parks", "geo"].includes(raw.kind) ? raw.kind : "all" };
  if (raw.label) s.label = String(raw.label).slice(0, 80);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.from || "")) s.from = raw.from;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.to || "")) s.to = raw.to;
  if (s.kind === "parks") s.parks = (Array.isArray(raw.parks) ? raw.parks : []).slice(0, 50).map(x => String(x).slice(0, 60));
  if (s.kind === "geo") {
    s.lat = Number(raw.lat); s.lon = Number(raw.lon);
    s.radiusMi = Math.min(300, Math.max(5, Number(raw.radiusMi) || 50));
    if (isNaN(s.lat) || isNaN(s.lon)) return { kind: "all" };
  }
  return s;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(rebuild(env, { notify: true })); },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const token = url.searchParams.get("token");

    if (url.pathname === "/rebuild" && token === env.REBUILD_TOKEN) return json(await rebuild(env, { notify: false }));

    // Manual IndexNow ping — submits the hub pages (used for first-time
    // verification and after a bulk site change). /indexnow?token=..
    if (url.pathname === "/indexnow" && token === env.REBUILD_TOKEN) {
      const urlList = [SITE + "/", SITE + "/park/", SITE + "/beach/", SITE + "/sitemap.xml"];
      try {
        const r = await fetch("https://api.indexnow.org/indexnow", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: INDEXNOW_HOST, key: INDEXNOW_KEY, keyLocation: SITE + "/" + INDEXNOW_KEY + ".txt", urlList }),
        });
        return json({ ok: r.status, submitted: urlList });
      } catch (e) { return json({ error: String(e) }, 502); }
    }

    // Geocode a city / state / ZIP to lat,lon (used by search + signup).
    if (url.pathname === "/geocode") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
      if (!q) return json({ error: "missing q" }, 400);
      // Anonymous World Geocoder (non-storage display use) — no token needed;
      // the ARCGIS_API_KEY doesn't carry geocoding scope anyway.
      const g = new URLSearchParams({
        f: "json", singleLine: q, maxLocations: "1", countryCode: "USA",
        category: "Address,Postal,Populated Place,Region,Subregion",
      });
      try {
        const r = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?" + g);
        const d = await r.json();
        const c = (d.candidates || [])[0];
        if (!c || !c.location) return json({ error: "no match" }, 404);
        return json({ lat: c.location.y, lon: c.location.x, label: c.address || q, score: c.score || 0 });
      } catch (_) { return json({ error: "geocode failed" }, 502); }
    }

    if (url.pathname === "/stats" && token === env.REBUILD_TOKEN) {
      const [emailSubs, pushSubs] = await Promise.all([listSubs(env, "sub:email:"), listSubs(env, "sub:push:")]);
      const blob = await env.PARKS_KV.get("status:latest");
      const tally = blob ? JSON.parse(blob).tally : null;
      return json({ email_subscribers: emailSubs.length, push_subscribers: pushSubs.length, tally });
    }

    // Manual delivery test: /test-notify?token=..&email=you@x.com
    if (url.pathname === "/test-notify" && token === env.REBUILD_TOKEN) {
      const result = { email: null, push: null };
      const to = url.searchParams.get("email");
      const demo = { fullName: "Yellowstone National Park", from: "open", to: "partially_closed",
        reason: "Test alert — this confirms notifications are working.", url: SITE };
      if (to && EMAIL_RE.test(to)) result.email = await sendEmail(env, to, "Test alert from Park Status Today", emailHtml(demo)).catch(e => String(e));
      const pushSubs = await listSubs(env, "sub:push:");
      result.push = [];
      for (const s of pushSubs) {
        try {
          const st = await sendPush(env, s.subscription, { title: "Test alert — Park Status Today", body: "Notifications are working.", url: SITE, tag: "test" });
          if (st === 404 || st === 410) await env.PARKS_KV.delete(s._key);
          result.push.push(st);
        } catch (e) { result.push.push(String(e)); }
      }
      return json({ ok: true, ...result });
    }

    if (url.pathname === "/subscribe" && req.method === "POST") {
      const b = await readJSON(req);
      if (!b || !EMAIL_RE.test(b.email || "")) return json({ ok: false, error: "invalid email" }, 400);
      const email = b.email.toLowerCase().slice(0, 200);
      const scope = sanitizeScope(b.scope);
      await env.PARKS_KV.put("sub:email:" + email, JSON.stringify({ email, scope, ts: new Date().toISOString() }));
      return json({ ok: true, scope });
    }

    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      const b = await readJSON(req);
      const sub = b && b.subscription;
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ ok: false, error: "invalid subscription" }, 400);
      const scope = sanitizeScope(b.scope);
      const id = await sha1(sub.endpoint);
      await env.PARKS_KV.put("sub:push:" + id, JSON.stringify({ subscription: sub, scope, ts: new Date().toISOString() }));
      return json({ ok: true, scope });
    }

    const data = await env.PARKS_KV.get("status:latest");
    return new Response(data || '{"parks":[]}', { headers: CORS });
  },
};

export { classify, derive, deriveNYPark, deriveTXPark, deriveMNPark, normalizeCAParks, fetchArcGIS,
  nextScheduledOpen, indexEntities, changeMatchesSub, sanitizeScope, haversineMi,
  rebuild, encryptPayload, b64uToBytes, bytesToB64u };
