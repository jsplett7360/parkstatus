#!/usr/bin/env node
/**
 * build-parks.js — generate a static status + info page per park, plus the
 * enrichment JSON the homepage card loads.
 *
 *   NPS_API_KEY=xxxx node build-parks.js
 *
 * Sources (all free):
 *   - Worker status blob  -> current open/partial/closed for every entity
 *   - NPS Data API /parks  -> description, address, phone, hours, photo, directions (national parks)
 *   - Wikipedia REST       -> about/history extract + photo + article link (all parks)
 *
 * Writes:
 *   public_html/park/<slug>/index.html   (one per park: national + NY/CA/TX/MN state)
 *   public_html/park/index.html          (A–Z directory, all parks)
 *   public_html/park/park.css
 *   public_html/parks.json               (slim list)
 *   public_html/parks-enriched.json      (id -> {description, history, address, hours, photo, ...})
 *   public_html/sitemap.xml
 *
 * Rebuild daily; live status still updates hourly on top of the baked copy.
 */

const fs = require("fs");
const path = require("path");

const API = process.env.STATUS_API || "https://parkstatus-api.parkstatus.workers.dev/";
const NPS_KEY = process.env.NPS_API_KEY || "";
const SITE = "https://parkstatus.today";
const OUT = path.join(__dirname, "public_html");
const CORP_LINE = "© 2026 The Association of Recreation and District Spaces Corp. · A property of Little Ideas Big Story, Corp.";
const PARK_DIR = path.join(OUT, "park");
const UA = "ParkStatusToday/1.0 (+https://parkstatus.today; daily static build)";

const INDEXERNOW =
  '<!-- IndexerNow pixel -->\n<script>(function(){try{var q=new URLSearchParams(location.search);navigator.sendBeacon("https://www.indexernow.com/api/pixel/rFr2Mq0S1bpnXV_rmsqgDYT0",JSON.stringify({path:location.pathname,referrer:document.referrer||"",utm:{source:q.get("utm_source")||"",medium:q.get("utm_medium")||"",campaign:q.get("utm_campaign")||""}}));}catch(e){}})();<\/script>';

const STATUS_LABEL = { open: "Open", partially_closed: "Partially closed", closed: "Closed", no_data: "No data" };
const STATUS_CLASS = { open: "open", partially_closed: "partial", closed: "closed", no_data: "nodata" };
const STATUS_SENTENCE = { open: "is open", partially_closed: "is partially closed", closed: "is closed", no_data: "has no current status" };
const DOW = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DOW_LABEL = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

// Curated timed-entry / vehicle-reservation requirements, keyed by entity id
// (e.g. "nps:romo"). Best-effort for the current season — verify each spring.
const RESERVATIONS = (() => { try { return require("./reservations.json"); } catch (_) { return {}; } })();

// Curated seasonal park-road data (see roads.json). Rows publish as /road/<slug>/
// pages only when datesReviewed === true.
const ROADS = (() => { try { return require("./roads.json"); } catch (_) { return {}; } })();

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtPhone = (s) => { const d = String(s || "").replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`
    : (d.length === 11 && d[0] === "1") ? `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}` : s; };
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s\S*$/, "") + "…" : s; };

function slugify(s) {
  return String(s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (_) { out[idx] = null; } }
  }));
  return out;
}

// ===================== shared status helpers ==============================
// Beach vocab -> the 4-status model the whole site uses.
const beach4 = (s) => (s === "advisory" ? "partially_closed" : (s === "open" || s === "closed") ? s : "no_data");
const BEACH_CLASS = { open: "open", partially_closed: "partial", closed: "closed", no_data: "nodata" };
const BEACH_LABEL = { open: "Open", advisory: "Water quality advisory", closed: "Closed to swimming", not_in_operation: "Not in operation", pending: "Status set by another agency" };

// Combined open/partial/closed/no-data count across every source in the blob.
function combinedTally(data) {
  const t = { open: 0, partially_closed: 0, closed: 0, no_data: 0 };
  const add = (arr, mk) => (arr || []).forEach((x) => { const s = mk ? mk(x.status) : x.status; if (s in t) t[s]++; });
  add(data.parks); add(data.nyParks); add(data.caParks); add(data.txParks); add(data.mnParks);
  add(data.flParks); add(data.waParks); add(data.usfs);
  add(data.beaches, beach4);
  return t;
}

// "Sep 2" in UTC — the baked "updated" label (JS swaps in the viewer's local time).
const fmtUpd = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtLong = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

// Site-wide status strip, with the day's counts baked in (not "—").
function stripHtml(t, iso) {
  const n = t || { open: "—", partially_closed: "—", closed: "—", no_data: "—" };
  return `<div class="strip"><div class="wrap">
  <span class="k"><span class="dot open"></span><b id="s-open">${n.open}</b>&nbsp;open</span>
  <span class="k"><span class="dot partial"></span><b id="s-partial">${n.partially_closed}</b>&nbsp;partially closed</span>
  <span class="k"><span class="dot closed"></span><b id="s-closed">${n.closed}</b>&nbsp;closed</span>
  <span class="k"><span class="dot nodata"></span><b id="s-nodata">${n.no_data}</b>&nbsp;no data</span>
  <span class="upd"><span id="s-upd">updated ${fmtUpd(iso)}</span> · <a href="/#map">view map →</a></span>
</div></div>`;
}

// schema.org openingHoursSpecification, best-effort parse of "9:00AM - 5:00PM" rows.
const SCHEMA_DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
function to24h(t) {
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp])[Mm]$/.exec(String(t).trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/[Pp]/.test(m[3])) h += 12;
  return String(h).padStart(2, "0") + ":" + m[2];
}
function hoursSpec(hours) {
  if (!hours || !hours.rows) return [];
  const out = [];
  for (const r of hours.rows) {
    const mm = /^\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*(?:[-–—]|to)\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*$/i.exec(r.h || "");
    if (!mm) continue;
    const o = to24h(mm[1]), c = to24h(mm[2]);
    if (!o || !c) continue;
    out.push({ "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/" + SCHEMA_DAY[r.d], opens: o, closes: c });
  }
  return out;
}

// ===================== Wikipedia enrichment ================================
// Anonymous Wikipedia REST wants low concurrency; throttle + retry 429s.
const WIKI_OK = /\b(national park|state park|state historic|state natural|nature reserve|state recreation|national monument|national historic|national forest|national preserve|national reserve|national seashore|national lakeshore|national memorial|national recreation|national battlefield|national military|national parkway|national scenic|protected area|park in|reserve in|forest in|preserve in|island in|lake in|beach in|river in|historic site|recreation area|scenic|wilderness|monument in|memorial in|battlefield)\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wget(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (r.status === 429) { await sleep(1500 + i * 1500); continue; }
    return r;
  }
  return null;
}
async function wikiSearch(q) {
  const r = await wget("https://en.wikipedia.org/w/api.php?format=json&action=query&list=search&srlimit=3&srsearch=" + encodeURIComponent(q));
  if (!r || !r.ok) return [];
  const d = await r.json();
  return (d.query && d.query.search || []).map((x) => x.title);
}
async function wikiSummary(title) {
  const r = await wget("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(String(title).replace(/ /g, "_")));
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}
function goodSummary(s) {
  if (!s || s.type !== "standard") return null;
  if ((s.extract || "").length < 120) return null;
  if (!WIKI_OK.test((s.description || "") + " " + (s.extract || ""))) return null;
  return {
    history: clip(s.extract, 900),
    wiki: (s.content_urls && s.content_urls.desktop && s.content_urls.desktop.page) || null,
    photo: (s.thumbnail && s.thumbnail.source) || null,
  };
}
async function enrichWikipedia(name) {
  try {
    await sleep(60 + Math.random() * 160);
    // 1) title == name (common case, 1 request)
    let g = goodSummary(await wikiSummary(name));
    if (g) return g;
    // 2) exact-phrase search
    for (const t of (await wikiSearch('"' + name + '"')).slice(0, 2)) {
      g = goodSummary(await wikiSummary(t));
      if (g) return g;
    }
    // 3) loose search
    for (const t of (await wikiSearch(name)).slice(0, 1)) {
      g = goodSummary(await wikiSummary(t));
      if (g) return g;
    }
  } catch (_) {}
  return null;
}

// ===================== NPS rich fields =====================================
async function npsRich() {
  if (!NPS_KEY) { console.warn("  (no NPS_API_KEY — national parks get Wikipedia-only enrichment)"); return {}; }
  const fields = "description,addresses,contacts,operatingHours,images,directionsInfo,weatherInfo,entranceFees,url,fullName";
  const byCode = {};
  let start = 0;
  for (;;) {
    const u = `https://developer.nps.gov/api/v1/parks?fields=${fields}&limit=200&start=${start}&api_key=${NPS_KEY}`;
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("NPS " + r.status);
    const d = await r.json();
    for (const p of d.data) byCode[p.parkCode] = p;
    start += d.data.length;
    if (start >= Number(d.total) || !d.data.length) break;
  }
  return byCode;
}

// NPS alerts for a set of parkCodes, grouped by code. Same pagination as npsRich().
// Used only for road-status Tier B; returns {} with no key.
async function npsAlerts(parkCodes) {
  if (!NPS_KEY || !parkCodes.length) return {};
  const byPark = {};
  parkCodes.forEach((c) => (byPark[c] = []));
  let start = 0;
  for (;;) {
    const u = `https://developer.nps.gov/api/v1/alerts?parkCode=${parkCodes.join(",")}&limit=50&start=${start}&api_key=${NPS_KEY}`;
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("NPS alerts " + r.status);
    const d = await r.json();
    for (const a of d.data || []) {
      if (byPark[a.parkCode]) byPark[a.parkCode].push({
        title: a.title || "", description: a.description || "",
        category: a.category || "", date: a.lastIndexedDate || "",
      });
    }
    start += (d.data || []).length;
    if (start >= Number(d.total) || !(d.data || []).length) break;
  }
  return byPark;
}

// Tier B / Tier C road status. `parkStatusById` is the Worker blob's per-park
// status map, used only for the full-park-closure cascade.
function roadStatus(road, alertsByPark, parkStatusById) {
  const CLS = { open: "open", "partially open": "partial", closed: "closed", seasonal: "nodata" };
  const inSeason = () => {
    // crude: seasonal roads are "in season" June–September
    const m = new Date().getUTCMonth();
    return m >= 5 && m <= 8;
  };

  // --- Tier B: match this road against its NPS parent(s)' alerts ---
  const npsParents = (road.parentIds || []).filter((p) => p.startsWith("nps:")).map((p) => p.slice(4));
  if (npsParents.length && NPS_KEY) {
    // full-park closure cascades to "closed"
    for (const code of npsParents) {
      if ((parkStatusById["nps:" + code] || "") === "closed") {
        return { tier: "B", status: "closed", cls: "closed",
          reason: `${road.parentNames || "The park"} is closed.`, date: "" };
      }
    }
    const nameNeedle = road.name.toLowerCase().replace(/\s+(road|highway|drive|parkway)$/i, "").trim();
    const routeRe = road.designation
      ? new RegExp("\\b" + road.designation.replace(/[^0-9A-Za-z]/g, "-?") + "\\b", "i") : null;
    const cutoff = Date.now() - 180 * 864e5;
    let hit = null;
    for (const code of npsParents) {
      for (const a of alertsByPark[code] || []) {
        if (a.date && Date.parse(a.date) < cutoff) continue;
        const hay = (a.title + " " + a.description).toLowerCase();
        const nameMatch = nameNeedle.length > 4 && hay.includes(nameNeedle);
        const routeMatch = routeRe && routeRe.test(a.title + " " + a.description);
        if (!nameMatch && !routeMatch) continue;
        const t = hay;
        let st;
        if (/(re-?open|now open|has opened|is open)/.test(t) && !/clos/.test(t.split(/re-?open|now open/)[0] || "")) st = "open";
        else if (a.category === "Park Closure" || (/clos(e|ed|ure)/.test(t) && !/(partial|one lane|single lane|nightly|overnight|lane closure|delay)/.test(t))) st = "closed";
        else if (/(partial|one lane|single lane|nightly|overnight|delay|construction|reduced)/.test(t)) st = "partially open";
        else if (/open/.test(t)) st = "open";
        else st = "partially open";
        const rank = { open: 0, "partially open": 1, closed: 2 };
        if (!hit || rank[st] > rank[hit.status]) hit = { status: st, reason: a.title || clip(a.description, 160), date: a.date };
      }
    }
    if (hit) return { tier: "B", status: hit.status, cls: CLS[hit.status], reason: hit.reason, date: hit.date };
  }

  // --- Tier C: seasonal statement / year-round statement ---
  if (road.seasonal) {
    if (inSeason()) {
      return { tier: "C", status: "open", cls: "open",
        reason: `${road.name} is normally open at this time of year. We don't have a live feed for it — confirm with the official status page.`, date: "" };
    }
    return { tier: "C", status: "seasonal", cls: "nodata",
      reason: `${road.name} is closed for the winter. It typically reopens ${road.typicalOpen || "in late spring"}.`, date: "" };
  }
  return { tier: "C", status: "open", cls: "open",
    reason: (road.accessNote || `${road.name} is normally open year-round; sections can close in winter weather.`).split(". ")[0] + ".", date: "" };
}
function npsAddress(p) {
  const a = (p.addresses || []).find((x) => x.type === "Physical") || (p.addresses || [])[0];
  if (!a) return "";
  return [a.line1, a.line2, a.line3].filter(Boolean).join(", ") +
    (a.city ? `, ${a.city}` : "") + (a.stateCode ? `, ${a.stateCode}` : "") + (a.postalCode ? ` ${a.postalCode}` : "");
}
function npsHours(p) {
  const g = (p.operatingHours || [])[0];
  if (!g || !g.standardHours) return null;
  const rows = DOW.map((d) => ({ d: DOW_LABEL[d], h: (g.standardHours[d] || "").trim() || "—" }));
  if (rows.every((r) => r.h === "—")) return null;
  return { rows, note: clip(g.name || g.description || "", 140) };
}

