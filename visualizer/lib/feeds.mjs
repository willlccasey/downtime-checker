import { offline, readDataset, writeDataset } from "./datapack.mjs";

const UA = { "User-Agent": "downtime-checker/1.0 (globe visualizer)" };

// Jonesboro hub — same origin the globes draw search arcs from.
const ORIGIN = { lat: 35.84, lon: -90.7 };
const ADSB_BASE = "https://api.adsb.lol";
const ADSB_TTL_MS = 15 * 60 * 1000;
const ADSB_DISPLAY_CAP = 2500;
const FT_TO_M = 0.3048;

// 250 nm circles around busy terminals. Public /v2 has no world snapshot;
// each circle is one metered request (500/day unkeyed).
const ADSB_HUBS = [
  [ORIGIN.lat, ORIGIN.lon],
  [40.64, -73.78],
  [33.94, -118.41],
  [41.98, -87.9],
  [32.9, -97.04],
  [25.8, -80.29],
  [47.45, -122.31],
  [39.86, -104.67],
  [51.47, -0.46],
  [50.04, 8.56],
  [49.01, 2.55],
  [52.31, 4.76],
  [41.8, 12.25],
  [40.47, -3.56],
  [55.97, 37.41],
  [25.25, 55.36],
  [28.56, 77.1],
  [1.36, 103.99],
  [35.55, 139.78],
  [22.31, 113.91],
  [31.14, 121.81],
  [-33.95, 151.18],
  [-23.43, -46.47],
  [19.44, -99.07],
  [-26.13, 28.23],
];

const ADSB_CYCLE = ["origin", "mil", "hub", "ladd", "hub", "pia", "hub", "squawk7700"];
const aircraftLive = new Map();
let adsbStep = 0;
let adsbHub = 1;
let adsbBackoffUntil = 0;
let adsbQuotaLeft = null;
let adsbPrimed = false;

const CFR_COORDS = {
  "al-shabab-somalia": [2.05, 45.32],
  "civil-war-libya": [32.89, 13.19],
  "civil-war-south-sudan": [4.86, 31.57],
  "conflict-between-india-and-pakistan": [34.15, 74.8],
  "conflict-between-turkey-and-armed-kurdish-groups": [37.3, 43.5],
  "conflict-ethiopia": [9.03, 38.74],
  "conflict-syria": [33.51, 36.29],
  "conflict-ukraine": [48.45, 35.0],
  "confrontation-between-united-states-and-iran": [32.0, 53.0],
  "confrontation-over-taiwan": [23.7, 121.0],
  "criminal-violence-mexico": [19.43, -99.13],
  "instability-haiti": [18.54, -72.34],
  "instability-venezuela": [10.48, -66.9],
  "israeli-palestinian-conflict": [31.5, 34.75],
  "nagorno-karabakh-conflict": [39.82, 46.75],
  "north-korea-crisis": [39.04, 125.75],
  "political-instability-iraq": [33.3, 44.4],
  "political-instability-lebanon": [33.85, 35.5],
  "power-struggle-sudan": [15.5, 32.5],
  "rohingya-crisis-myanmar": [20.0, 96.0],
  "territorial-disputes-south-china-sea": [12.0, 114.0],
  "violence-central-african-republic": [4.39, 18.56],
  "violence-democratic-republic-congo": [-1.7, 29.2],
  "violent-extremism-sahel": [15.0, 0.0],
  "violent-instability-northern-triangle": [14.6, -88.0],
  "war-afghanistan": [34.53, 69.17],
  "war-yemen": [15.35, 44.2],
};

function emptyLayer(source = "") {
  return { points: [], count: 0, updated: null, source, error: null, at: 0 };
}

const layers = {
  jamming: emptyLayer("gpsinterference.com"),
  aircraft: emptyLayer("adsb.lol"),
  ships: emptyLayer("digitraffic"),
  conflicts: emptyLayer("cfr.org"),
};

const shipsLive = new Map();
let aisSocket = null;

