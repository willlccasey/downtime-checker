import { loadDataset, offline, readDataset } from "./datapack.mjs";
import { loadHpdbIndex } from "./hpdb.mjs";

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const UA = "downtime-checker/1.0 (local globe; HPDB stream match)";
const DELAY_MS = 250;
const STOP = new Set([
  "and", "the", "county", "city", "of", "department", "dept", "radio", "feed", "live",
  "area", "unit", "district", "municipality", "municipalities", "agencies", "miscellaneous",
  "official", "audio", "for", "inc", "llc", "dispatch", "communications", "comm",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^btw:/, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

function scoreNames(a, b) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const word of left) if (right.has(word)) hit += 1;
  return hit / Math.min(left.size, right.size);
}

function parseStateCards(html) {
  const out = [];
  const re = /href="\/listen\/stid\/(\d+)"[^>]*>\s*<span class="portal-grid-card-name">([^<]+)<\/span>/g;
  let match;
  while ((match = re.exec(html))) {
    out.push({ stid: Number(match[1]), name: match[2].trim() });
  }
  return out;
}

function parseFeeds(html, state) {
  const feeds = [];
  const rows = html.split(/<tr>/i).slice(1);
  for (const row of rows) {
    const feed = row.match(/href="\/listen\/feed\/(\d+)"[^>]*>([^<]+)/);
    if (!feed) continue;
    const county = row.match(/href="\/listen\/ctid\/(\d+)"[^>]*>([^<]+)/);
    const genre = row.match(/listen-genre-badge">([^<]+)/);
    const listeners = row.match(/data-sort-value="(\d+)"/);
    const online = /portal-status-online/.test(row);
    feeds.push({
      id: `bcfy-${feed[1]}`,
      feedId: Number(feed[1]),
      name: decode(feed[2]),
      url: `https://www.broadcastify.com/listen/feed/${feed[1]}`,
      source: "broadcastify",
      state: state.name,
      stateId: state.stid,
      county: county ? decode(county[2]) : "",
      countyId: county ? Number(county[1]) : null,
      genre: genre ? decode(genre[1]) : "",
      online,
      listeners: listeners ? Number(listeners[1]) : 0,
    });
  }
  return feeds;
}

function decode(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function scrapeBroadcastify() {
  const countries = [
    { coid: 1, name: "United States" },
    { coid: 2, name: "Canada" },
  ];
  const feeds = [];
  const errors = [];
  for (const country of countries) {
    let html;
    try {
      html = await fetchText(`https://www.broadcastify.com/listen/?coid=${country.coid}`);
    } catch (err) {
      errors.push(err.message || String(err));
      continue;
    }
    const states = parseStateCards(html);
    for (const [i, state] of states.entries()) {
      try {
        const page = await fetchText(`https://www.broadcastify.com/listen/stid/${state.stid}`);
        feeds.push(...parseFeeds(page, state));
      } catch (err) {
        errors.push(`${state.name}: ${err.message || err}`);
      }
      if (i < states.length - 1) await sleep(DELAY_MS);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const feed of feeds) {
    if (seen.has(feed.id)) continue;
    seen.add(feed.id);
    unique.push(feed);
  }
  return { feeds: unique, errors };
}

async function scrapeRadioBrowser() {
  const tags = ["scanner", "police", "fire", "dispatch", "public safety"];
  const seen = new Set();
  const stations = [];
  for (const tag of tags) {
    try {
      const rows = await fetchJson(
        `https://de1.api.radio-browser.info/json/stations/search?tag=${encodeURIComponent(tag)}&hidebroken=true`,
      );
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const id = row.stationuuid || row.url;
        if (!id || seen.has(id)) continue;
        const lat = Number(row.geo_lat);
        const lon = Number(row.geo_long);
        seen.add(id);
        stations.push({
          id: `rb-${id}`,
          name: row.name || "scanner",
          url: row.url_resolved || row.url,
          homepage: row.homepage || "",
          source: "radio-browser",
          state: row.state || "",
          county: "",
          countyId: null,
          genre: tag,
          online: true,
          listeners: Number(row.clickcount) || 0,
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
        });
      }
    } catch {
      /* optional source */
    }
  }
  return stations;
}

async function scrapeOpenMHz() {
  try {
    const data = await fetchJson("https://api.openmhz.com/systems");
    const systems = Array.isArray(data?.systems) ? data.systems : [];
    return systems
      .filter((item) => item?.shortName && item?.name)
      .map((item) => ({
        id: `openmhz-${item.shortName}`,
        name: item.name,
        url: `https://openmhz.com/system/${item.shortName}`,
        source: "openmhz",
        state: item.state || "",
        county: item.county || item.city || "",
        countyId: null,
        genre: "OpenMHz",
        online: Boolean(item.active),
        listeners: Number(item.clientCount) || 0,
        city: item.city || "",
      }));
  } catch {
    return [];
  }
}

function matchFeed(feed, index) {
  const countyGroups = (feed.countyId && index.countyGroups[feed.countyId]) || [];
  let best = null;
  let bestScore = 0;
  for (const group of countyGroups) {
    const score = scoreNames(feed.name, group.name);
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  if (best && bestScore >= 0.34) {
    return {
      ...feed,
      lat: best.lat,
      lon: best.lon,
      hpdbName: best.name,
      match: "group",
      score: Number(bestScore.toFixed(3)),
    };
  }
  const county = feed.countyId ? index.counties[feed.countyId] : null;
  if (county && county.lat != null && county.lon != null) {
    return {
      ...feed,
      lat: county.lat,
      lon: county.lon,
      hpdbName: `${county.name} County`,
      match: "county",
      score: Number(bestScore.toFixed(3)),
    };
  }
  if (feed.lat != null && feed.lon != null) {
    let near = null;
    let nearScore = 0;
    for (const group of index.groups) {
      const dlat = group.lat - feed.lat;
      const dlon = group.lon - feed.lon;
      if (dlat * dlat + dlon * dlon > 0.4) continue;
      const score = scoreNames(feed.name, group.name);
      if (score > nearScore) {
        nearScore = score;
        near = group;
      }
    }
    if (near && nearScore >= 0.34) {
      return {
        ...feed,
        lat: near.lat,
        lon: near.lon,
        hpdbName: near.name,
        match: "geo",
        score: Number(nearScore.toFixed(3)),
      };
    }
    return { ...feed, hpdbName: null, match: "stream-geo", score: 0 };
  }
  return null;
}

let inflight = null;

export async function loadStreamOverlay() {
  if (!inflight) {
    inflight = buildStreamOverlay().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function buildStreamOverlay() {
  return loadDataset("streams", {
    maxAgeMs: MAX_AGE_MS,
    fetchFresh: scrapeStreams,
  });
}

async function scrapeStreams() {
  if (offline()) {
    const stored = readDataset("streams");
    if (stored) return stored;
    throw new Error("streams pack missing");
  }
  const index = await loadHpdbIndex();
  if (!index.countyGroups) index.countyGroups = {};
  if (!index.counties) index.counties = {};
  if (!Array.isArray(index.groups)) index.groups = [];
  const [bcfy, radioBrowser, openmhz] = await Promise.all([
    scrapeBroadcastify(),
    scrapeRadioBrowser(),
    scrapeOpenMHz(),
  ]);
  const raw = [...bcfy.feeds, ...radioBrowser, ...openmhz];
  const points = [];
  let unmatched = 0;
  for (const feed of raw) {
    const matched = matchFeed(feed, index);
    if (matched && matched.lat != null && matched.lon != null) points.push(matched);
    else unmatched += 1;
  }
  const payload = {
    source: "Broadcastify listen pages + radio-browser + OpenMHz",
    credit: "Audio feeds from Broadcastify, radio-browser.info, and OpenMHz. Matched to Uniden HPDB counties.",
    fetchedAt: Date.now(),
    count: points.length,
    scraped: raw.length,
    unmatched,
    errors: bcfy.errors,
    points,
  };
  return payload;
}