// NPS `entranceFees` is an array of { title, cost, description } tiers, plus a
// separate free-entrance-days concept. Reduce it to one headline the page can
// bake, or { free:true } for the many fee-free units.
function npsFee(p) {
  const fees = Array.isArray(p && p.entranceFees) ? p.entranceFees : [];
  const num = (f) => parseFloat(String((f && f.cost) || "").replace(/[^0-9.]/g, "")) || 0;
  const url = (p && p.feesAtWorkUrl) || (p && p.url) || "";
  if (!fees.length) return null;                       // no data — say nothing
  const paid = fees.filter((f) => num(f) > 0);
  if (!paid.length) return { free: true, url };         // all $0 — a valid, searched answer
  const vehicle = paid.find((f) => /vehicle/i.test(f.title || "")) || paid[0];
  const person = paid.find((f) => /per[- ]?person|individual|bicycle|on foot/i.test(f.title || ""));
  const parts = [`$${num(vehicle).toFixed(0)} per vehicle`];
  if (person) parts.push(`$${num(person).toFixed(0)} per person`);
  const dm = /(?:valid|good)\s+(?:for\s+)?(\d+)\s*days?/i.exec((vehicle && vehicle.description) || "");
  return { free: false, display: parts.join(", "), validDays: dm ? Number(dm[1]) : null,
    note: clip((vehicle && vehicle.description) || "", 180), url };
}

// ===================== assemble entities ===================================
function statesText(e) {
  return e.states || e.state || "";
}
function firstState(e) {
  return (statesText(e).split(",")[0] || "").trim();
}

function collectEntities(data) {
  const out = [];
  const seen = new Map();
  const slug = (name, fallback) => {
    let base = slugify(name) || fallback;
    let s = base, n = 2;
    while (seen.has(s)) s = base + "-" + n++;
    seen.set(s, true);
    return s;
  };
  for (const p of data.parks || []) {
    if (!p.parkCode || !p.fullName) continue;
    out.push({
      id: "nps:" + p.parkCode, code: p.parkCode, source: "nps",
      name: p.fullName, kind: p.designation || "National Park Service site",
      states: p.states || "", lat: p.lat, lon: p.lon, url: p.url,
      status: p.status, reason: p.reason, scheduledOnly: p.scheduledOnly, counts: p.counts,
      slug: slug(p.fullName, p.parkCode),
    });
  }
  const addState = (arr, src, kindDefault) => {
    for (const p of arr || []) {
      if (!p.id || !p.name) continue;
      out.push({
        id: p.id, source: src, name: p.name,
        kind: p.designation || kindDefault, states: p.state || "",
        lat: p.lat, lon: p.lon, url: p.url,
        status: p.status, reason: p.reason, counts: p.counts, county: p.county || "",
        slug: slug(p.name, p.id),
      });
    }
  };
  addState(data.nyParks, "ny", "New York State Park");
  addState(data.caParks, "ca", "California State Park");
  addState(data.txParks, "tx", "Texas State Park");
  addState(data.mnParks, "mn", "Minnesota State Park");
  addState(data.flParks, "fl", "Florida State Park");
  addState(data.waParks, "wa", "Washington State Park");
  addState(data.usfs, "usfs", "National Forest");
  return out;
}

// ===================== national forest boundaries =========================
// Build forests.json: one simplified footprint per National Forest, used by the
// Worker to test whether an active wildfire perimeter falls in/near the forest.
// USFS EDW geometry is heavily fragmented (thousands of tiny inholding parcels),
// so we drop small sub-polygons and Douglas-Peucker each kept ring.
const FS_BOUNDARIES = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0/query";

function ringArea(r) { // signed area (shoelace), degrees^2 — magnitude only used for ranking
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
  return Math.abs(a) / 2;
}
function bboxOf(pts) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of pts) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}
function dp(ring, tol) { // Douglas-Peucker on a closed ring (lon/lat degrees)
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length); keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = 0, idx = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      const t = ((px - ax) * dx + (py - ay) * dy) / len2;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d > far) { far = d; idx = i; }
    }
    if (idx !== -1 && far > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}
// Resolve a forest's real fs.usda.gov landing page by trying short-code guesses.
async function resolveForestUrl(name) {
  const base = name.replace(/\s+National\s+(Forests?|Grasslands?|Recreation Area|Scenic Area)\b.*$/i, "")
    .replace(/\s+(Management Unit|Ranger District)\b.*$/i, "").trim();
  const words = base.split(/[\s,]+/).filter(Boolean);
  const cands = [...new Set([
    base.toLowerCase().replace(/[^a-z0-9]/g, ""),
    base.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    words[0] ? words[0].toLowerCase().replace(/[^a-z0-9]/g, "") : "",
    words.filter(w => !/^(and|the|of)$/i.test(w)).map(w => w[0]).join("").toLowerCase(),
  ].filter(c => c && c.length >= 3))];
  // A valid short code redirects to a region path like /r05/tahoe (the page
  // itself 403s to non-browser agents — that's fine, we only want the URL).
  for (const c of cands) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch("https://www.fs.usda.gov/" + c, { headers: { "User-Agent": UA }, redirect: "follow" });
        const seg = new URL(r.url).pathname.split("/").filter(Boolean);
        if (r.status !== 404 && (/^r\d\d$/.test(seg[0]) || (r.ok && seg.length >= 1 && seg[0] !== "visit")))
          return r.url.replace(/[#?].*$/, "");
        if (r.status === 404) break; // definitive: this code is wrong
      } catch (_) { await sleep(400); }
    }
  }
  return "https://www.fs.usda.gov/visit/forests";
}

async function buildForests() {
  const p = new URLSearchParams({
    where: "1=1", outFields: "FORESTNAME,REGION,GIS_ACRES",
    returnGeometry: "true", geometryPrecision: "3", maxAllowableOffset: "0.02",
    outSR: "4326", f: "geojson",
  });
  const r = await wget(FS_BOUNDARIES + "?" + p);
  if (!r || !r.ok) throw new Error("USFS boundaries fetch failed " + (r && r.status));
  const gj = await r.json();
  const forests = [];
  for (const ft of gj.features || []) {
    const name = (ft.properties.forestname || "").trim();
    if (!name || !ft.geometry) continue;
    // normalize to a list of outer rings
    const rings = ft.geometry.type === "Polygon" ? [ft.geometry.coordinates[0]]
      : ft.geometry.type === "MultiPolygon" ? ft.geometry.coordinates.map((poly) => poly[0]) : [];
    if (!rings.length) continue;
    const scored = rings.map((r) => ({ r, a: ringArea(r) })).sort((x, y) => y.a - x.a);
    const maxA = scored[0].a || 1e-9;
    const polys = scored.filter((x, i) => i === 0 || x.a >= maxA * 0.02)
      .map((x) => dp(x.r, 0.02))
      .filter((r) => r.length >= 4);
    if (!polys.length) continue;
    const bbox = bboxOf(polys.flat());
    const big = polys[0];
    const c = big.reduce((s, pt) => [s[0] + pt[0], s[1] + pt[1]], [0, 0]).map((v) => v / big.length);
    forests.push({
      id: "usfs-" + slugify(name), slug: slugify(name), name,
      region: ft.properties.region || "", acres: Math.round(ft.properties.gis_acres || 0),
      lat: +c[1].toFixed(4), lon: +c[0].toFixed(4),
      bbox: bbox.map((v) => +v.toFixed(3)),
      polys: polys.map((r) => r.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)])),
    });
  }
  const urls = await mapPool(forests, 4, (f) => resolveForestUrl(f.name));
  forests.forEach((f, i) => { f.url = urls[i] || "https://www.fs.usda.gov/visit/forests"; });
  forests.sort((a, b) => a.name.localeCompare(b.name));
  return forests;
}

// ===================== per-page HTML =======================================
function visitorBlock(en) {
  if (!en) return "";
  const bits = [];
  if (en.address) bits.push(`<div class="vi"><b>Address</b><span>${esc(en.address)}</span></div>`);
  if (en.phone) bits.push(`<div class="vi"><b>Phone</b><a href="tel:${esc(en.phone.replace(/[^\d+]/g,""))}">${esc(fmtPhone(en.phone))}</a></div>`);
  if (en.website) bits.push(`<div class="vi"><b>Website</b><a href="${esc(en.website)}" target="_blank" rel="noopener">${esc(en.website.replace(/^https?:\/\//,"").replace(/\/$/,""))} ↗</a></div>`);
  if (en.hours && en.hours.rows) {
    bits.push(`<div class="vi"><b>Hours</b><table class="hrs">${en.hours.rows.map(r=>`<tr><td>${r.d}</td><td>${esc(r.h)}</td></tr>`).join("")}</table>${en.hours.note?`<span class="hn">${esc(en.hours.note)}</span>`:""}</div>`);
  }
  if (en.fee) {
    const f = en.fee;
    const txt = f.free ? "Free — no entrance fee"
      : `${esc(f.display)}${f.validDays ? `, valid ${f.validDays} days` : ""}`;
    bits.push(`<div class="vi"><b>Entrance fee</b><span>${txt}${f.url ? ` · <a href="${esc(f.url)}" target="_blank" rel="noopener">fee details ↗</a>` : ""}</span></div>`);
  }
  if (en.reservation) {
    bits.push(`<div class="vi"><b>Reservation</b><span>Required — ${esc(en.reservation.name.toLowerCase())} (${esc(en.reservation.season)}). <a href="${esc(en.reservation.url)}" target="_blank" rel="noopener">Book ↗</a></span></div>`);
  }
  if (en.directions) bits.push(`<div class="vi"><b>Getting there</b><span>${esc(clip(en.directions, 320))}</span></div>`);
  if (en.gmaps) bits.push(`<div class="vi"><b>Reviews</b><a href="${esc(en.gmaps)}" target="_blank" rel="noopener">See ratings &amp; reviews on Google Maps ↗</a></div>`);
  return bits.length ? `<section class="visitor"><h2>Visitor info</h2>${bits.join("")}</section>` : "";
}

// Single source of truth for the generated-page site nav (the homepage header in
// public_html/index.html is maintained separately).
function siteNav() {
  return `<nav class="site"><a href="/#map">Map</a><a href="/park/">All parks</a><a href="/road/">Roads</a><a href="/beach/">Beaches</a><a href="/guides/">Guides</a><a href="/#signup" class="btn-alerts">Get alerts</a></nav>`;
}