async function pull(url, headers = {}) {
  const res = await fetch(url, {
    headers: { ...UA, ...headers },
    signal: AbortSignal.timeout(28000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

function adsbHeaders() {
  const key = process.env.ADSB_LOL_API_KEY;
  return key ? { "x-api-key": key } : {};
}

function adsbPollMs() {
  return process.env.ADSB_LOL_API_KEY ? 45 * 1000 : 3 * 60 * 1000;
}

function noteAdsbQuota(res) {
  const left = res.headers.get("x-ratelimit-remaining");
  if (left != null) adsbQuotaLeft = Number(left);
}

function mapAdsbAircraft(ac, tag) {
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const flags = Number(ac.dbFlags) || 0;
  const altRaw = ac.alt_baro ?? ac.alt_geom;
  const ground = altRaw === "ground";
  const altFt = ground ? 0 : Number(altRaw);
  const squawk = ac.squawk ? String(ac.squawk) : null;
  const emergency = ac.emergency && ac.emergency !== "none" ? String(ac.emergency) : null;
  return {
    lat,
    lon,
    hex: ac.hex ? String(ac.hex) : null,
    name: String(ac.flight || ac.r || ac.hex || "aircraft").trim(),
    r: ac.r ? String(ac.r).trim() : null,
    t: ac.t ? String(ac.t).trim() : null,
    alt: ground ? "ground" : Number.isFinite(altFt) ? altFt : null,
    altM: ground ? 0 : Number.isFinite(altFt) ? altFt * FT_TO_M : 0,
    track: Number(ac.track) || 0,
    gs: ac.gs ?? null,
    squawk,
    emergency,
    category: ac.category || null,
    src: ac.type || null,
    mil: Boolean(flags & 1) || tag === "mil",
    interesting: Boolean(flags & 2),
    pia: Boolean(flags & 4) || tag === "pia",
    ladd: Boolean(flags & 8) || tag === "ladd",
    baro_rate: ac.baro_rate ?? null,
    seen_pos: ac.seen_pos ?? null,
    ts: Date.now(),
  };
}

function ingestAdsbList(acList, tag) {
  for (const ac of acList || []) {
    const point = mapAdsbAircraft(ac, tag);
    if (!point) continue;
    const key = point.hex || `${point.lat.toFixed(3)},${point.lon.toFixed(3)},${point.name}`;
    const prev = aircraftLive.get(key);
    if (prev) {
      point.mil = point.mil || prev.mil;
      point.ladd = point.ladd || prev.ladd;
      point.pia = point.pia || prev.pia;
      point.interesting = point.interesting || prev.interesting;
    }
    aircraftLive.set(key, point);
  }
}

function pruneAircraft() {
  const now = Date.now();
  for (const [key, point] of aircraftLive) {
    if (now - point.ts > ADSB_TTL_MS) aircraftLive.delete(key);
  }
}

function rankAircraft(point) {
  if (point.emergency) return 0;
  if (point.squawk === "7700" || point.squawk === "7600" || point.squawk === "7500") return 1;
  if (point.mil) return 2;
  if (point.ladd || point.pia) return 3;
  return 4;
}

function publishAircraft(source, extraError = null) {
  pruneAircraft();
  const all = [...aircraftLive.values()].sort((a, b) => rankAircraft(a) - rankAircraft(b) || (b.ts - a.ts));
  const points = sample(all, ADSB_DISPLAY_CAP);
  const quota = adsbQuotaLeft == null ? "" : ` · ${adsbQuotaLeft}/day left`;
  layers.aircraft = {
    points,
    count: aircraftLive.size,
    updated: new Date().toISOString(),
    source: `${source}${quota}`,
    error: extraError,
    at: Date.now(),
  };
}

function nextAdsbJob() {
  const kind = ADSB_CYCLE[adsbStep % ADSB_CYCLE.length];
  adsbStep += 1;
  if (kind === "origin") {
    return { tag: "origin", url: `${ADSB_BASE}/v2/point/${ORIGIN.lat}/${ORIGIN.lon}/250` };
  }
  if (kind === "mil") return { tag: "mil", url: `${ADSB_BASE}/v2/mil` };
  if (kind === "ladd") return { tag: "ladd", url: `${ADSB_BASE}/v2/ladd` };
  if (kind === "pia") return { tag: "pia", url: `${ADSB_BASE}/v2/pia` };
  if (kind === "squawk7700") return { tag: "squawk7700", url: `${ADSB_BASE}/v2/squawk/7700` };
  const hub = ADSB_HUBS[adsbHub % ADSB_HUBS.length];
  adsbHub += 1;
  if (hub[0] === ORIGIN.lat && hub[1] === ORIGIN.lon) {
    const next = ADSB_HUBS[adsbHub % ADSB_HUBS.length];
    adsbHub += 1;
    return { tag: "hub", url: `${ADSB_BASE}/v2/point/${next[0]}/${next[1]}/250` };
  }
  return { tag: "hub", url: `${ADSB_BASE}/v2/point/${hub[0]}/${hub[1]}/250` };
}

async function pullAdsb(url, tag) {
  const res = await pull(url, adsbHeaders());
  noteAdsbQuota(res);
  const data = await res.json();
  ingestAdsbList(data.ac || data.aircraft || [], tag);
}

async function pullLocalFeeder() {
  const base = (process.env.ADS_B_FEEDER_URL || "").replace(/\/$/, "");
  if (!base) return;
  const paths = [`${base}/data/aircraft.json`, `${base}/tar1090/data/aircraft.json`];
  let lastErr = null;
  for (const url of paths) {
    try {
      const res = await pull(url);
      const data = await res.json();
      ingestAdsbList(data.ac || data.aircraft || [], "feeder");
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
}

function titleFromSlug(slug) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function sample(list, cap) {
  if (list.length <= cap) return list;
  const out = [];
  const step = list.length / cap;
  for (let i = 0; i < cap; i += 1) out.push(list[Math.floor(i * step)]);
  return out;
}

async function refreshJamming() {
  const res = await pull("https://api.gpsinterference.com/v1/interference/latest");
  const data = await res.json();
  const jammed = [];
  for (const hex of data.hexes || []) {
    if (!hex || hex.c === "g" || !Array.isArray(hex.poly) || hex.poly.length < 3) continue;
    let lat = 0;
    let lon = 0;
    for (const pt of hex.poly) {
      lat += Number(pt[0]);
      lon += Number(pt[1]);
    }
    jammed.push({
      lat: lat / hex.poly.length,
      lon: lon / hex.poly.length,
      band: hex.c,
      bad: Number(hex.b) || 0,
      good: Number(hex.g) || 0,
      pct: Number(hex.p) || 0,
      name: `GPS ${hex.c === "p" ? "severe" : hex.c === "r" ? "heavy" : "degraded"}`,
    });
  }
  jammed.sort((a, b) => b.pct - a.pct);
  const purple = jammed.filter((p) => p.band === "p");
  const red = jammed.filter((p) => p.band === "r");
  const yellow = jammed.filter((p) => p.band === "y");
  const points = [...purple, ...red, ...sample(yellow, 700)].slice(0, 1400);
  layers.jamming = {
    points,
    count: jammed.length,
    updated: data.updated || new Date().toISOString(),
    source: "GPSInterference.com",
    error: null,
    at: Date.now(),
  };
}

async function refreshAircraft() {
  if (Date.now() < adsbBackoffUntil) {
    publishAircraft("adsb.lol (backoff)");
    return;
  }
  const jobs = [nextAdsbJob()];
  if (!adsbPrimed) {
    adsbPrimed = true;
    jobs.push(nextAdsbJob());
  }
  try {
    for (const job of jobs) await pullAdsb(job.url, job.tag);
    try {
      await pullLocalFeeder();
    } catch {
      /* feeder is optional until an ADSB.im box exists */
    }
    publishAircraft(`adsb.lol ${jobs.map((j) => j.tag).join("+")}`);
    return;
  } catch (adsbErr) {
    const retryAfter = Number(String(adsbErr.message).match(/^429/) ? 120 : 0);
    if (String(adsbErr.message).startsWith("429")) {
      adsbBackoffUntil = Date.now() + Math.max(retryAfter, 120) * 1000;
    }
    if (aircraftLive.size) {
      publishAircraft("adsb.lol cached", adsbErr.message);
      return;
    }
    const res = await pull("https://opensky-network.org/api/states/all");
    const data = await res.json();
    const points = [];
    for (const row of data.states || []) {
      const lon = Number(row[5]);
      const lat = Number(row[6]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const altM = row[7] == null ? 0 : Number(row[7]);
      points.push({
        lat,
        lon,
        hex: row[0] ? String(row[0]) : null,
        name: String(row[1] || row[0] || "aircraft").trim(),
        alt: Number.isFinite(altM) ? Math.round(altM / FT_TO_M) : null,
        altM: Number.isFinite(altM) ? altM : 0,
        track: Number(row[10]) || 0,
        gs: row[9] == null ? null : Number(row[9]) * 1.94384,
        squawk: row[14] ? String(row[14]) : null,
        src: "opensky",
        ts: Date.now(),
      });
    }
    layers.aircraft = {
      points: sample(points, ADSB_DISPLAY_CAP),
      count: points.length,
      updated: new Date().toISOString(),
      source: "OpenSky Network",
      error: adsbErr.message,
      at: Date.now(),
    };
  }
}

async function refreshShipsRest() {
  if (process.env.AISSTREAM_API_KEY) return;
  const res = await pull("https://meri.digitraffic.fi/api/ais/v1/locations", {
    Accept: "application/geo+json",
    "Accept-Encoding": "gzip",
  });
  const data = await res.json();
  const points = [];
  for (const feat of data.features || []) {
    const coords = feat.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const props = feat.properties || {};
    points.push({
      lat: coords[1],
      lon: coords[0],
      name: String(props.mmsi || feat.mmsi || "vessel"),
      sog: props.sog,
      cog: props.cog,
    });
  }
  layers.ships = {
    points: sample(points, 900),
    count: points.length,
    updated: data.dataUpdatedTime || new Date().toISOString(),
    source: "Digitraffic AIS (Baltic)",
    error: null,
    at: Date.now(),
  };
}

function flushAisStream() {
  const now = Date.now();
  const points = [];
  for (const [mmsi, ship] of shipsLive) {
    if (now - ship.ts > 12 * 60 * 1000) {
      shipsLive.delete(mmsi);
      continue;
    }
    points.push(ship);
  }
  layers.ships = {
    points: sample(points, 1400),
    count: shipsLive.size,
    updated: new Date().toISOString(),
    source: "aisstream.io",
    error: null,
    at: now,
  };
}

function startAisStream() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key || aisSocket) return;
  try {
    aisSocket = new WebSocket("wss://stream.aisstream.io/v0/stream");
  } catch (err) {
    layers.ships.error = err.message;
    return;
  }
  aisSocket.addEventListener("open", () => {
    aisSocket.send(JSON.stringify({
      APIKey: key,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport"],
    }));
    layers.ships.source = "aisstream.io";
    layers.ships.error = null;
  });
  aisSocket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      const meta = msg.MetaData || {};
      const lat = Number(meta.latitude);
      const lon = Number(meta.longitude);
      const mmsi = String(meta.MMSI || msg.Message?.PositionReport?.UserID || "");
      if (!mmsi || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      shipsLive.set(mmsi, {
        lat,
        lon,
        name: String(meta.ShipName || mmsi).trim(),
        sog: msg.Message?.PositionReport?.Sog,
        cog: msg.Message?.PositionReport?.Cog,
        ts: Date.now(),
      });
    } catch {
      /* ignore malformed frames */
    }
  });
  aisSocket.addEventListener("close", () => {
    aisSocket = null;
    setTimeout(startAisStream, 8000);
  });
  aisSocket.addEventListener("error", () => {
    layers.ships.error = "aisstream socket error";
  });
}

async function refreshConflicts() {
  const res = await pull("https://www.cfr.org/global-conflict-tracker");
  const html = await res.text();
  const slugs = [...html.matchAll(/\/global-conflict-tracker\/conflict\/([a-z0-9-]+)/g)].map((m) => m[1]);
  const unique = [...new Set(slugs.length ? slugs : Object.keys(CFR_COORDS))];
  const points = [];
  for (const slug of unique) {
    const coords = CFR_COORDS[slug];
    if (!coords) continue;
    points.push({
      lat: coords[0],
      lon: coords[1],
      name: titleFromSlug(slug),
      slug,
      url: `https://www.cfr.org/global-conflict-tracker/conflict/${slug}`,
    });
  }
  layers.conflicts = {
    points,
    count: points.length,
    updated: new Date().toISOString(),
    source: "CFR Global Conflict Tracker (theater markers)",
    error: slugs.length ? null : "used bundled slug list",
    at: Date.now(),
  };
}

function guard(name, fn) {
  return fn().catch((err) => {
    layers[name].error = err.message || String(err);
    layers[name].at = Date.now();
    console.error(`feed ${name}:`, err.message || err);
  });
}

export function snapshotFeeds() {
  return {
    jamming: { ...layers.jamming, points: layers.jamming.points },
    aircraft: { ...layers.aircraft, points: layers.aircraft.points },
    ships: { ...layers.ships, points: layers.ships.points },
    conflicts: { ...layers.conflicts, points: layers.conflicts.points },
  };
}

export function startFeeds() {
  const packed = readDataset("feeds");
  if (packed) {
    for (const key of ["jamming", "aircraft", "ships", "conflicts"]) {
      if (packed[key]) layers[key] = { ...emptyLayer(packed[key].source), ...packed[key] };
    }
  }
  if (offline()) return;
  startAisStream();
  const run = (name, fn) => guard(name, fn);
  run("jamming", refreshJamming);
  run("aircraft", refreshAircraft);
  run("ships", refreshShipsRest);
  run("conflicts", refreshConflicts);
  setInterval(() => run("jamming", refreshJamming), 20 * 60 * 1000);
  setInterval(() => run("aircraft", refreshAircraft), adsbPollMs());
  setInterval(() => run("ships", refreshShipsRest), 20 * 1000);
  setInterval(() => run("conflicts", refreshConflicts), 6 * 60 * 60 * 1000);
  setInterval(() => {
    if (process.env.AISSTREAM_API_KEY) flushAisStream();
  }, 4000);
  setInterval(() => {
    try {
      writeDataset("feeds", { fetchedAt: Date.now(), ...snapshotFeeds() });
    } catch {
      /* optional */
    }
  }, 5 * 60 * 1000);
}
