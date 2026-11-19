import { loadDataset } from "./datapack.mjs";

// Public directory the websdr.org map loads. Cached locally for this machine.
const LIST_URL = "http://websdr.ewi.utwente.nl/~~websdrlistk?v=1&fmt=2&chseq=0";
const SOURCE_PAGE = "http://websdr.org/";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function bandText(band) {
  const low = Number(band?.l);
  const high = Number(band?.h);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return "";
  const range = `${low.toFixed(3)}–${high.toFixed(3)} MHz`;
  const antenna = decodeHtml(band.a || "");
  return antenna ? `${range} · ${antenna}` : range;
}

export function normalizeWebsdr(raw) {
  if (!Array.isArray(raw)) return [];
  const stations = [];
  for (const item of raw) {
    const url = cleanUrl(item?.url);
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    const name = decodeHtml(item?.desc);
    if (!url || !name) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const bands = Array.isArray(item.bands) ? item.bands.map(bandText).filter(Boolean) : [];
    const users = Number.parseInt(item.users, 10);
    stations.push({
      id: `${url}#${stations.length}`,
      name,
      url,
      lat,
      lon,
      qth: decodeHtml(item.qth || ""),
      users: Number.isFinite(users) ? users : 0,
      bands,
    });
  }
  return stations;
}

function parseBody(text) {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("WebSDR list did not include stations");
  return normalizeWebsdr(JSON.parse(text.slice(start)));
}

async function fetchStations() {
  const response = await fetch(LIST_URL, {
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`WebSDR list HTTP ${response.status}`);
  const stations = parseBody(await response.text());
  if (!stations.length) throw new Error("WebSDR list was empty");
  return stations;
}

function payload(stations, fetchedAt, stale) {
  return {
    source: SOURCE_PAGE,
    credit: "Station list from websdr.org (PA3FWM). Shown only on this machine.",
    fetchedAt,
    stale: Boolean(stale),
    count: stations.length,
    stations,
  };
}

let inflight = null;

export function websdrCatalog() {
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function load() {
  return loadDataset("websdr", {
    maxAgeMs: MAX_AGE_MS,
    fetchFresh: async () => payload(await fetchStations(), Date.now(), false),
  });
}