function pageHtml(e, en, updatedISO, tally, roadsHere = [], sd = { active: false }) {
  const name = esc(e.name);
  const cls = STATUS_CLASS[e.status] || "nodata";
  const label = STATUS_LABEL[e.status] || "Status unknown";
  const url = `${SITE}/park/${e.slug}/`;
  const stateTxt = statesText(e);
  const meta = (e.kind || "Park") + (stateTxt ? " · " + stateTxt : "");
  const official = e.url || (e.source === "nps" ? "https://www.nps.gov/findapark/index.htm" : SITE);
  const officialLabel = e.source === "nps" ? "Official NPS page ↗"
    : e.source === "ny" ? "View on parks.ny.gov ↗"
    : e.source === "ca" ? "View on parks.ca.gov ↗"
    : e.source === "tx" ? "View on tpwd.texas.gov ↗"
    : e.source === "mn" ? "View on dnr.state.mn.us ↗"
    : e.source === "fl" ? "View on floridastateparks.org ↗"
    : e.source === "wa" ? "View on parks.wa.gov ↗"
    : e.source === "usfs" ? "Forest alerts & notices ↗" : "Official page ↗";
  const overview = (en && (en.description || en.history)) || "";
  const desc = clip(`${e.name} ${STATUS_SENTENCE[e.status] || "status"}. ${e.reason || ""} ${overview}`, 300);
  const photo = en && en.photo;

  const asOf = fmtLong(updatedISO);
  const statusSentence = STATUS_SENTENCE[e.status] || "status is unavailable";
  const faq = [{
    "@type": "Question",
    name: `Is ${e.name} open right now?`,
    acceptedAnswer: { "@type": "Answer", text: `As of ${asOf}, ${e.name} ${statusSentence}. ${e.reason || ""}`.trim() },
  }];
  const hoursText = en && en.hours && en.hours.rows
    ? en.hours.rows.filter((r) => r.h && r.h !== "—").map((r) => `${r.d}: ${r.h}`).join("; ")
    : "";
  if (hoursText) {
    faq.push({
      "@type": "Question",
      name: `What are the hours at ${e.name}?`,
      acceptedAnswer: { "@type": "Answer", text: hoursText + (en.hours.note ? ` (${en.hours.note})` : "") },
    });
  }
  if (en && en.fee) {
    faq.push({
      "@type": "Question",
      name: `How much does it cost to enter ${e.name}?`,
      acceptedAnswer: { "@type": "Answer", text: en.fee.free
        ? `${e.name} is free to enter — there is no entrance fee.`
        : `${e.name} charges ${en.fee.display}${en.fee.validDays ? `, valid for ${en.fee.validDays} days` : ""}. Fees are waived on the National Park Service's fee-free days; check the official site for current pricing.` },
    });
  }
  if (e.source === "nps") {
    const r = en && en.reservation;
    faq.push({
      "@type": "Question",
      name: `Does ${e.name} require a reservation?`,
      acceptedAnswer: { "@type": "Answer", text: r
        ? `Yes — ${r.summary}`
        : `No timed-entry or vehicle reservation is required to enter ${e.name}. Individual tours, campgrounds, or backcountry permits may still need to be booked separately.` },
    });
  }

  const graph = [
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "All parks", item: SITE + "/park/" },
      { "@type": "ListItem", position: 3, name: e.name, item: url } ] },
    { "@type": "FAQPage", mainEntity: faq },
  ];
  {
    const isPark = /\bpark\b/i.test(e.kind || "");
    const place = {
      "@type": isPark ? ["TouristAttraction", "Park"] : "TouristAttraction",
      "@id": url + "#place",
      name: e.name,
      url: official,
      dateModified: updatedISO,
    };
    if (en && (en.description || en.history)) place.description = clip(en.description || en.history, 300);
    if (photo) place.image = photo;
    if (en && en.address) place.address = en.address;
    if (en && en.phone) place.telephone = en.phone;
    if (en && en.wiki) place.sameAs = [en.wiki];
    if (en && en.gmaps) place.hasMap = en.gmaps;
    if (typeof e.lat === "number" && typeof e.lon === "number") place.geo = { "@type": "GeoCoordinates", latitude: e.lat, longitude: e.lon };
    const specs = hoursSpec(en && en.hours);
    if (specs.length) place.openingHoursSpecification = specs;
    if (en && en.fee) place.isAccessibleForFree = en.fee.free === true;
    graph.push(place);
  }
  const jsonld = { "@context": "https://schema.org", "@graph": graph };

  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>Is ${name} open? Current status &amp; visitor info — Park Status Today</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0b1b35">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="Is ${name} open right now?">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
${photo ? `<meta property="og:image" content="${esc(photo)}">` : ""}
<meta name="twitter:card" content="${photo ? "summary_large_image" : "summary"}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/park/park.css">
</head>
<body data-entity-id="${esc(e.id)}" data-source="${esc(e.source)}" data-parkname="${esc(e.name)}">
<div id="shutdown-banner"></div>

<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>

${stripHtml(tally, updatedISO)}

<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / <a href="/park/">All parks</a> / ${name}</div>
  <h1>Is ${name} open right now?</h1>
  <p class="sub" id="p-meta">${esc(meta)}</p>

  <div class="verdict ${cls}" id="verdict">
    <span class="pill ${cls}" id="p-pill">${esc(label)}</span>
    <p class="line" id="p-line">${name} ${esc(STATUS_SENTENCE[e.status] || "status is unavailable")}.</p>
    <div class="reason"><span class="rlab">Why this status</span><span id="p-reason">${esc(e.reason || "No reason provided.")}</span></div>
    <p class="checked" id="p-checked">Last checked ${esc(new Date(updatedISO).toUTCString())}</p>
  </div>

  <div class="acts">
    <a class="btn primary" href="${esc(official)}" target="_blank" rel="noopener">${officialLabel}</a>
    <a class="btn ghost" href="/#map">← Back to the map</a>
  </div>

  ${e.source === "nps" ? `<section class="shutdown-note" id="shutdown-note"${sd.active ? "" : " hidden"}>
    <h2>Government shutdown</h2>
    <p>A federal government shutdown is in effect. Access and staffing at National Park Service sites vary — some close and barricade entrances, some stay open but unstaffed. <a href="/shutdown/">Live shutdown status →</a></p>
  </section>` : ""}

  ${photo ? `<img class="hero-photo" src="${esc(photo)}" alt="${name}" loading="lazy" width="820" height="349" style="display:block;width:100%;aspect-ratio:40/17;max-height:340px;object-fit:cover;border-radius:14px">` : ""}

  ${overview ? `<article><h2>About ${name}</h2><p id="p-about">${esc(overview)}</p>${en && en.wiki ? `<p><a href="${esc(en.wiki)}" target="_blank" rel="noopener">Read more on Wikipedia ↗</a> <span class="disc" style="opacity:.7">Text from Wikipedia, CC BY-SA.</span></p>` : ""}</article>` : ""}

  ${visitorBlock(en)}

  ${en && en.reservation ? `<article><h2>Reservations at ${name}</h2>
    <p id="p-resv">${esc(en.reservation.summary)}</p>
    <p><a class="btn primary" href="${esc(en.reservation.url)}" target="_blank" rel="noopener">Book on Recreation.gov ↗</a></p>
    <p class="checked">Reservation window: ${esc(en.reservation.season)}. Confirm on the official site before you travel — programs change year to year.</p>
    <p><a href="/reservations/">All national park reservations &amp; timed entry →</a></p>
  </article>` : ""}

  ${roadsHere.length ? `<div class="roads-in-park">
    <h2>Roads in this park</h2>
    <ul>${roadsHere.map((r) => `<li><a href="/road/${r.slug}/">${esc(r.name)}</a> — ${r.seasonal ? `seasonal, typically opens ${esc(r.typicalOpen || "in late spring")}` : "open year-round"}</li>`).join("")}</ul>
  </div>` : ""}

  <article>
    <h2>How we read this status</h2>
    <p>This is <strong>our reading</strong> of ${
      e.source === "nps" ? "the National Park Service's own alerts and hours"
      : e.source === "usfs" ? "NIFC wildfire perimeters over this forest's boundary — active fires only, not road, trail, or seasonal closures"
      : "the park system's public alerts"}, refreshed hourly — not an official determination. Full method: <a href="/guides/how-we-check-park-status.html">how we check park status</a>.</p>
  </article>

  <div class="related">
    <h2>Before you go</h2>
    <div class="cards">
      ${e.source === "nps"
        ? `<a class="gcard" href="/guides/national-parks-government-shutdown.html"><div class="t">Parks &amp; government shutdowns</div><div class="d">What closes, what stays open, and how a funding lapse changes park status.</div></a>`
        : `<a class="gcard" href="/guides/why-national-parks-close.html"><div class="t">Why parks close</div><div class="d">Wildfire, weather, wildlife, construction — the real reasons a park or road shuts.</div></a>`}
      <a class="gcard" href="/guides/nps-alerts-explained.html"><div class="t">NPS alerts explained</div><div class="d">Danger, Closure, Caution, Information — what each type means.</div></a>
      <a class="gcard" href="/park/"><div class="t">All park statuses</div><div class="d">Every park and waterway we track, A–Z.</div></a>
      <a class="gcard" href="/#map"><div class="t">Live map</div><div class="d">See what's open near you right now.</div></a>
    </div>
  </div>
</main>

<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span><b>Park Status Today</b> — an independent informational service, not affiliated with the National Park Service or any state agency.</span>
  <span class="disc">Live status refreshed hourly · always confirm with the official park page before you travel.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>

<script>
(function(){
  var API="${API}";
  var ID=document.body.dataset.entityId, SRC=document.body.dataset.source, NAME=document.body.dataset.parkname||ID;
  var SENT={open:"is open",partially_closed:"is partially closed",closed:"is closed",no_data:"has no current status"};
  var LABEL={open:"Open",partially_closed:"Partially closed",closed:"Closed",no_data:"No data"};
  var CLS={open:"open",partially_closed:"partial",closed:"closed",no_data:"nodata"};
  var bmap=function(s){return s==="advisory"?"partially_closed":(s==="open"||s==="closed")?s:"no_data";};
  function set(id,v){var e=document.getElementById(id);if(e&&v!=null)e.textContent=v;}
  fetch(API,{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    var c={open:0,partially_closed:0,closed:0,no_data:0};
    var add=function(arr,mk){(arr||[]).forEach(function(x){var s=mk?mk(x.status):x.status;if(s in c)c[s]++;});};
    add(d.parks);add(d.nyParks);add(d.caParks);add(d.txParks);add(d.mnParks);add(d.flParks);add(d.waParks);add(d.usfs);add(d.beaches,bmap);
    set("s-open",c.open);set("s-partial",c.partially_closed);set("s-closed",c.closed);set("s-nodata",c.no_data);
    if(d.updated){var dt=new Date(d.updated);
      set("s-upd","updated "+dt.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+dt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}));}
    var list = SRC==="nps"?d.parks : SRC==="ny"?d.nyParks : SRC==="ca"?d.caParks : SRC==="tx"?d.txParks : SRC==="mn"?d.mnParks : [];
    var key = SRC==="nps" ? "nps:" : "";
    var p=(list||[]).find(function(x){return (key+(x.parkCode||x.id))===ID;});
    if(!p)return;
    var v=document.getElementById("verdict"); if(v)v.className="verdict "+(CLS[p.status]||"nodata");
    var pill=document.getElementById("p-pill");
    if(pill){pill.className="pill "+(CLS[p.status]||"nodata");pill.textContent=LABEL[p.status]||"Status unknown";}
    set("p-line",NAME+" "+(SENT[p.status]||"status is unavailable")+".");
    set("p-reason",p.reason||"No reason provided.");
    if(d.updated)set("p-checked","Last checked "+new Date(d.updated).toUTCString());
    var sn=document.getElementById("shutdown-note"); if(sn) sn.hidden=!(d.shutdown&&d.shutdown.active);
  }).catch(function(){});
  fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
    if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
    b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';
    b.className="show";
  }).catch(function(){});
})();
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

