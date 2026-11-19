import { cellToLatLng } from "./vendor/h3-js.es.js";
import { loadDataset } from "./datapack.mjs";

// Daily H3 resolution-4 aircraft navigation-accuracy grid from gpsjam.org.
// Local cache only. John Wiseman publishes it; the aircraft reports come from
// ADS-B Exchange and airplanes.live.
const DATA_URL = "https://gpsjam.org/data";
const SOURCE_PAGE = "https://gpsjam.org/";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const LINK_KM = 120;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

// Labels only. The smallest box that contains a cluster centroid wins.
// Southwest US is called out because gpsjam.org says those reports are usually
// military trainers blanking their own antennas, not a conflict.
const REGIONS = [
  { name: "Baltic Sea", south: 53, north: 66.5, west: 9, east: 32 },
  { name: "Western Russia", south: 53, north: 57.5, west: 32.5, east: 40 },
  { name: "Romania", south: 43.5, north: 48.2, west: 22, east: 29.5 },
  { name: "Eastern Europe", south: 46.5, north: 49.5, west: 18, east: 23 },
  { name: "Black Sea", south: 40.5, north: 47.2, west: 27, east: 42 },
  { name: "Caspian Sea", south: 40, north: 47, west: 48, east: 54 },
  { name: "Colombia", south: 0, north: 12, west: -79, east: -67 },
  { name: "Baikal", south: 51, north: 56, west: 100, east: 110 },
  { name: "Ukraine", south: 46.2, north: 52.5, west: 22, east: 40 },
  { name: "Caucasus", south: 38.5, north: 43.5, west: 40, east: 50 },
  { name: "Eastern Mediterranean", south: 31, north: 36.8, west: 25, east: 36 },
  { name: "Levant", south: 31, north: 37.5, west: 34, east: 42 },
  { name: "Red Sea", south: 12, north: 28, west: 32, east: 45 },
  { name: "Persian Gulf", south: 22, north: 31, west: 47, east: 58 },
  { name: "Iraq and Syria", south: 32, north: 38.5, west: 36, east: 48 },
  { name: "Iran", south: 25, north: 40, west: 44, east: 63 },
  { name: "Arabian Peninsula", south: 12, north: 31, west: 34, east: 60 },
  { name: "Libya", south: 20, north: 34, west: 9, east: 25 },
  { name: "Sahel", south: 8, north: 22, west: -18, east: 25 },
  { name: "Horn of Africa", south: -2, north: 16, west: 38, east: 52 },
  { name: "Myanmar", south: 9, north: 28.5, west: 92, east: 102 },
  { name: "South Asia", south: 22, north: 36, west: 66, east: 90 },
  { name: "Taiwan Strait", south: 21, north: 27, west: 117, east: 123 },
  { name: "Korean Peninsula", south: 33, north: 43.5, west: 124, east: 131 },
  { name: "South China Sea", south: 4, north: 22, west: 105, east: 121 },
  { name: "Mexico", south: 14, north: 32.5, west: -118, east: -86 },
  {
    name: "Southwest United States",
    south: 25,
    north: 38,
    west: -115,
    east: -93,
    note: "gpsjam.org: usually military trainers blocking their own GPS, not a conflict",
  },
];

function kmBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function regionFor(lat, lon) {
  let best = null;
  let bestArea = Infinity;
  for (const region of REGIONS) {
    if (lat < region.south || lat > region.north || lon < region.west || lon > region.east) continue;
    const area = (region.north - region.south) * (region.east - region.west);
    if (area < bestArea) {
      best = region;
      bestArea = area;
    }
  }
  return best;
}

function coordName(lat, lon) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clusterHexes(hexes) {
  const parent = hexes.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < hexes.length; i += 1) {
    for (let j = i + 1; j < hexes.length; j += 1) {
      if (kmBetween(hexes[i], hexes[j]) > LINK_KM) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    }
  }
  const groups = new Map();
  hexes.forEach((hex, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(hex);
  });
  return [...groups.values()];
}

