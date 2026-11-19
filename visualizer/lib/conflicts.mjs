import { loadDataset } from "./datapack.mjs";

// Council on Foreign Relations Global Conflict Tracker. The map page embeds
// each conflict with a latitude and longitude. Cached on this machine only.
const SOURCE_PAGE = "https://www.cfr.org/global-conflict-tracker";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const STATUS_RANK = { Worsening: 0, Developing: 1, Unchanging: 2, Improving: 3 };

function plain(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function labelOf(value) {
  if (!value) return "";
  if (typeof value === "string") return plain(value);
  if (Array.isArray(value)) return value.map(labelOf).filter(Boolean).join(", ");
  if (typeof value === "object") return plain(value.name || value.rendered || value.slug || "");
  return plain(value);
}

function unescapeJsString(html, start) {
  let out = "";
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "\\") {
      const next = html[i + 1] || "";
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(html.slice(i + 2, i + 6))) {
        out += String.fromCharCode(Number.parseInt(html.slice(i + 2, i + 6), 16));
        i += 5;
        continue;
      }
      const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", '"': '"', "'": "'", "/": "/" };
      out += Object.prototype.hasOwnProperty.call(map, next) ? map[next] : next;
      i += 1;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  throw new Error("CFR conflict data was truncated");
}

function parseJsonPrefix(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(0, i + 1));
    }
  }
  throw new Error("CFR conflict JSON was truncated");
}

export function conflictsFromHtml(html) {
  const marker = '[{\\"id\\":';
  let from = 0;
  let records = null;
  while (from < html.length) {
    const start = html.indexOf(marker, from);
    if (start < 0) break;
    try {
      const decoded = parseJsonPrefix(unescapeJsString(html, start));
      if (Array.isArray(decoded) && decoded.some((item) => item && item.location && item.slug)) {
        records = decoded;
        break;
      }
    } catch {
      // The page repeats escaped fragments. Keep scanning.
    }
    from = start + marker.length;
  }
  if (!records) throw new Error("CFR page did not include conflicts");

  const conflicts = [];
  for (const item of records) {
    const lat = Number(item.location?.lat);
    const lon = Number(item.location?.lng);
    const name = labelOf(item.title);
    const slug = String(item.slug || "").trim();
    if (!name || !slug) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const status = labelOf(item.conflict_status);
    const impact = labelOf(item.impact_on_us_interests);
    const types = labelOf(item.conflict_types);
    const region = labelOf(item.region);
    const description = plain(item.description).slice(0, 420);
    conflicts.push({
      id: `cfr-${item.id || slug}`,
      kind: "conflict",
      name,
      slug,
      lat,
      lon,
      region,
      status,
      impact,
      types,
      description,
      url: `https://www.cfr.org/global-conflict-tracker/conflict/${slug}`,
      meta: [status, region, types, impact ? `U.S. impact ${impact}` : ""].filter(Boolean).join(" · "),
    });
  }
  conflicts.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.name.localeCompare(b.name));
  if (!conflicts.length) throw new Error("CFR page had no located conflicts");
  return conflicts;
}

function payload(conflicts, fetchedAt, stale) {
  return {
    source: SOURCE_PAGE,
    credit: "Conflicts from the Council on Foreign Relations Global Conflict Tracker. Shown only on this machine.",
    fetchedAt,
    stale: Boolean(stale),
    count: conflicts.length,
    conflicts,
  };
}

async function fetchConflicts() {
  const response = await fetch(SOURCE_PAGE, {
    signal: AbortSignal.timeout(25000),
    headers: {
      "User-Agent": UA,
      Accept: "text/html",
    },
  });
  if (!response.ok) throw new Error(`CFR conflict tracker HTTP ${response.status}`);
  const conflicts = conflictsFromHtml(await response.text());
  return payload(conflicts, Date.now(), false);
}

let inflight = null;

export function conflictCatalog() {
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function load() {
  return loadDataset("conflicts", { maxAgeMs: MAX_AGE_MS, fetchFresh: fetchConflicts });
}