function directoryHtml(list, updatedISO, tally) {
  const rows = list.slice().sort((a, b) => a.name.localeCompare(b.name)).map((e) =>
    `<li><a href="/park/${e.slug}/"><span class="d ${STATUS_CLASS[e.status] || "nodata"}"></span><span class="nm">${esc(e.name)}</span><span class="st">${esc(statesText(e))}</span></a></li>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>All park &amp; waterway statuses, A–Z — Park Status Today</title>
<meta name="description" content="Current open / partially closed / closed status for ${list.length} national and state parks, listed A to Z.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${SITE}/park/">
<meta name="robots" content="index, follow">
<meta property="og:title" content="All park &amp; waterway statuses, A–Z">
<meta property="og:url" content="${SITE}/park/">
<link rel="stylesheet" href="/park/park.css">
</head>
<body>
<div id="shutdown-banner"></div>
<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>
${stripHtml(tally, updatedISO)}
<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / All parks</div>
  <h1>Every status, A–Z</h1>
  <p class="sub">${list.length} national and state parks. Tap any for status, hours, and visitor info. Looking for the coast? <a href="/beach/">Beach water quality &amp; closures →</a></p>
  <input id="pfilter" class="pfilter" type="text" placeholder="Filter this list…" aria-label="Filter parks">
  <ul class="plist" id="plist">
${rows}
  </ul>
</main>
<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span class="disc">Live status refreshed hourly · always confirm with the official park page before you travel.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>
<script>
(function(){
  var f=document.getElementById("pfilter"),list=document.getElementById("plist");
  f.addEventListener("input",function(){var v=f.value.trim().toLowerCase();
    list.querySelectorAll("li").forEach(function(li){li.style.display=!v||li.textContent.toLowerCase().indexOf(v)>-1?"":"none";});});
  var bmap=function(s){return s==="advisory"?"partially_closed":(s==="open"||s==="closed")?s:"no_data";};
  fetch("${API}",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    var c={open:0,partially_closed:0,closed:0,no_data:0},set=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    var add=function(a,mk){(a||[]).forEach(function(x){var s=mk?mk(x.status):x.status;if(s in c)c[s]++;});};
    add(d.parks);add(d.nyParks);add(d.caParks);add(d.txParks);add(d.mnParks);add(d.flParks);add(d.waParks);add(d.usfs);add(d.beaches,bmap);
    set("s-open",c.open);set("s-partial",c.partially_closed);set("s-closed",c.closed);set("s-nodata",c.no_data);
    if(d.updated){var dt=new Date(d.updated);set("s-upd","updated "+dt.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+dt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}));}
  }).catch(function(){});
  fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
    if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
    b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
  }).catch(function(){});
})();
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

// ===================== road-status pages ==================================
// road: a roads.json row + { parents:[{name,slug}], parentNames:string }
// st:   { tier, status, cls, reason, date }  from roadStatus()
function roadPageHtml(road, st, updatedISO, tally) {
  const name = esc(road.name);
  const url = `${SITE}/road/${road.slug}/`;
  const label = { open: "Open", partial: "Partially open", closed: "Closed", nodata: "Seasonal — closed for winter" }[st.cls] || "Status unknown";
  const asOf = fmtLong(updatedISO);
  const gtts = road.slug === "going-to-the-sun-road";
  const openQ = gtts ? `When does the full Going-to-the-Sun Road over Logan Pass open?` : `When does ${road.name} open?`;

  const parentLinks = road.parents.length
    ? road.parents.map((p) => `<a href="/park/${p.slug}/">${esc(p.name)}</a>`).join(" · ")
    : "Not inside a national park unit";

  const histRows = (road.history || []).filter((h) => h.opened)
    .map((h) => `<tr><td>${h.year}</td><td>${esc(h.opened)}</td></tr>`).join("");

  const faq = [{
    "@type": "Question", name: `Is ${road.name} open right now?`,
    acceptedAnswer: { "@type": "Answer", text: `${st.reason} Last checked ${asOf} UTC. Always confirm with the official road-status page before you travel.` },
  }];
  if (road.seasonal) {
    faq.push({
      "@type": "Question", name: openQ,
      acceptedAnswer: { "@type": "Answer", text: `${road.name} typically opens ${road.typicalOpen || "in late spring"}. Plowing usually starts in April; the exact date depends on snowpack and can vary by weeks year to year.${road.history && road.history.length ? " Recent opening dates: " + road.history.filter((h) => h.opened).map((h) => `${h.opened} (${h.year})`).join(", ") + "." : ""}` },
    });
    faq.push({
      "@type": "Question", name: `When does ${road.name} close for winter?`,
      acceptedAnswer: { "@type": "Answer", text: `${road.name} normally closes ${road.typicalClose || "in mid-to-late autumn"}. It can close earlier if a heavy storm arrives.` },
    });
  } else {
    faq.push({
      "@type": "Question", name: `Is ${road.name} open in winter?`,
      acceptedAnswer: { "@type": "Answer", text: road.accessNote || `${road.name} is open year-round, though sections can close temporarily during winter storms.` },
    });
  }

  const graph = [
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "Roads", item: SITE + "/road/" },
      { "@type": "ListItem", position: 3, name: road.name, item: url } ] },
    { "@type": "FAQPage", mainEntity: faq },
  ];
  if (road.isScenicDrive && road.parents.length) {
    graph.push({
      "@type": "TouristAttraction", name: road.name, description: road.blurb, url,
      containedInPlace: { "@type": "Park", name: road.parents[0].name, url: `${SITE}/park/${road.parents[0].slug}/` },
    });
  }
  const jsonld = { "@context": "https://schema.org", "@graph": graph };

  const desc = clip(`${road.name}: ${st.reason} ${road.blurb}`, 300);

  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>Is ${name} open? Road status &amp; season — Park Status Today</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0b1b35">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="Is ${name} open right now?">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/park/park.css">
</head>
<body${road.parents.length ? ` data-parent-id="${esc(road.parents[0].id)}" data-parent-source="${esc(road.parents[0].source)}"` : ""}>
<div id="shutdown-banner"></div>

<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>

${stripHtml(tally, updatedISO)}

<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / <a href="/road/">Roads</a> / ${name}</div>
  <h1>Is ${name} open?</h1>
  <p class="sub">${road.designation ? esc(road.designation) + " · " : ""}${parentLinks}</p>

  <div class="verdict ${st.cls}" id="verdict">
    <span class="pill ${st.cls}" id="p-pill">${esc(label)}</span>
    <p class="line">${esc(st.reason)}</p>
    <p class="checked">Last checked ${esc(new Date(updatedISO).toUTCString())}${st.tier === "B" && st.date ? ` · alert dated ${esc(String(st.date).slice(0, 10))}` : ""}</p>
  </div>

  <div class="acts">
    <a class="btn primary" href="${esc(road.statusUrl)}" target="_blank" rel="noopener">Official road status ↗</a>
    <button type="button" class="btn ghost" id="road-follow" data-rid="road:${esc(road.slug)}" data-rname="${esc(road.name)}">${road.seasonal ? "🔔 Notify me when it reopens" : "🔔 Notify me if it closes"}</button>
    <a class="btn ghost" href="/road/">← All roads</a>
  </div>

  ${road.blurb ? `<p>${esc(road.blurb)}</p>` : ""}
  ${road.parents.length ? `<p class="road-parent-status" id="road-parent-status" data-name="${esc(road.parents[0].name)}">${esc(road.parents[0].name)} — check current park status.</p>` : ""}

  ${road.seasonal ? `<article class="road-window">
    <h2>${esc(openQ)}</h2>
    <p>Typically open ${esc(road.typicalOpen || "in late spring")} to ${esc(road.typicalClose || "mid-autumn")}. Plowing usually begins in April; the opening date depends entirely on snowpack and can swing several weeks.</p>
    ${road.accessNote ? `<p>${esc(road.accessNote)}</p>` : ""}
    ${histRows ? `<table class="road-hist"><tr><th>Year</th><th>Opened</th></tr>${histRows}</table>
    <p class="src">Opening dates from the National Park Service.</p>` : `<p class="src">Year-by-year opening dates are being verified — for now, use the official status link above.</p>`}
  </article>` : `<article class="road-window">
    <h2>Is ${name} open in winter?</h2>
    <p>${esc(road.accessNote || `${road.name} is open year-round, but sections can close during winter storms until they are cleared.`)}</p>
  </article>`}

  ${road.reservationRef && RESERVATIONS[road.reservationRef] ? `<article>
    <h2>Reservations</h2>
    <p>${esc(RESERVATIONS[road.reservationRef].summary)}</p>
    <p><a class="btn ghost" href="/park/${esc(road.parents[0] ? road.parents[0].slug : "")}/">Reservation details on the park page →</a></p>
  </article>` : ""}

  <article>
    <h2>How we know this</h2>
    <p>${road.parents.length
      ? `We watch ${esc(road.parents.map((p) => p.name).join(" and "))}'s official National Park Service alerts for anything that names ${name}${road.designation ? ` or ${esc(road.designation)}` : ""}, and refresh this page with the daily build. ${road.seasonal ? "Between closures we show the typical season and recent opening dates." : "We also show the road's normal winter access pattern above."}`
      : `${name} isn't inside a national park unit, so there's no NPS alert feed for it — this page shows the typical season and points you to the transportation department that opens and closes it.`} It's our reading of public information, not an official determination. Always check the official link before you drive.</p>
  </article>
</main>

<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span class="disc">Road status refreshed daily · always confirm with the official road-status page before you travel.</span>
  <span class="disc"><a href="/road/" style="color:#fff">All roads</a> · <a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>

<script>
(function(){
  var P=document.body.dataset.parentId; if(!P) return;
  fetch("${API}",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    var SRC=document.body.dataset.parentSource;
    var list = SRC==="nps"?d.parks:SRC==="ny"?d.nyParks:SRC==="ca"?d.caParks:SRC==="tx"?d.txParks:SRC==="mn"?d.mnParks:[];
    var key = SRC==="nps"?"nps:":"";
    var p=(list||[]).find(function(x){return (key+(x.parkCode||x.id))===P;});
    if(!p) return;
    var LABEL={open:"open",partially_closed:"partially closed",closed:"closed",no_data:"status unknown"};
    var el=document.getElementById("road-parent-status");
    if(el) el.textContent=el.dataset.name+" is currently "+(LABEL[p.status]||"of unknown status")+".";
  }).catch(function(){});
  fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
    if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
    b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
  }).catch(function(){});
})();
</script>
<script>
/* "Notify me" — adds road:<slug> to ps_follows (shared with the Alerts panel
   and app-native.js). Web: bounce to the homepage panel to finish the push
   opt-in. In-app: app-native.js picks up the ps_follows write and re-subscribes. */
(function(){
  var rf=document.getElementById("road-follow"); if(!rf) return;
  var RID=rf.dataset.rid, RNAME=rf.dataset.rname, SEASONAL=${road.seasonal ? "true" : "false"};
  var LABEL_OFF=SEASONAL?"🔔 Notify me when it reopens":"🔔 Notify me if it closes";
  function readF(){ try{ var a=JSON.parse(localStorage.getItem("ps_follows")||"[]"); return Array.isArray(a)?a:[]; }catch(_){ return []; } }
  function paint(){ var on=readF().some(function(f){return f&&f.id===RID;}); rf.classList.toggle("on",on); rf.textContent=on?"✓ You'll be notified — manage alerts":LABEL_OFF; }
  paint();
  rf.addEventListener("click",function(){
    var f=readF().filter(function(x){return x&&x.id;});
    var i=f.findIndex(function(x){return x.id===RID;});
    if(i>=0) f.splice(i,1); else f.push({id:RID,name:RNAME});
    try{ localStorage.setItem("ps_follows", JSON.stringify(f.slice(0,60))); }catch(_){}
    paint();
    if(i<0) location.href="/#alerts";
  });
})();
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