export function zonesFromCsv(csv, date) {
  const lines = String(csv || "").trim().split(/\n/);
  const header = lines[0] || "";
  if (!header.includes("hex") || !header.includes("count_bad_aircraft")) {
    throw new Error("GPS Jam hex file had an unexpected header");
  }
  const hot = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(",");
    if (parts.length < 3) continue;
    const good = Number.parseInt(parts[1], 10);
    const bad = Number.parseInt(parts[2], 10);
    const total = good + bad;
    // Same share gpsjam.org maps: subtract one bad aircraft, then divide.
    if (!Number.isFinite(total) || total < 4 || bad < 2) continue;
    const pct = (100 * (bad - 1)) / total;
    if (!(pct > 10)) continue;
    let lat;
    let lon;
    try {
      [lat, lon] = cellToLatLng(parts[0]);
    } catch {
      continue;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    hot.push({ lat, lon, pct, bad, good, total });
  }

  const zones = [];
  for (const group of clusterHexes(hot)) {
    let weight = 0;
    let lat = 0;
    let lon = 0;
    let bad = 0;
    let good = 0;
    let peak = 0;
    for (const hex of group) {
      const share = Math.max(hex.bad, 1);
      lat += hex.lat * share;
      lon += hex.lon * share;
      weight += share;
      bad += hex.bad;
      good += hex.good;
      if (hex.pct > peak) peak = hex.pct;
    }
    if (!weight) continue;
    lat /= weight;
    lon /= weight;
    const lone = group.length < 2 && (peak < 25 || bad < 8);
    if (lone) continue;
    const region = regionFor(lat, lon);
    zones.push({
      name: region ? region.name : coordName(lat, lon),
      note: region?.note || "",
      lat: round(lat, 4),
      lon: round(lon, 4),
      pct: round(peak, 1),
      hexes: group.length,
      bad,
      good,
    });
  }

  zones.sort((a, b) => b.pct - a.pct || b.bad - a.bad);
  const seen = new Map();
  for (const zone of zones) seen.set(zone.name, (seen.get(zone.name) || 0) + 1);
  const used = new Map();
  for (const zone of zones) {
    if (seen.get(zone.name) < 2) continue;
    const n = (used.get(zone.name) || 0) + 1;
    used.set(zone.name, n);
    zone.name = `${zone.name} ${n}`;
  }
  return zones.map((zone, index) => ({
    id: `gps-${date}-${index}`,
    kind: "gps",
    name: zone.name,
    lat: zone.lat,
    lon: zone.lon,
    pct: zone.pct,
    hexes: zone.hexes,
    bad: zone.bad,
    good: zone.good,
    note: zone.note,
    date,
    url: `https://gpsjam.org/?lat=${zone.lat.toFixed(4)}&lon=${zone.lon.toFixed(4)}&date=${date}`,
    meta: [
      `${zone.pct}% of aircraft`,
      `${zone.hexes} hexes`,
      `${zone.bad} reporting low accuracy`,
      date,
      zone.note,
    ].filter(Boolean).join(" · "),
  }));
}

function latestCompleteDate(manifest) {
  let fallback = "";
  let complete = "";
  for (const line of String(manifest || "").trim().split(/\n/).slice(1)) {
    const [date, suspect] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) continue;
    fallback = date;
    if (suspect !== "true") complete = date;
  }
  return { date: complete || fallback, incomplete: !complete && Boolean(fallback) };
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: { "User-Agent": UA, Accept: "text/csv,text/plain,*/*" },
  });
  if (!response.ok) throw new Error(`GPS Jam HTTP ${response.status} for ${url}`);
  return response.text();
}

function payload(zones, date, incomplete, fetchedAt, stale) {
  return {
    source: SOURCE_PAGE,
    credit: "GPS interference from gpsjam.org by John Wiseman, derived from ADS-B Exchange and airplanes.live. Shown only on this machine.",
    date,
    incomplete: Boolean(incomplete),
    fetchedAt,
    stale: Boolean(stale),
    count: zones.length,
    zones,
  };
}

async function fetchZones() {
  const manifest = await fetchText(`${DATA_URL}/manifest.csv`);
  const { date, incomplete } = latestCompleteDate(manifest);
  if (!date) throw new Error("GPS Jam manifest had no dates");
  const csv = await fetchText(`${DATA_URL}/${date}-h3_4.csv`);
  const zones = zonesFromCsv(csv, date);
  if (!zones.length) throw new Error("GPS Jam file had no high-interference zones");
  return payload(zones, date, incomplete, Date.now(), false);
}

let inflight = null;

export function gpsjamCatalog() {
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function load() {
  return loadDataset("gpsjam", { maxAgeMs: MAX_AGE_MS, fetchFresh: fetchZones });
}