function roadIndexHtml(roads, updatedISO, tally, statuses) {
  // group by first parent park name; empty parents -> "Other scenic roads"
  const groups = new Map();
  for (const r of roads.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const key = r.parents.length ? r.parents[0].name : "Other scenic roads";
    if (!groups.has(key)) groups.set(key, { slug: r.parents.length ? r.parents[0].slug : "", roads: [] });
    groups.get(key).roads.push(r);
  }
  const closed = roads.filter((r) => ["closed", "nodata"].includes(statuses.get(r.slug).cls));
  const dot = (cls) => `<span class="d ${cls}"></span>`;
  const line = (r) => {
    const s = statuses.get(r.slug);
    const note = r.seasonal
      ? (s.cls === "nodata" ? `closed — reopens ${esc(r.typicalOpen || "in spring")}` : `open · typically ${esc(r.typicalOpen || "late spring")}–${esc((r.typicalClose || "mid-autumn").split(" ")[0])}`)
      : "open year-round";
    return `<li><a href="/road/${r.slug}/">${dot(s.cls)}<span class="nm">${esc(r.name)}</span></a> <span class="st">${note}</span></li>`;
  };
  const groupsHtml = [...groups.entries()].sort((a, b) => (a[0] === "Other scenic roads" ? 1 : b[0] === "Other scenic roads" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, g]) => `<div class="road-group"><h2>${g.slug ? `<a href="/park/${g.slug}/">${esc(k)}</a>` : esc(k)}</h2><ul class="plist">${g.roads.map(line).join("")}</ul></div>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>Park road status — seasonal openings &amp; closures — Park Status Today</title>
<meta name="description" content="Is the road open? Seasonal opening and closing dates and live closure status for ${roads.length} major national-park roads — Going-to-the-Sun, Trail Ridge, Tioga, the Blue Ridge Parkway and more.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${SITE}/road/">
<meta name="robots" content="index, follow">
<meta property="og:title" content="Park road status — seasonal openings &amp; closures">
<meta property="og:url" content="${SITE}/road/">
<link rel="stylesheet" href="/park/park.css">
</head>
<body>
<div id="shutdown-banner"></div>
<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>
${stripHtml(tally, updatedISO)}
<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / Roads</div>
  <h1>Park road status</h1>
  <p class="sub">Seasonal opening and closing dates, plus live closure status where the National Park Service publishes alerts, for major park roads. ${roads.length} roads so far — more on the way.</p>
  ${closed.length ? `<div class="road-group"><h2>Closed right now</h2><ul class="plist">${closed.map(line).join("")}</ul></div>` : ""}
  ${groupsHtml}
  <p class="sub" style="margin-top:24px">Looking for a specific park? <a href="/park/">All park statuses, A–Z →</a></p>
</main>
<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span class="disc">Road status refreshed daily · always confirm with the official road-status page before you travel.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>
<script>
fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
  if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
  b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
}).catch(function(){});
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

// ===================== /reservations/ index =============================
// Generated wholly from reservations.json (the RESERVATIONS map). One clean,
// annually-refreshed hub for "which national parks need a timed-entry /
// vehicle reservation in <year>". NOT in siteNav() — reached from park pages
// and the footer only.
function reservationsIndexHtml(reservations, entities, updatedISO, tally) {
  const url = `${SITE}/reservations/`;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const rows = Object.entries(reservations)
    .filter(([k]) => k !== "_note")
    .map(([id, r]) => {
      const ent = byId.get(id);
      return { id, name: ent ? ent.name : id, slug: ent ? ent.slug : null, r };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Parks that ran timed entry recently but do NOT require it this year.
  // Hardcoded — RE-CHECK EVERY SPRING against nps.gov.
  const DROPPED_IDS = ["nps:arch", "nps:glac", "nps:mora", "nps:yose"];
  const dropped = DROPPED_IDS.map((id) => {
    const ent = byId.get(id);
    return { name: ent ? ent.name : id.replace(/^nps:/, ""), slug: ent ? ent.slug : null };
  });
  const droppedHtml = dropped
    .map((d) => (d.slug ? `<a href="/park/${d.slug}/">${esc(d.name)}</a>` : esc(d.name)))
    .join(", ").replace(/, ([^,]*)$/, " and $1");

  const asOf = fmtLong(updatedISO);
  const tableRows = rows.map(({ name, slug, r }) => `<tr>
      <td>${slug ? `<a href="/park/${slug}/">${esc(name)}</a>` : esc(name)}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.season)}</td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">Book ↗</a></td>
    </tr>`).join("\n");

  const faqWhich = `As of ${asOf}, ${rows.length} national parks require a timed-entry or vehicle reservation for at least part of the year: `
    + rows.map((x) => `${x.name} (${x.r.name.toLowerCase()}, ${x.r.season})`).join("; ")
    + `. ${dropped.map((d) => d.name).join(", ").replace(/, ([^,]*)$/, " and $1")} ran timed-entry systems in recent years but do not require one this year.`;
  const faqFee = `Yes. A timed-entry or vehicle reservation only reserves your entry slot or parking — it is not a park pass. You still need a valid entrance pass or to pay the entrance fee, and the reservation carries its own small processing fee (about $1–$6).`;

  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Reservations", item: url } ] },
      { "@type": "FAQPage", mainEntity: [
        { "@type": "Question", name: `Which national parks require a reservation in ${new Date(updatedISO).getUTCFullYear()}?`,
          acceptedAnswer: { "@type": "Answer", text: faqWhich } },
        { "@type": "Question", name: "Do I still pay the entrance fee with a timed-entry ticket?",
          acceptedAnswer: { "@type": "Answer", text: faqFee } } ] },
      { "@type": "ItemList", name: "National parks requiring a reservation", numberOfItems: rows.length,
        itemListElement: rows.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.name,
          url: x.slug ? `${SITE}/park/${x.slug}/` : url })) },
    ],
  };

  const desc = `Which U.S. national parks require a timed-entry or vehicle reservation, and when — ${rows.length} parks with their 2026 seasons and booking links, plus the parks that dropped timed entry. Verified ${asOf}.`;

  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>Which national parks require a reservation? — Park Status Today</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="Which national parks require a reservation?">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/park/park.css">
</head>
<body>
<div id="shutdown-banner"></div>
<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>
${stripHtml(tally, updatedISO)}
<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / Reservations</div>
  <h1>National park reservations &amp; timed entry</h1>
  <p class="sub">Which parks need a timed-entry or vehicle reservation to visit, and when. Verified for the 2026 season as of ${esc(asOf)} — always confirm on the official booking site before you go.</p>

  <p>A handful of national parks cap how many vehicles enter during their busiest hours with a timed-entry or vehicle reservation, booked ahead on <a href="https://www.recreation.gov" target="_blank" rel="noopener">Recreation.gov</a> (Muir Woods uses GoMuirWoods.com). A reservation is <strong>not</strong> a park pass — you still pay the normal entrance fee, and the reservation carries its own small processing fee. Outside the dates and hours below, no reservation is needed.</p>

  <div class="resv-wrap"><table class="resv">
    <tr><th>Park</th><th>What's covered</th><th>When</th><th>Book</th></tr>
${tableRows}
  </table></div>

  <div class="resv-dropped"><strong>No longer required in 2026:</strong> ${droppedHtml} ran timed-entry systems in recent years but do not require one for the 2026 season. Check the park page before you travel in case that changes.</div>

  <article>
    <h2>How timed entry works</h2>
    <p>Reservations are released in batches: a block opens weeks or months ahead, then a second batch — often the slots people actually get — drops the night before or two days out, at a fixed time in the park's local zone. Set a reminder; popular days sell out in minutes.</p>
    <p>Each reservation costs a small processing fee (about $1 at the cavern and sunrise parks, up to $6 per vehicle at Acadia) <em>on top of</em> the park entrance fee, which you pay separately.</p>
    <p>A reservation only covers the specific road, area, or time window it names — the Cadillac Summit Road, the Old Rag trailhead, the sunrise hours at Haleakalā. The rest of each park stays walk-in, and so does every park not on this list.</p>
  </article>

  <article>
    <h2>Do I still pay the entrance fee?</h2>
    <p>Yes. A timed-entry or vehicle reservation reserves your entry slot or parking space only. You still need a valid park entrance pass (or to pay the fee at the gate), and the reservation's processing fee is charged on top of that.</p>
  </article>

  <div class="related">
    <h2>More</h2>
    <div class="cards">
      <a class="gcard" href="/park/"><div class="t">All park statuses</div><div class="d">National and state parks, A–Z, open / partially closed / closed.</div></a>
      <a class="gcard" href="/road/"><div class="t">Road status</div><div class="d">Seasonal opening dates and live closures for major park roads.</div></a>
      <a class="gcard" href="/#map"><div class="t">Live map</div><div class="d">See what's open near you right now.</div></a>
      <a class="gcard" href="/#signup"><div class="t">Get alerts</div><div class="d">Email or push when something near you closes.</div></a>
    </div>
  </div>
</main>
<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span class="disc">Reservation details are our reading of nps.gov and recreation.gov, verified ${esc(asOf)} · programs change year to year — always confirm on the official site.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>
<script>
fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
  if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
  b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
}).catch(function(){});
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

// ===================== /shutdown/ live hub ================================
// sd = blob.shutdown = { active, since, source, summary, checkedAt, stale }
function shutdownPageHtml(sd, updatedISO, tally) {
  sd = sd || { active: false };
  const checked = sd.checkedAt ? new Date(sd.checkedAt).toUTCString() : new Date(updatedISO).toUTCString();
  const sinceTxt = sd.since ? ` (since ${esc(sd.since)})` : "";
  const url = `${SITE}/shutdown/`;
  const answerNow = sd.active
    ? `A federal government shutdown is in effect${sinceTxt}. National Park Service sites are affected — access and staffing vary by park. ${esc(sd.summary || "")}`.trim()
    : `There is no federal government shutdown right now. National parks are operating normally under the National Park Service.`;
  const faq = [
    { "@type": "Question", name: "Are the national parks open during a government shutdown?",
      acceptedAnswer: { "@type": "Answer", text: `${answerNow} Last checked ${checked}.` } },
    { "@type": "Question", name: "Which national parks close during a government shutdown?",
      acceptedAnswer: { "@type": "Answer", text: "It varies by park and by shutdown. Some parks fully close and barricade their entrances; many stay physically accessible but unstaffed — no visitor centers, no rangers, no plowing, restrooms locked, trash uncollected. A few keep operating through state or gateway-community agreements. Check the individual park's page or the NPS operating-status page." } },
    { "@type": "Question", name: "Are state parks affected by a federal government shutdown?",
      acceptedAnswer: { "@type": "Answer", text: "No. State park systems are funded and staffed by their states, not the federal government, so a lapse in federal appropriations does not close them. National Forests are federal, but their roads and trails generally remain physically accessible during a shutdown." } },
  ];
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "Government shutdown", item: url } ] },
    { "@type": "FAQPage", mainEntity: faq },
  ] };

  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>Are the national parks open during a government shutdown? — Park Status Today</title>
<meta name="description" content="Live status: whether a federal government shutdown is in effect and what it means for national park access. Checked hourly against the National Park Service's operating-status page.">
<meta name="theme-color" content="#0b1b35">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="Are the national parks open during a government shutdown?">
<meta property="og:url" content="${url}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/park/park.css">
</head>
<body data-shutdown="${sd.active ? "true" : "false"}">
<div id="shutdown-banner"></div>
<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>
${stripHtml(tally, updatedISO)}
<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / Government shutdown</div>
  <h1>Are the national parks open during a government shutdown?</h1>

  <div class="verdict ${sd.active ? "closed" : "open"}" id="sd-verdict">
    <span class="pill ${sd.active ? "closed" : "open"}" id="sd-pill">${sd.active ? "Shutdown in effect" : "No shutdown"}</span>
    <p class="line" id="sd-line">${esc(answerNow)}</p>
    <p class="checked" id="sd-checked">Last checked ${esc(checked)} · source: ${sd.source === "manual" ? "manual override" : "NPS operating-status page"}${sd.stale ? " · last automated check failed, showing previous state" : ""}</p>
  </div>

  <div class="acts">
    <a class="btn primary" href="https://www.nps.gov/planyourvisit/national-park-system-operating-status.htm" target="_blank" rel="noopener">NPS operating status ↗</a>
    <a class="btn ghost" href="/park/">Check a specific park →</a>
  </div>

  <div id="sd-inactive"${sd.active ? " hidden" : ""}>
    <article>
      <h2>What happens to national parks during a shutdown</h2>
      <p>When federal appropriations lapse, the National Park Service furloughs most of its staff. There is no single rule for what happens to the parks: some close entirely and barricade their entrances and roads; many stay physically accessible but completely unstaffed — no visitor centers, no rangers, no road plowing or maintenance, restrooms locked, trash left to pile up; a handful keep running because a state or a gateway community steps in to fund operations. New permits, reservations, and special-use approvals stop being processed.</p>
      <p>This page checks the NPS operating-status page every hour, so if a lapse begins it will say so here first.</p>
    </article>
  </div>

  <div id="sd-active"${sd.active ? "" : " hidden"}>
    <article>
      <h2>What this means for your visit</h2>
      <p>Expect parks to be either closed and barricaded or open but unstaffed. If a park is accessible: bring your own water, pack out everything you bring in, expect locked restrooms and unplowed or ungated roads, and know that emergency and search-and-rescue coverage is reduced. Visitor centers, campground reservations, shuttle services, and ranger programs are generally suspended. Entrance stations are typically unmanned — where a park stays open, entry is often free but services are not.</p>
      <p>Check your park's page here for its current status note, and the official NPS link above for the park-by-park picture.</p>
    </article>
  </div>

  <article>
    <h2>State parks, national forests, and beaches are not affected</h2>
    <p>A federal government shutdown does not close state park systems — New York, California, Texas, Minnesota, Florida, and Washington run and fund their own parks. National Forests are federal and also furlough staff, but their roads and trails generally stay physically open. New York's public beaches are monitored by state and county health departments, not the NPS. <a href="/#map">See what's open near you on the live map →</a></p>
  </article>

  <article>
    <h2>Full explainer</h2>
    <p>For the history, the contingency-plan mechanics, and how to prepare for a trip during a funding fight, see <a href="/guides/national-parks-government-shutdown.html">what a government shutdown means for the national parks</a>.</p>
  </article>
</main>
<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span class="disc">Shutdown status checked hourly against the National Park Service's operating-status page · this is our reading of public information, not an official determination.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>
<script>
(function(){
  function set(id,v){var e=document.getElementById(id);if(e&&v!=null)e.textContent=v;}
  fetch("${API}",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    var s=d.shutdown; if(!s) return;
    var was=document.body.dataset.shutdown==="true";
    if(!!s.active!==was){
      document.body.dataset.shutdown=s.active?"true":"false";
      var v=document.getElementById("sd-verdict"); if(v)v.className="verdict "+(s.active?"closed":"open");
      var p=document.getElementById("sd-pill"); if(p){p.className="pill "+(s.active?"closed":"open");p.textContent=s.active?"Shutdown in effect":"No shutdown";}
      var a=document.getElementById("sd-active"), i=document.getElementById("sd-inactive");
      if(a)a.hidden=!s.active; if(i)i.hidden=!!s.active;
    }
    if(s.line||s.summary){
      var since=s.since?" (since "+s.since+")":"";
      set("sd-line", s.active
        ? "A federal government shutdown is in effect"+since+". National Park Service sites are affected — access and staffing vary by park. "+(s.summary||"")
        : "There is no federal government shutdown right now. National parks are operating normally under the National Park Service.");
    }
    if(s.checkedAt) set("sd-checked","Last checked "+new Date(s.checkedAt).toUTCString()+" · source: "+(s.source==="manual"?"manual override":"NPS operating-status page")+(s.stale?" · last automated check failed, showing previous state":""));
  }).catch(function(){});
  fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
    if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
    b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
  }).catch(function(){});
})();
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

const PARK_CSS = `/* Park Status — per-park + directory pages. half-mast.com visual language. */
:root{--ink:#0e1726;--navy:#0b1b35;--navy-2:#142746;--paper:#f4f6f9;--line:#dfe4ec;--muted:#667185;--card:#fff;
--open:#14785d;--open-tint:#e7f7f1;--partial:#9a6a0f;--partial-bright:#f2bd54;--partial-tint:#fff7e5;
--closed:#ee263b;--closed-tint:#fdebed;--nodata:#5a6472;--nodata-tint:#eef0f3;
--font-display:"Arial Black",Impact,"Arial Narrow",Arial,sans-serif;--font-sans:Arial,Helvetica,sans-serif;
--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
/* Type system — same token technique as index.html's <style> (commit f286fcd1),
   calibrated to these pages' OWN current desktop sizes: every token's max/fixed
   value equals today's ~1280px rendering, so park / road / directory / beach-hub
   pages look unchanged on desktop. Fluid roles scale DOWN toward 375px; the
   max-width:580px block below loosens display tracking for phone-size headings
   (half-mast's tighter numbers are tuned for its much larger mobile headings).
   Body copy (article p 16, .reason/.vi 15, tables 14, .plist 14) deliberately
   keeps its px sizes and is NOT tokenised — same call the homepage made. */
--type-hero:       clamp(30px,5.5vw,50px); /* h1 */
--type-verdict:    clamp(19px,3.2vw,26px); /* .verdict .line */
--type-section:    24px;                   /* article h2, .visitor h2 */
--type-subsection: 22px;                   /* .related h2 */
--type-road-group: 19px;                   /* .road-group h2 */
--type-card-title: 17px;                   /* .gcard .t */
--type-note-title: 16px;                   /* .shutdown-note h2 */
--type-wordmark:   22px;                   /* .wordmark */
--tracking-hero:      -2px;
--tracking-verdict:   -.8px;
--tracking-section:   -1.2px;
--tracking-subsection:-1px;
--tracking-card:      -.6px;
--tracking-wordmark:  -1.4px;
--tracking-tight:     -.5px;   /* .road-group h2, #shutdown-banner strong */
--tracking-note:      -.3px;   /* .shutdown-note h2 */
--leading-hero:    .96;
--leading-verdict: 1.15;
--leading-title:   1.1}
@media(max-width:580px){:root{
--tracking-hero:      -1.1px;
--tracking-verdict:   -.4px;
--tracking-section:   -.6px;
--tracking-subsection:-.5px;
--tracking-card:      -.3px;
--tracking-wordmark:  -.8px;
--tracking-tight:     -.3px;
}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-sans);line-height:1.7;-webkit-font-smoothing:antialiased;border-top:4px solid var(--closed)}
.wrap{max-width:820px;margin:0 auto;padding:0 22px}
a{color:var(--navy);text-underline-offset:3px}a:hover{color:var(--closed)}
header.site{border-bottom:1px solid var(--line);background:var(--paper)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 22px;max-width:1080px}
nav.site a{font-size:13px;text-decoration:none;color:var(--muted);margin-left:17px}
nav.site a:hover{color:var(--ink)}
.wordmark{display:inline-flex;align-items:center;gap:5px;font-family:var(--font-display);font-weight:900;font-size:var(--type-wordmark);letter-spacing:var(--tracking-wordmark);color:var(--ink);text-decoration:none;line-height:1}
.flag-mark{display:inline-flex!important;flex-direction:column;width:25px;height:16px;border-radius:2px;position:relative;overflow:hidden;box-shadow:0 0 0 1px #0b1b3524}
.flag-mark::before{content:"";position:absolute;inset:0 auto auto 0;width:11px;height:8px;background:#385994;z-index:2}
.flag-mark i{display:block;width:100%;height:5.3px;background:#ee263b}.flag-mark i:nth-child(2){background:#fff}
.btn-alerts{background:#ee263b;color:#fff!important;font-weight:bold;padding:8px 14px;border-radius:9px;text-decoration:none;margin-left:14px}
.btn-alerts:hover{background:#d51f32}
.strip{background:var(--navy);color:#dfe7f2}
.strip .wrap{max-width:1080px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;padding:9px 22px;font-family:var(--font-mono);font-size:12px}
.strip .k{display:inline-flex;align-items:center;gap:6px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
.dot.open{background:#36d6a0}.dot.partial{background:var(--partial-bright)}.dot.closed{background:#ff5566}.dot.nodata{background:#9aa4b2}
.strip .upd{margin-left:auto;opacity:.72}.strip a{color:#fff;font-weight:bold}
.crumbs{font-family:var(--font-mono);font-size:12px;color:var(--muted);padding-top:22px}
.crumbs a{color:var(--muted)}
h1{font-family:var(--font-display);font-weight:900;letter-spacing:var(--tracking-hero);line-height:var(--leading-hero);font-size:var(--type-hero);margin:18px 0 10px}
.sub{font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin:0 0 22px;text-transform:uppercase;letter-spacing:.08em}
.verdict{border:1px solid var(--line);border-left:5px solid var(--navy);background:var(--card);border-radius:14px;padding:20px 20px 16px;margin:0 0 20px}
.verdict.open{border-left-color:var(--open);background:var(--open-tint)}
.verdict.partial{border-left-color:var(--partial-bright);background:var(--partial-tint)}
.verdict.closed{border-left-color:var(--closed);background:var(--closed-tint)}
.verdict.nodata{border-left-color:var(--nodata);background:var(--nodata-tint)}
.pill{display:inline-flex;align-items:center;font-family:var(--font-mono);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:6px 11px;border-radius:20px;color:#fff}
.pill.open{background:var(--open)}.pill.partial{background:var(--partial)}.pill.closed{background:var(--closed)}.pill.nodata{background:var(--nodata)}
.verdict .line{font-family:var(--font-display);font-weight:900;letter-spacing:var(--tracking-verdict);font-size:var(--type-verdict);line-height:var(--leading-verdict);margin:12px 0 12px}
.reason{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 13px;font-size:15px;margin:0 0 12px}
.reason .rlab{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:5px}
.checked{font-family:var(--font-mono);font-size:11px;color:var(--muted);margin:6px 0 0}
.acts{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px}
.btn{font:inherit;font-size:14px;font-weight:bold;border-radius:10px;padding:11px 16px;text-decoration:none;border:1px solid transparent}
.btn.primary{background:var(--navy);color:#fff}.btn.primary:hover{background:var(--navy-2);color:#fff}
.btn.ghost{background:#fff;color:var(--navy);border-color:var(--line)}.btn.ghost:hover{border-color:var(--navy)}
.hero-photo{display:block;width:100%;aspect-ratio:40/17;max-height:340px;object-fit:cover;border-radius:14px;border:1px solid var(--line);margin:0 0 8px}
article{padding:6px 0 4px}
article h2{font-family:var(--font-display);font-weight:900;letter-spacing:var(--tracking-section);font-size:var(--type-section);margin:26px 0 10px}
/* body copy: literal px on purpose, NOT tokenised (see :root note) */
article p{font-size:16px;margin:0 0 14px}
.visitor{border-top:1px solid var(--line);margin-top:22px;padding-top:6px}
.visitor h2{font-family:var(--font-display);font-weight:900;letter-spacing:var(--tracking-section);font-size:var(--type-section);margin:20px 0 12px}
.vi{margin:0 0 14px}
.vi b{display:block;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.vi span,.vi a{font-size:15px}
table.hrs{border-collapse:collapse;font-size:14px}
table.hrs td{padding:2px 14px 2px 0;color:var(--ink)}
table.hrs td:first-child{color:var(--muted);font-family:var(--font-mono);font-size:12px;width:44px}
.hn{display:block;font-size:12.5px;color:var(--muted);margin-top:6px}
.related{border-top:1px solid var(--line);margin-top:26px;padding-top:6px}
.related h2{font-family:var(--font-display);font-weight:900;letter-spacing:var(--tracking-subsection);font-size:var(--type-subsection);margin:18px 0 12px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:0 0 26px}
@media(max-width:620px){.cards{grid-template-columns:1fr}}
.gcard{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;text-decoration:none;color:var(--ink);transition:border-color .15s,transform .15s}
.gcard:hover{border-color:var(--navy);transform:translateY(-2px)}
.gcard .t{font-family:var(--font-display);font-weight:900;letter-spacing:var(--tracking-card);font-size:var(--type-card-title);margin-bottom:5px;line-height:var(--leading-title)}
.gcard .d{font-size:13.5px;color:var(--muted);line-height:1.5}
.pfilter{width:100%;max-width:420px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:15px;background:#fff;margin:0 0 18px}
.pfilter:focus{outline:2px solid var(--navy);outline-offset:1px;border-color:var(--navy)}
.plist{list-style:none;margin:0 0 30px;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:2px 20px}
@media(max-width:680px){.plist{grid-template-columns:1fr}}
.plist a{display:flex;align-items:center;gap:9px;padding:8px 4px;text-decoration:none;color:var(--ink);border-bottom:1px solid #eef1f5;font-size:14px}
.plist a:hover{color:var(--navy)}
.plist .d{width:9px;height:9px;border-radius:50%;flex:none}
.plist .d.open{background:var(--open)}.plist .d.partial{background:var(--partial-bright)}.plist .d.closed{background:var(--closed)}.plist .d.nodata{background:#9aa4b2}
.plist .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.plist .st{font-family:var(--font-mono);font-size:11px;color:var(--muted);flex:none}
footer.site{border-top:1px solid var(--line);background:var(--navy);color:#c3cee0;margin-top:40px}
footer.site .wrap{max-width:1080px;padding:26px 22px;font-size:13px;display:grid;gap:8px}
footer.site a{color:#fff}
footer.site .disc{font-family:var(--font-mono);font-size:11.5px;opacity:.75;line-height:1.6}
footer.site .frow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
footer.site .frow .wordmark{color:#fff;font-size:20px}
footer.site .sister{font-family:var(--font-mono);font-size:12px;color:#9fb0c9}
footer.site .sister a{color:#fff;font-weight:bold}
footer.site .corp{display:block;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.02em;color:#7f8da6;opacity:.9;border-top:1px solid #1e2c49;padding-top:12px;margin-top:4px}
#shutdown-banner{display:none}
#shutdown-banner.show{display:block;background:var(--closed);color:#fff}
#shutdown-banner .sb-in{max-width:1080px;margin:0 auto;padding:11px 22px;font-size:14px}
#shutdown-banner strong{font-family:var(--font-display);letter-spacing:var(--tracking-tight);margin-right:6px}
#shutdown-banner a{color:#fff;font-weight:bold;text-decoration:underline;white-space:nowrap}
.blist{list-style:none;margin:0 0 30px;padding:0;display:grid;gap:10px}
.blist li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.blist .bh{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.blist .bh .d{width:10px;height:10px;border-radius:50%;flex:none}
.blist .bh .d.open{background:var(--open)}.blist .bh .d.partial{background:var(--partial-bright)}.blist .bh .d.closed{background:var(--closed)}.blist .bh .d.nodata{background:#9aa4b2}
.blist .nm{font-weight:bold;flex:1;min-width:120px}
.blist .bl{font-family:var(--font-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.blist .br{font-size:13.5px;color:var(--muted);margin:6px 0 0}
.blist .bm{font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-top:5px}
.blist .bm a{color:var(--muted)}
.hubgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 26px;list-style:none;padding:0}
@media(max-width:620px){.hubgrid{grid-template-columns:1fr}}
.hubgrid a{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;text-decoration:none;color:var(--ink)}
.hubgrid a:hover{border-color:var(--navy)}
.hubgrid .t{font-weight:bold;margin-bottom:4px}
.hubgrid .m{font-family:var(--font-mono);font-size:11px;color:var(--muted)}

/* road-status pages (additive) */
.road-window{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:18px 0;background:var(--card)}
.road-window h2{margin-top:0}
.road-window .src{font-size:12px;color:var(--muted);margin:10px 0 0}
.road-hist{border-collapse:collapse;font-size:14px;margin-top:10px}
.road-hist th,.road-hist td{text-align:left;padding:3px 20px 3px 0;color:var(--muted)}
.road-hist th{color:var(--ink);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.road-parent-status{font-size:13px;color:var(--muted);margin:6px 0 0}
.roads-in-park{margin:22px 0}
.roads-in-park ul{margin:8px 0 0;padding-left:18px}
.roads-in-park li{margin:4px 0}
.road-group{margin:22px 0}
.road-group h2{font-size:var(--type-road-group);margin:0 0 8px;letter-spacing:var(--tracking-tight)}
.road-group h2 a{color:inherit;text-decoration:none}
.road-group .plist li .st{font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-left:8px}

/* government-shutdown note on NPS park pages (additive) */
.shutdown-note{border:1px solid var(--closed);border-left:5px solid var(--closed);background:var(--closed-tint);border-radius:12px;padding:14px 16px;margin:0 0 22px}
.shutdown-note h2{margin:0 0 6px;font-size:var(--type-note-title);letter-spacing:var(--tracking-note)}
.shutdown-note p{margin:0;font-size:14px}

/* /reservations/ index (additive) */
.resv-wrap{overflow-x:auto}
.resv{width:100%;border-collapse:collapse;font-size:14px;margin:18px 0 24px}
.resv th,.resv td{text-align:left;padding:9px 12px 9px 0;border-bottom:1px solid var(--line);vertical-align:top}
.resv th{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.resv td:first-child{font-weight:bold}
.resv-dropped{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 22px;font-size:14px}
`;

function sitemap(list, updatedISO, beachHubs, roads) {
  const today = updatedISO.slice(0, 10);
  const staticUrls = [
    { loc: `${SITE}/`, freq: "hourly", pri: "1.0" },
    { loc: `${SITE}/park/`, freq: "hourly", pri: "0.9" },
    { loc: `${SITE}/shutdown/`, freq: "daily", pri: "0.9" },
    { loc: `${SITE}/reservations/`, freq: "monthly", pri: "0.7" },
    { loc: `${SITE}/road/`, freq: "weekly", pri: "0.8" },
    { loc: `${SITE}/beach/`, freq: "daily", pri: "0.8" },
    { loc: `${SITE}/guides/`, freq: "weekly", pri: "0.8" },
    { loc: `${SITE}/guides/national-parks-government-shutdown.html`, freq: "weekly", pri: "0.9" },
    { loc: `${SITE}/guides/why-national-parks-close.html`, freq: "monthly", pri: "0.7" },
    { loc: `${SITE}/guides/nps-alerts-explained.html`, freq: "monthly", pri: "0.7" },
    { loc: `${SITE}/guides/how-we-check-park-status.html`, freq: "monthly", pri: "0.6" },
    { loc: `${SITE}/privacy.html`, freq: "yearly", pri: "0.3" },
    { loc: `${SITE}/support.html`, freq: "yearly", pri: "0.3" },
  ];
  const parkUrls = list.slice().sort((a, b) => a.slug.localeCompare(b.slug))
    .map((e) => ({ loc: `${SITE}/park/${e.slug}/`, freq: "hourly", pri: "0.7" }));
  const beachUrls = (beachHubs || []).slice().sort((a, b) => a.slug.localeCompare(b.slug))
    .map((h) => ({ loc: `${SITE}/beach/${h.slug}/`, freq: "daily", pri: "0.6" }));
  const roadUrls = (roads || []).slice().sort((a, b) => a.slug.localeCompare(b.slug))
    .map((r) => ({ loc: `${SITE}/road/${r.slug}/`, freq: "weekly", pri: "0.7" }));
  const body = [...staticUrls, ...parkUrls, ...roadUrls, ...beachUrls]
    .map((u) => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// ===================== llms.txt ==========================================
// https://llmstxt.org — a curated map of the site for language models.
function llmsTxt(updatedISO, entities, beachHubs, tally, roads) {
  const nps = entities.filter((e) => e.source === "nps").length;
  const state = entities.length - nps;
  const asOf = fmtLong(updatedISO);
  return `# Park Status Today

> Live open / partially-closed / closed status for U.S. national parks, four state park systems (New York, California, Texas, Minnesota), and New York public beaches. Every status is derived hourly from official sources: National Park Service alerts and operating hours, state park-system alerts, and state / county health-department beach monitoring.

Park Status Today is an independent informational service, not affiliated with the National Park Service or any state or county agency. Each status is our reading of public data, not an official determination, and is refreshed hourly. Every park page and beach-county page states the current status as plain text with the UTC time it was last checked, and carries schema.org structured data (TouristAttraction / Park, FAQPage with a dated answer, and — where known — openingHoursSpecification).

Coverage as of ${asOf}: ${nps} National Park Service units, ${state} state parks, and ${beachHubs.reduce((n, h) => n + h.beaches.length, 0)} monitored New York beaches across ${beachHubs.length} counties. Site-wide that is ${tally.open} open, ${tally.partially_closed} partially closed, ${tally.closed} closed, ${tally.no_data} without data.

## Parks
- [All park & waterway statuses, A–Z](${SITE}/park/): browsable directory of every national and state park tracked, each linking to a status + visitor-info page at ${SITE}/park/<slug>/
- [Full sitemap](${SITE}/sitemap.xml): every page on the site

## Roads
- [Park road status](${SITE}/road/): seasonal opening/closing dates and live closure status for major national-park roads, each at ${SITE}/road/<slug>/
${(roads || []).map((r) => `- [Is ${r.name} open?](${SITE}/road/${r.slug}/)`).join("\n")}

## Reservations & timed entry
- [Which national parks require a reservation in 2026?](${SITE}/reservations/): the national parks with a timed-entry or vehicle reservation requirement, their 2026 seasons and booking links; also names the parks (Arches, Glacier, Mount Rainier, Yosemite) that dropped timed entry for 2026

## Beaches
- [Beach water quality & closures by county](${SITE}/beach/): New York public beaches grouped by county, with current swimming advisories and closures at ${SITE}/beach/<county>/

## Government shutdown
- [Are the national parks open during a government shutdown? (live status)](${SITE}/shutdown/): checked hourly against the NPS operating-status page; evergreen when there is no shutdown
- [What a government shutdown means for the national parks (explainer)](${SITE}/guides/national-parks-government-shutdown.html)

## Guides
- [How we check park status](${SITE}/guides/how-we-check-park-status.html): the method and sources behind every status
- [Why national parks close](${SITE}/guides/why-national-parks-close.html)
- [NPS alerts explained](${SITE}/guides/nps-alerts-explained.html): Danger, Closure, Caution, Information

## Structured data
- [Status API (JSON)](${API}): current open/partial/closed status, coordinates, and reason for every park and beach, updated hourly
- [Park enrichment data (JSON)](${SITE}/parks-enriched.json): descriptions, operating hours, addresses, and Wikipedia extracts keyed by park id

## Attribution
Cite as "Park Status Today (parkstatus.today)". Status figures are time-sensitive — include the "as of" date shown on the page.
`;
}

// ===================== beach county hubs ==================================
function beachRow(b) {
  const cls = BEACH_CLASS[beach4(b.status)] || "nodata";
  const lab = b.statusLabel || BEACH_LABEL[b.status] || b.status || "Unknown";
  const flagged = b.status === "advisory" || b.status === "closed";
  const dates = flagged && b.startDate
    ? (b.endDate ? `in effect ${b.startDate} → ${b.endDate}` : `in effect since ${b.startDate}`)
    : "";
  const meta = [
    b.waterbody ? esc(b.waterbody) : "",
    dates,
    b.jurisdiction ? `<a href="${esc(b.jurisdictionUrl || "#")}" target="_blank" rel="noopener">${esc(b.jurisdiction)} ↗</a>` : "",
  ].filter(Boolean).join(" · ");
  return `<li id="b-${esc(b.id)}">
  <div class="bh"><span class="d ${cls}"></span><span class="nm">${esc(b.name)}</span><span class="bl" data-role="label">${esc(lab)}</span></div>
  ${b.reason ? `<p class="br" data-role="reason">${esc(b.reason.trim())}</p>` : ""}
  ${meta ? `<div class="bm">${meta}</div>` : ""}
</li>`;
}

function beachHubHtml(g, updatedISO, tally) {
  const url = `${SITE}/beach/${g.slug}/`;
  const lt = { open: 0, partially_closed: 0, closed: 0, no_data: 0 };
  g.beaches.forEach((b) => lt[beach4(b.status)]++);
  const flagged = g.beaches.filter((b) => b.status === "advisory" || b.status === "closed")
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const asOf = fmtLong(updatedISO);
  const rows = g.beaches.map(beachRow).join("\n");
  const desc = `Current swimming advisories, closures and water-quality status for ${g.beaches.length} monitored beaches in ${g.label}. ${lt.partially_closed} under advisory, ${lt.closed} closed as of ${asOf}.`;

  const faqText = flagged.length
    ? `As of ${asOf}: ${flagged.map((b) => `${b.name} (${b.statusLabel || BEACH_LABEL[b.status] || b.status})`).join("; ")}.`
    : `As of ${asOf}, no beaches in ${g.label} are under a swimming advisory or closure in our data.`;
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Beaches", item: SITE + "/beach/" },
        { "@type": "ListItem", position: 3, name: g.label, item: url } ] },
      { "@type": "FAQPage", mainEntity: [{
        "@type": "Question",
        name: `Which beaches in ${g.label} have swimming advisories or closures right now?`,
        acceptedAnswer: { "@type": "Answer", text: faqText },
      }] },
      { "@type": "ItemList", name: `${g.label} beaches`, numberOfItems: g.beaches.length,
        itemListElement: g.beaches.map((b, i) => {
          const item = { "@type": "Beach", name: b.name, url: url + "#b-" + b.id };
          if (typeof b.lat === "number" && typeof b.lon === "number") item.geo = { "@type": "GeoCoordinates", latitude: b.lat, longitude: b.lon };
          item.additionalProperty = { "@type": "PropertyValue", name: "status", value: b.statusLabel || BEACH_LABEL[b.status] || b.status };
          return { "@type": "ListItem", position: i + 1, item };
        }) },
    ],
  };

  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>${esc(g.label)} beach water quality &amp; closures — Park Status Today</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0b1b35">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(g.label)} beach water quality &amp; closures">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/park/park.css">
</head>
<body>
<div id="shutdown-banner"></div>
<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>
${stripHtml(tally, updatedISO)}
<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / <a href="/beach/">Beaches</a> / ${esc(g.label)}</div>
  <h1>${esc(g.label)}: beach water quality &amp; closures</h1>
  <p class="sub">${esc(g.state)} · ${g.beaches.length} monitored beaches · <b id="h-open">${lt.open}</b> open · <b id="h-partial">${lt.partially_closed}</b> advisory · <b id="h-closed">${lt.closed}</b> closed · <b id="h-nodata">${lt.no_data}</b> no data</p>

  <div class="verdict ${flagged.length ? "partial" : "open"}">
    <p class="line">${flagged.length
      ? `${flagged.length} beach${flagged.length === 1 ? "" : "es"} in ${esc(g.label)} ${flagged.length === 1 ? "is" : "are"} under a swimming advisory or closure right now.`
      : `No swimming advisories or closures reported for ${esc(g.label)} right now.`}</p>
    <p class="checked">As of ${esc(new Date(updatedISO).toUTCString())} · refreshes hourly</p>
  </div>

  <ul class="blist">
${rows}
  </ul>

  <article>
    <h2>Where this comes from</h2>
    <p>Beach status reflects public monitoring data from the New York State Department of Health and county health departments — <em>Open</em>, <em>Water quality advisory</em>, or <em>Closed to swimming</em>. Some beaches are managed by another agency and show as “no data.” It is <strong>our reading</strong> of that data, not an official determination, and it refreshes hourly. Always confirm with the operating agency before you swim.</p>
  </article>

  <div class="related">
    <h2>More</h2>
    <div class="cards">
      <a class="gcard" href="/beach/"><div class="t">All beach counties</div><div class="d">Water-quality status for every county we track.</div></a>
      <a class="gcard" href="/park/"><div class="t">All park statuses</div><div class="d">National and state parks, A–Z.</div></a>
      <a class="gcard" href="/#map"><div class="t">Live map</div><div class="d">See what's open near you right now.</div></a>
      <a class="gcard" href="/#signup"><div class="t">Get alerts</div><div class="d">Email or push when something near you closes.</div></a>
    </div>
  </div>
</main>
<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span><b>Park Status Today</b> — an independent informational service, not affiliated with any state or county agency.</span>
  <span class="disc">Live status refreshed hourly · always confirm with the operating agency before you travel.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>
<script>
(function(){
  var API="${API}";
  function b4(s){return s==="advisory"?"partially_closed":(s==="open"||s==="closed")?s:"no_data";}
  var CLS={open:"open",partially_closed:"partial",closed:"closed",no_data:"nodata"};
  var LAB=${JSON.stringify(BEACH_LABEL)};
  function set(id,v){var e=document.getElementById(id);if(e&&v!=null)e.textContent=v;}
  fetch(API,{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    var c={open:0,partially_closed:0,closed:0,no_data:0};
    var add=function(a,mk){(a||[]).forEach(function(x){var s=mk?mk(x.status):x.status;if(s in c)c[s]++;});};
    add(d.parks);add(d.nyParks);add(d.caParks);add(d.txParks);add(d.mnParks);add(d.flParks);add(d.waParks);add(d.usfs);add(d.beaches,b4);
    set("s-open",c.open);set("s-partial",c.partially_closed);set("s-closed",c.closed);set("s-nodata",c.no_data);
    if(d.updated){var dt=new Date(d.updated);set("s-upd","updated "+dt.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+dt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}));}
    var lt={open:0,partially_closed:0,closed:0,no_data:0};
    (d.beaches||[]).forEach(function(x){
      var row=document.getElementById("b-"+x.id); if(!row)return;
      lt[b4(x.status)]++;
      var dot=row.querySelector(".d"); if(dot)dot.className="d "+(CLS[b4(x.status)]||"nodata");
      var lab=row.querySelector('[data-role=label]'); if(lab)lab.textContent=x.statusLabel||LAB[x.status]||x.status;
      var rs=row.querySelector('[data-role=reason]'); if(rs&&x.reason)rs.textContent=x.reason;
    });
    if(lt.open+lt.partially_closed+lt.closed+lt.no_data){
      set("h-open",lt.open);set("h-partial",lt.partially_closed);set("h-closed",lt.closed);set("h-nodata",lt.no_data);
    }
  }).catch(function(){});
  fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
    if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
    b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
  }).catch(function(){});
})();
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

function beachIndexHtml(hubs, updatedISO, tally) {
  const url = `${SITE}/beach/`;
  const total = hubs.reduce((n, h) => n + h.beaches.length, 0);
  const flaggedTotal = hubs.reduce((n, h) => n + h.beaches.filter((b) => b.status === "advisory" || b.status === "closed").length, 0);
  const asOf = fmtLong(updatedISO);
  const cards = hubs.map((h) => {
    const lt = { adv: 0, closed: 0 };
    h.beaches.forEach((b) => { if (b.status === "advisory") lt.adv++; if (b.status === "closed") lt.closed++; });
    const tag = lt.closed ? `${lt.closed} closed` : lt.adv ? `${lt.adv} advisory` : "all clear";
    return `<li><a href="/beach/${h.slug}/"><div class="t">${esc(h.label)}</div><div class="m">${h.beaches.length} beaches · ${tag}</div></a></li>`;
  }).join("\n");
  const desc = `Swimming advisories and water-quality closures for ${total} monitored beaches across ${hubs.length} counties. ${flaggedTotal} under advisory or closed as of ${asOf}.`;
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Beaches", item: url } ] },
      { "@type": "ItemList", name: "Beach water quality by county", numberOfItems: hubs.length,
        itemListElement: hubs.map((h, i) => ({ "@type": "ListItem", position: i + 1, name: h.label, url: `${SITE}/beach/${h.slug}/` })) },
    ],
  };
  return `<!doctype html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PFZYJ3L871"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PFZYJ3L871');</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${INDEXERNOW}
<title>Beach water quality &amp; closures by county — Park Status Today</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:title" content="Beach water quality &amp; closures by county">
<meta property="og:url" content="${url}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/park/park.css">
</head>
<body>
<div id="shutdown-banner"></div>
<header class="site"><div class="wrap">
  <a class="wordmark" href="/" aria-label="Park Status home">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a>
  ${siteNav()}
</div></header>
${stripHtml(tally, updatedISO)}
<main class="wrap">
  <div class="crumbs"><a href="/">Home</a> / Beaches</div>
  <h1>Beach water quality &amp; closures</h1>
  <p class="sub">${total} monitored beaches · ${hubs.length} counties · ${flaggedTotal} under advisory or closed as of ${esc(fmtUpd(updatedISO))}</p>
  <ul class="hubgrid">
${cards}
  </ul>
  <article>
    <h2>About this data</h2>
    <p>Beaches are grouped by county. Status reflects public monitoring from the New York State Department of Health and county health departments and refreshes hourly. It is <strong>our reading</strong> of that data, not an official determination — always confirm with the operating agency before you swim.</p>
  </article>
</main>
<footer class="site"><div class="wrap">
  <div class="frow"><a class="wordmark" href="/" aria-label="Park Status">PARK<span class="flag-mark" aria-hidden="true"><i></i><i></i><i></i></span>STATUS</a><span class="sister">A sister site of <a href="https://half-mast.com" target="_blank" rel="noopener">half-mast.com ↗</a></span></div>
  <span class="disc">Live status refreshed hourly · always confirm with the operating agency before you travel.</span>
  <span class="disc"><a href="/privacy.html" style="color:#fff">Privacy</a> · <a href="/support.html" style="color:#fff">Support</a></span>
  <span class="corp">${CORP_LINE}</span>
</div></footer>
<script>
(function(){
  function b4(s){return s==="advisory"?"partially_closed":(s==="open"||s==="closed")?s:"no_data";}
  fetch("${API}",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    var c={open:0,partially_closed:0,closed:0,no_data:0},set=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
    var add=function(a,mk){(a||[]).forEach(function(x){var s=mk?mk(x.status):x.status;if(s in c)c[s]++;});};
    add(d.parks);add(d.nyParks);add(d.caParks);add(d.txParks);add(d.mnParks);add(d.flParks);add(d.waParks);add(d.usfs);add(d.beaches,b4);
    set("s-open",c.open);set("s-partial",c.partially_closed);set("s-closed",c.closed);set("s-nodata",c.no_data);
    if(d.updated){var dt=new Date(d.updated);set("s-upd","updated "+dt.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+dt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}));}
  }).catch(function(){});
  fetch("/shutdown.json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
    if(!s||!s.active)return;var b=document.getElementById("shutdown-banner");if(!b)return;
    b.innerHTML='<div class="sb-in"><strong>'+s.headline+'</strong> '+(s.message||"")+' <a href="'+(s.url||"#")+'">'+(s.cta||"Learn more →")+'</a></div>';b.className="show";
  }).catch(function(){});
})();
</script>
<script src="/app-native.js" defer></script>
</body>
</html>
`;
}

// ===================== main ===============================================
async function main() {
  process.stdout.write(`Fetching status blob ${API} …\n`);
  const res = await fetch(API, { headers: { "cache-control": "no-store" } });
  if (!res.ok) throw new Error(`status API returned ${res.status}`);
  const data = await res.json();
  const updatedISO = data.updated || new Date().toISOString();

  const entities = collectEntities(data);
  if (entities.length < 100) throw new Error("too few entities — aborting so we don't wipe the site");
  process.stdout.write(`  ${entities.length} entities (NPS + NY/CA/TX/MN state parks)\n`);

  // Site-wide 4-status count, baked into every page's status strip.
  const tally = combinedTally(data);

  // Beach county hubs, grouped by state + county.
  const BOROUGH = {
    Kings: "Kings County (Brooklyn)", Richmond: "Richmond County (Staten Island)",
    "New York": "New York County (Manhattan)", Bronx: "Bronx County", Queens: "Queens County",
  };
  const bgroups = new Map();
  for (const bch of data.beaches || []) {
    if (typeof bch.lat !== "number" || typeof bch.lon !== "number") continue;
    const county = String(bch.county || "Other").trim();
    const key = (bch.state || "") + "|" + county;
    if (!bgroups.has(key)) {
      const base = BOROUGH[county] || (/count(y|ies)$/i.test(county) ? county : county + " County");
      bgroups.set(key, {
        state: bch.state || "", county,
        label: base + (bch.state ? ", " + bch.state : ""),
        slug: slugify((bch.state || "") + "-" + county + (/count(y|ies)$/i.test(county) ? "" : "-county")),
        beaches: [],
      });
    }
    bgroups.get(key).beaches.push(bch);
  }
  const beachHubs = [...bgroups.values()]
    .filter((g) => g.beaches.length >= 2)
    .sort((a, b) => a.label.localeCompare(b.label));
  beachHubs.forEach((g) => g.beaches.sort((a, b) => String(a.name).localeCompare(String(b.name))));
  process.stdout.write(`  ${beachHubs.length} beach county hubs (${beachHubs.reduce((n, g) => n + g.beaches.length, 0)} beaches)\n`);

  // forests.json — simplified National Forest footprints for the Worker's
  // wildfire-proximity check. Regenerated daily; the boundaries rarely move.
  try {
    const forests = await buildForests();
    const fv = forests.reduce((s, f) => s + f.polys.reduce((n, r) => n + r.length, 0), 0);
    fs.writeFileSync(path.join(OUT, "forests.json"), JSON.stringify({ updated: updatedISO, forests }));
    process.stdout.write(`  forests.json: ${forests.length} national forests, ${fv} boundary vertices\n`);
  } catch (e) {
    process.stdout.write(`  forests.json SKIPPED (${e.message}) — keeping previous file\n`);
  }

  process.stdout.write("Pulling NPS rich fields …\n");
  const nps = await npsRich().catch((e) => { console.warn("  NPS rich fetch failed:", e.message); return {}; });

  process.stdout.write(`Enriching from Wikipedia (${entities.length} lookups, ~10 min) …\n`);
  let done = 0;
  const enrichList = await mapPool(entities, 4, async (e) => {
    const w = await enrichWikipedia(e.name);
    if (++done % 100 === 0) process.stdout.write(`  ${done}/${entities.length}\n`);
    return w;
  });
  process.stdout.write(`  matched ${enrichList.filter(Boolean).length}/${entities.length}\n`);

  const enriched = {};
  entities.forEach((e, i) => {
    const w = enrichList[i] || {};
    const np = e.source === "nps" ? nps[e.code] : null;
    const st = firstState(e);
    const gmaps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(e.name + (st ? ", " + st : ""));
    const en = {
      name: e.name, kind: e.kind, state: st,
      description: np ? clip(np.description, 600) : "",
      history: w.history || "",
      photo: (np && (np.images || [])[0] && np.images[0].url) || w.photo || null,
      wiki: w.wiki || null,
      address: np ? npsAddress(np) : (e.county ? e.county : ""),
      phone: np ? ((np.contacts && np.contacts.phoneNumbers || [])[0] || {}).phoneNumber || "" : "",
      email: np ? ((np.contacts && np.contacts.emailAddresses || [])[0] || {}).emailAddress || "" : "",
      website: np ? np.url : e.url || "",
      hours: np ? npsHours(np) : null,
      directions: np ? clip(np.directionsInfo, 400) : "",
      fee: np ? npsFee(np) : null,
      reservation: RESERVATIONS[e.id] || null,
      gmaps,
    };
    // trim empties
    Object.keys(en).forEach((k) => { if (en[k] === "" || en[k] == null) delete en[k]; });
    en.slug = e.slug;
    enriched[e.id] = en;
    e._en = en;
  });

  // --- road-status pages: verdict comes from the Worker blob (blob.roads),
  //     computed hourly there. roadStatus()/npsAlerts() below are a FALLBACK,
  //     run only for slugs the blob doesn't carry (first deploy race / Worker
  //     error). The canonical copy of roadStatus() lives in worker.js. ---
  const entById = new Map(entities.map((e) => [e.id, e]));
  const roadsAll = Object.entries(ROADS).filter(([k]) => k !== "_note").map(([slug, r]) => ({ slug, ...r }));
  const published = roadsAll.filter((r) => r.datesReviewed === true).map((r) => {
    const parents = (r.parentIds || []).map((id) => entById.get(id)).filter(Boolean)
      .map((e) => ({ id: e.id, source: e.source, name: e.name, slug: e.slug }));
    return { ...r, parents, parentNames: parents.map((p) => p.name).join(" and ") };
  });
  const roadBlob = new Map((data.roads || []).map((r) => [r.slug, r]));
  const roadMissing = published.filter((r) => !roadBlob.has(r.slug));
  const npsRoadCodes = [...new Set(roadMissing.flatMap((r) => r.parentIds || [])
    .filter((p) => p.startsWith("nps:")).map((p) => p.slice(4)))];
  const roadAlerts = npsRoadCodes.length
    ? await npsAlerts(npsRoadCodes).catch((e) => { console.warn("  NPS alerts fetch failed:", e.message); return {}; })
    : {};
  const parkStatusById = Object.fromEntries(entities.map((e) => [e.id, e.status]));
  const roadStatuses = new Map(published.map((r) => {
    const b = roadBlob.get(r.slug);
    const st = b
      ? { tier: b.tier, status: b.status, cls: b.cls, reason: b.reason, date: b.date || "" }
      : roadStatus(r, roadAlerts, parkStatusById);
    return [r.slug, st];
  }));
  const roadsByPark = {};
  for (const r of published) for (const pid of (r.parentIds || [])) (roadsByPark[pid] ||= []).push(r);
  process.stdout.write(`  ${published.length}/${roadsAll.length} road pages (${roadBlob.size ? `${published.length - roadMissing.length} from blob, ${roadMissing.length} fallback` : "blob has no roads — all computed locally"})\n`);

  const shutdown = data.shutdown || { active: false };
  process.stdout.write(`  shutdown: ${shutdown.active ? "ACTIVE" : "none"}${shutdown.stale ? " (stale)" : ""}\n`);

  fs.mkdirSync(PARK_DIR, { recursive: true });
  fs.writeFileSync(path.join(PARK_DIR, "park.css"), PARK_CSS);

  let n = 0;
  for (const e of entities) {
    const dir = path.join(PARK_DIR, e.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), pageHtml(e, e._en, updatedISO, tally, roadsByPark[e.id] || [], shutdown));
    n++;
  }
  fs.writeFileSync(path.join(PARK_DIR, "index.html"), directoryHtml(entities, updatedISO, tally));

  const BEACH_DIR = path.join(OUT, "beach");
  fs.mkdirSync(BEACH_DIR, { recursive: true });
  for (const g of beachHubs) {
    const dir = path.join(BEACH_DIR, g.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), beachHubHtml(g, updatedISO, tally));
  }
  fs.writeFileSync(path.join(BEACH_DIR, "index.html"), beachIndexHtml(beachHubs, updatedISO, tally));

  const SHUTDOWN_DIR = path.join(OUT, "shutdown");
  fs.mkdirSync(SHUTDOWN_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHUTDOWN_DIR, "index.html"), shutdownPageHtml(shutdown, updatedISO, tally));

  const RESV_DIR = path.join(OUT, "reservations");
  fs.mkdirSync(RESV_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESV_DIR, "index.html"), reservationsIndexHtml(RESERVATIONS, entities, updatedISO, tally));

  const ROAD_DIR = path.join(OUT, "road");
  fs.mkdirSync(ROAD_DIR, { recursive: true });
  for (const r of published) {
    const dir = path.join(ROAD_DIR, r.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), roadPageHtml(r, roadStatuses.get(r.slug), updatedISO, tally));
  }
  fs.writeFileSync(path.join(ROAD_DIR, "index.html"), roadIndexHtml(published, updatedISO, tally, roadStatuses));

  // Publish roads.json to the site so the Worker can read road metadata hourly
  // (same delivery pattern as forests.json). Verbatim copy of the repo-root file.
  fs.writeFileSync(path.join(OUT, "roads.json"), JSON.stringify(ROADS));

  fs.writeFileSync(path.join(OUT, "parks-enriched.json"), JSON.stringify(enriched));
  fs.writeFileSync(path.join(OUT, "parks.json"), JSON.stringify({
    updated: updatedISO,
    parks: entities.map((e) => ({ id: e.id, slug: e.slug, name: e.name, kind: e.kind,
      states: statesText(e), status: e.status, source: e.source, url: `${SITE}/park/${e.slug}/` })),
  }));
  fs.writeFileSync(path.join(OUT, "sitemap.xml"), sitemap(entities, updatedISO, beachHubs, published));
  fs.writeFileSync(path.join(OUT, "llms.txt"), llmsTxt(updatedISO, entities, beachHubs, tally, published));

  const withWiki = Object.values(enriched).filter((x) => x.history).length;
  const withNps = Object.values(enriched).filter((x) => x.hours || x.address).length;
  process.stdout.write(
    `\nDone.\n  ${n} park pages + directory\n` +
    `  ${beachHubs.length} beach county hubs + index\n` +
    `  parks-enriched.json: ${withWiki} with Wikipedia about/history, ${withNps} with NPS visitor info\n` +
    `  baked tally: ${tally.open} open / ${tally.partially_closed} partial / ${tally.closed} closed / ${tally.no_data} no-data\n` +
    `  sitemap.xml: ${entities.length + beachHubs.length + published.length + 12} urls\n  data timestamp: ${updatedISO}\n`
  );
}

main().catch((e) => { console.error("\nbuild-parks failed:", e.stack || e.message); process.exit(1); });
