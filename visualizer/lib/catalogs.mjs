import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SKIP_HOSTS = new Set([
  "stockanalysis.com",
  "wikipedia.org",
  "newsweek.com",
  "rankings.newsweek.com",
]);

const COUNTRY_LABELS = [
  ["united states", "United States"],
  ["united kingdom", "United Kingdom"],
  ["south korea", "South Korea"],
  ["saudi arabia", "Saudi Arabia"],
  ["hong kong", "Hong Kong"],
  ["south africa", "South Africa"],
  ["sri lanka", "Sri Lanka"],
  ["new zealand", "New Zealand"],
  ["switzerland", "Switzerland"],
  ["netherlands", "Netherlands"],
  ["singapore", "Singapore"],
  ["australia", "Australia"],
  ["germany", "Germany"],
  ["france", "France"],
  ["canada", "Canada"],
  ["china", "China"],
  ["japan", "Japan"],
  ["india", "India"],
  ["brazil", "Brazil"],
  ["spain", "Spain"],
  ["italy", "Italy"],
  ["israel", "Israel"],
  ["sweden", "Sweden"],
  ["denmark", "Denmark"],
  ["austria", "Austria"],
  ["russia", "Russia"],
  ["turkey", "Turkey"],
  ["thailand", "Thailand"],
  ["poland", "Poland"],
  ["taiwan", "Taiwan"],
  ["mexico", "Mexico"],
  ["indonesia", "Indonesia"],
  ["vietnam", "Vietnam"],
  ["bangladesh", "Bangladesh"],
  ["malaysia", "Malaysia"],
  ["philippines", "Philippines"],
  ["pakistan", "Pakistan"],
  ["argentina", "Argentina"],
  ["chile", "Chile"],
  ["peru", "Peru"],
  ["finland", "Finland"],
  ["usa", "United States"],
  ["uk", "United Kingdom"],
  ["us", "United States"],
];

const LIST_KINDS = {
  "MAJOR NATIONWIDE SERVICES": "tech",
  "MAJOR NATIONWIDE BANKS": "banks",
  "MAIN GOVERNMENT SITES": "government",
  "NE ARKANSAS LOCAL BANKS": "banks",
  "NE ARKANSAS LOCAL UTILITIES": "utilities",
};

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\)\],;]+/gi;
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const BAR_LINE = /^=+$/;

export const CAPITALS = {
  Afghanistan: [34.53, 69.17],
  Albania: [41.33, 19.82],
  Algeria: [36.75, 3.04],
  Angola: [-8.84, 13.23],
  Argentina: [-34.6, -58.38],
  Australia: [-35.28, 149.13],
  Austria: [48.21, 16.37],
  Bangladesh: [23.81, 90.41],
  Belgium: [50.85, 4.35],
  Brazil: [-15.79, -47.88],
  Canada: [45.42, -75.7],
  Chile: [-33.45, -70.67],
  China: [39.9, 116.4],
  Colombia: [4.71, -74.07],
  "Czech Republic": [50.08, 14.44],
  Czechia: [50.08, 14.44],
  Denmark: [55.68, 12.57],
  Egypt: [30.04, 31.24],
  Finland: [60.17, 24.94],
  France: [48.86, 2.35],
  Germany: [52.52, 13.4],
  Greece: [37.98, 23.73],
  "Hong Kong": [22.32, 114.17],
  Hungary: [47.5, 19.04],
  India: [28.61, 77.21],
  Indonesia: [-6.21, 106.85],
  Iran: [35.69, 51.39],
  Iraq: [33.32, 44.37],
  Ireland: [53.35, -6.26],
  Israel: [31.77, 35.21],
  Italy: [41.9, 12.5],
  Japan: [35.68, 139.69],
  Kenya: [-1.29, 36.82],
  Malaysia: [3.14, 101.69],
  Mexico: [19.43, -99.13],
  NATO: [50.88, 4.42],
  Netherlands: [52.37, 4.9],
  "New Zealand": [-41.29, 174.78],
  Nigeria: [9.08, 7.4],
  Norway: [59.91, 10.75],
  Pakistan: [33.68, 73.04],
  Peru: [-12.05, -77.04],
  Philippines: [14.6, 120.98],
  Poland: [52.23, 21.01],
  Portugal: [38.72, -9.14],
  Qatar: [25.29, 51.53],
  Romania: [44.43, 26.1],
  Russia: [55.76, 37.62],
  "Saudi Arabia": [24.71, 46.68],
  Singapore: [1.35, 103.82],
  "South Africa": [-25.75, 28.19],
  "South Korea": [37.57, 126.98],
  Spain: [40.42, -3.7],
  "Sri Lanka": [6.93, 79.85],
  Sweden: [59.33, 18.07],
  Switzerland: [46.95, 7.45],
  Taiwan: [25.03, 121.57],
  Thailand: [13.76, 100.5],
  Turkey: [39.93, 32.85],
  Ukraine: [50.45, 30.52],
  "United Arab Emirates": [24.45, 54.38],
  "United Kingdom": [51.51, -0.13],
  "United States": [38.9, -77.04],
  Vietnam: [21.03, 105.85],
};

function read(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return "";
  return fs.readFileSync(full, "utf8");
}

function validAddress(host) {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.length > 253 || !host.includes(".")) return false;
  return host.split(".").every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[a-z0-9-]+$/i.test(label);
  });
}

function catalogHost(text) {
  let host = String(text || "").trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  return host.replace(/\.$/, "");
}

function hostsInText(text) {
  const hosts = [];
  const seen = new Set();
  const add = (host) => {
    host = (host || "").toLowerCase().replace(/\.$/, "");
    if (!host || seen.has(host) || !validAddress(host)) return;
    seen.add(host);
    hosts.push(host);
  };
  for (const url of text.match(URL_IN_TEXT) || []) {
    try {
      add(new URL(url).hostname);
    } catch {
      /* skip */
    }
  }
  const leftover = text.replace(URL_IN_TEXT, " ");
  for (const token of leftover.match(BARE_HOST) || []) add(token);
  return hosts;
}

function prettyCountry(title) {
  title = title.replace(/\s+/g, " ").trim();
  if (title.toUpperCase() === "UNITED STATES OF AMERICA") return "United States";
  const idx = title.indexOf("(");
  const head = idx >= 0 ? title.slice(0, idx) : title;
  const tail = idx >= 0 ? title.slice(idx) : "";
  if (head.trim().toUpperCase() === "NATO") return "NATO" + (idx >= 0 ? " " + tail : "");
  if (head === head.toUpperCase() && head.trim()) {
    const titled = head
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return titled + tail;
  }
  if (title === title.toUpperCase()) {
    return title.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return title;
}

function countryInText(text) {
  const lowered = text.toLowerCase();
  for (const [needle, label] of COUNTRY_LABELS) {
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(lowered)) return label;
  }
  return "";
}

function loadSections(file) {
  const sections = [];
  let title = "Places";
  let group = [];
  let skip = false;
  for (const raw of read(file).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("Note:") || line.startsWith("Generated:") || line.startsWith("- ") || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("===") && line.endsWith("===")) {
      if (group.length && !skip) sections.push([title, group]);
      group = [];
      title = line.replace(/=/g, "").trim() || "Places";
      skip = title.toUpperCase() === "ADDED PLACES";
      continue;
    }
    if (skip) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) continue;
    const address = catalogHost(parts[1]);
    if (!validAddress(address)) continue;
    group.push({ name: parts[0], address });
  }
  if (group.length && !skip) sections.push([title, group]);
  return sections;
}

function tagList(sections) {
  for (const [title, group] of sections) {
    const kind = LIST_KINDS[title.toUpperCase()] || "added";
    for (const entry of group) {
      if (title === "ADDED PLACES") {
        entry.kinds = ["added"];
        entry.source = "added";
      } else {
        entry.kinds = [kind];
        entry.source = "list";
        entry.country = "United States";
      }
    }
  }
}

function loadSaved() {
  const text = read("added-places.txt");
  if (!text) return [];
  const entries = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const address = catalogHost(parts[1]);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const entry = { name: parts[0], address, kinds: ["added"], source: "added" };
    if (parts[2]) entry.location = parts[2];
    if (parts.length >= 5) {
      const lat = Number(parts[3]);
      const lon = Number(parts[4]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        entry.lat = lat;
        entry.lon = lon;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function governmentEntries(line, country) {
  const hosts = hostsInText(line);
  if (!hosts.length) return [];
  let label = line.replace(/^-\s*/, "").trim();
  if (label.includes(":")) label = label.split(":")[0].trim();
  if (!label) label = country;
  const kinds = ["government"];
  const lowered = label.toLowerCase();
  if (lowered.includes("bank") || lowered.includes("reserve")) kinds.push("banks");
  return hosts.map((host, index) => ({
    name: index === 0 ? label : `${label} (${host})`,
    address: host,
    country,
    kinds: [...kinds],
    source: "world",
  }));
}

function loadWorld() {
  const lines = read("world-governments.txt").split(/\r?\n/);
  const sections = [];
  let current = "";
  let group = [];
  let seen = new Set();
  const flush = () => {
    if (current && current !== "SKIP" && current !== "ADDITIONAL" && group.length) {
      sections.push([current, group]);
    }
    group = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    index += 1;
    if (!line) continue;
    if (BAR_LINE.test(line)) {
      let look = index;
      while (look < lines.length && !lines[look].trim()) look += 1;
      if (look >= lines.length || BAR_LINE.test(lines[look].trim())) continue;
      const title = lines[look].trim();
      look += 1;
      while (look < lines.length && !lines[look].trim()) look += 1;
      if (look >= lines.length || !BAR_LINE.test(lines[look].trim())) continue;
      index = look + 1;
      flush();
      seen = new Set();
      const upper = title.toUpperCase();
      if (upper.startsWith("NOTE")) current = "SKIP";
      else if (upper.startsWith("ADDITIONAL COUNTRIES")) current = "ADDITIONAL";
      else current = prettyCountry(title);
      continue;
    }
    if (!current || current === "SKIP") continue;
    if (current === "ADDITIONAL") {
      const label = line.includes(":") ? line.split(":")[0].trim() : line;
      const made = governmentEntries(line, prettyCountry(label) || "Unknown");
      if (made.length) sections.push([made[0].country, made]);
      continue;
    }
    for (const entry of governmentEntries(line, current)) {
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      group.push(entry);
    }
  }
  flush();
  return sections;
}

function institutionEntries(line, kind) {
  const hosts = hostsInText(line).filter((h) => !SKIP_HOSTS.has(h) && !h.endsWith(".example"));
  if (!hosts.length) return [];
  const pieces = line.split(" - ").map((p) => p.trim()).filter(Boolean);
  let domainAt = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    if (hosts.some((host) => pieces[i].toLowerCase().includes(host))) {
      domainAt = i;
      break;
    }
  }
  let name = domainAt ? pieces.slice(0, domainAt).join(" - ") : pieces[0];
  name = name.replace(/^\d+\.\s*/, "").replace(/^-\s*/, "").replace(/^[\s-]+|[\s-]+$/g, "");
  if (!name) name = hosts[0];
  const country = countryInText(line);
  return hosts.map((host, index) => ({
    name: index === 0 ? name : `${name} (${host})`,
    address: host,
    country,
    kinds: [kind],
    source: "institutions",
  }));
}

function loadInstitutions() {
  const sections = [];
  let kind = "";
  let title = "";
  let group = [];
  const seen = new Set();
  const flush = () => {
    if (title && group.length) sections.push([title, group]);
    group = [];
  };
  for (const raw of read("institutions.txt").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("SECTION 1")) {
      flush();
      kind = "exchanges";
      title = "STOCK EXCHANGES";
      continue;
    }
    if (upper.startsWith("SECTION 2")) {
      flush();
      kind = "banks";
      title = "BANKS";
      continue;
    }
    if (upper.startsWith("SECTION 3")) {
      flush();
      kind = "education";
      title = "EDUCATION";
      continue;
    }
    if (upper.startsWith("SECTION 4")) {
      flush();
      kind = "medical";
      title = "HOSPITALS";
      continue;
    }
    if (upper.startsWith("B. TOP PHARMACEUTICAL")) {
      flush();
      kind = "medical";
      title = "PHARMACEUTICALS";
      continue;
    }
    if (!kind) continue;
    if (!/^(?:\d+\.|-)\s+/.test(line)) continue;
    for (const entry of institutionEntries(line, kind)) {
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      group.push(entry);
    }
  }
  flush();
  return sections;
}

function loadCatalog(file, kind, source, title) {
  const group = [];
  const seen = new Set();
  for (const raw of read(file).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2 || !parts[0]) continue;
    const host = catalogHost(parts[1]);
    if (!host || seen.has(host) || !validAddress(host)) continue;
    seen.add(host);
    group.push({
      name: parts[0],
      address: host,
      country: parts[2] || "",
      kinds: [kind],
      source,
    });
  }
  return group.length ? [[title, group]] : [];
}

function loadTransportation() {
  const buckets = new Map();
  const seen = new Set();
  let country = "";
  for (const raw of read("transportation.txt").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("===") && line.endsWith("===")) {
      country = line.replace(/=/g, "").trim();
      continue;
    }
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4 || !country) continue;
    const [kindLabel, name, , website] = parts;
    const host = catalogHost(website);
    if (!host || seen.has(host) || !validAddress(host)) continue;
    seen.add(host);
    const label = kindLabel ? `${name} (${kindLabel})` : name;
    if (!buckets.has(country)) buckets.set(country, []);
    buckets.get(country).push({
      name: label,
      address: host,
      country,
      kinds: ["transportation"],
      source: "transportation",
    });
  }
  return [...buckets.entries()].filter(([, group]) => group.length);
}

function keepNew(entries, seen) {
  const kept = [];
  for (const entry of entries) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

function mergeSections(...groups) {
  const seen = new Set();
  const merged = [];
  for (const sections of groups) {
    for (const [title, group] of sections) {
      const kept = keepNew(group, seen);
      if (kept.length) merged.push([title, kept]);
    }
  }
  return merged;
}

function allEntries(sections) {
  return sections.flatMap(([, group]) => group);
}

function filterSections(sections, predicate) {
  const chosen = [];
  for (const [title, group] of sections) {
    const kept = group.filter(predicate);
    if (kept.length) chosen.push([title, kept]);
  }
  return chosen;
}

function ofKinds(sections, ...kinds) {
  return filterSections(sections, (entry) => (entry.kinds || []).some((k) => kinds.includes(k)));
}

function unitedStatesOnly(sections) {
  return filterSections(sections, (entry) => entry.country === "United States");
}

function loadGroups() {
  const home = loadSections("places.txt");
  tagList(home);
  const saved = loadSaved();
  if (saved.length) home.push(["ADDED PLACES", saved]);
  const world = loadWorld();
  const institutions = mergeSections(
    loadInstitutions(),
    loadCatalog("world-exchanges.txt", "exchanges", "exchanges", "STOCK EXCHANGES"),
  );
  return {
    home,
    world,
    institutions,
    services: loadCatalog("service-sites.txt", "tech", "services", "TECH SERVICES"),
    transport: loadTransportation(),
    stores: loadCatalog("stores.txt", "stores", "stores", "STORES"),
    communications: loadCatalog("communications.txt", "communications", "communications", "COMMUNICATIONS"),
    military: loadCatalog("military.txt", "military", "military", "MILITARY"),
    shipping: loadCatalog("shipping.txt", "shipping", "shipping", "SHIPPING"),
    food: loadCatalog("food.txt", "food", "food", "FOOD"),
    weather: loadCatalog("weather.txt", "weather", "weather", "WEATHER"),
    extra_banks: loadCatalog("banks-national.txt", "banks", "banks", "BANKS"),
    extra_utilities: loadCatalog("utilities-national.txt", "utilities", "utilities", "UTILITIES"),
    extra_government: loadCatalog("government-extra.txt", "government", "government", "GOVERNMENT"),
  };
}

function merged(groups, ...keys) {
  return mergeSections(...keys.map((key) => groups[key]));
}

function everything(groups) {
  return merged(
    groups,
    "home",
    "world",
    "institutions",
    "services",
    "transport",
    "stores",
    "communications",
    "military",
    "shipping",
    "food",
    "weather",
    "extra_banks",
    "extra_utilities",
    "extra_government",
  );
}

function banksAndExchanges(groups) {
  return ofKinds(merged(groups, "home", "world", "institutions", "extra_banks"), "banks", "exchanges");
}

function techSites(groups) {
  return ofKinds(merged(groups, "home", "services"), "tech");
}

function utilitySites(groups) {
  return ofKinds(merged(groups, "home", "extra_utilities"), "utilities");
}

function governmentSites(groups) {
  return ofKinds(merged(groups, "home", "world", "extra_government"), "government");
}

export const SEARCHES = [
  { id: "everything", label: "Search everything", group: "global" },
  { id: "world", label: "World governments", group: "global" },
  { id: "united-states", label: "United States", group: "global" },
  { id: "banks", label: "Banks and stock exchanges", group: "global" },
  { id: "tech", label: "Tech only", group: "global" },
  { id: "utilities", label: "Utilities only", group: "global" },
  { id: "education", label: "Education", group: "global" },
  { id: "medical", label: "Medical", group: "global" },
  { id: "exchanges", label: "Stock exchanges", group: "global" },
  { id: "transport", label: "Transportation", group: "global" },
  { id: "stores", label: "Stores", group: "global" },
  { id: "communications", label: "Communications", group: "global" },
  { id: "military", label: "Military", group: "global" },
  { id: "shipping", label: "Shipping", group: "global" },
  { id: "food", label: "Food", group: "global" },
  { id: "weather", label: "Weather", group: "global" },
  { id: "us-everything", label: "Everything in the United States", group: "us" },
  { id: "us-banks", label: "US banks and exchanges", group: "us" },
  { id: "us-tech", label: "US tech", group: "us" },
  { id: "us-utilities", label: "US utilities", group: "us" },
  { id: "us-government", label: "US government", group: "us" },
  { id: "us-education", label: "US education", group: "us" },
  { id: "us-medical", label: "US medical", group: "us" },
  { id: "us-exchanges", label: "US stock exchanges", group: "us" },
  { id: "us-transport", label: "US transportation", group: "us" },
  { id: "us-stores", label: "US stores", group: "us" },
  { id: "us-communications", label: "US communications", group: "us" },
  { id: "us-military", label: "US military", group: "us" },
  { id: "us-shipping", label: "US shipping", group: "us" },
  { id: "us-food", label: "US food", group: "us" },
  { id: "us-weather", label: "US weather", group: "us" },
];

function selectSections(groups, id, country) {
  switch (id) {
    case "everything":
      return everything(groups);
    case "world":
      return groups.world;
    case "united-states":
    case "us-everything":
      return unitedStatesOnly(everything(groups));
    case "banks":
      return banksAndExchanges(groups);
    case "tech":
      return techSites(groups);
    case "utilities":
      return utilitySites(groups);
    case "education":
      return ofKinds(groups.institutions, "education");
    case "medical":
      return ofKinds(groups.institutions, "medical");
    case "exchanges":
      return ofKinds(groups.institutions, "exchanges");
    case "transport":
      return groups.transport;
    case "stores":
      return groups.stores;
    case "communications":
      return groups.communications;
    case "military":
      return groups.military;
    case "shipping":
      return groups.shipping;
    case "food":
      return groups.food;
    case "weather":
      return groups.weather;
    case "us-banks":
      return unitedStatesOnly(banksAndExchanges(groups));
    case "us-tech":
      return unitedStatesOnly(techSites(groups));
    case "us-utilities":
      return unitedStatesOnly(utilitySites(groups));
    case "us-government":
      return unitedStatesOnly(governmentSites(groups));
    case "us-education":
      return unitedStatesOnly(ofKinds(groups.institutions, "education"));
    case "us-medical":
      return unitedStatesOnly(ofKinds(groups.institutions, "medical"));
    case "us-exchanges":
      return unitedStatesOnly(ofKinds(groups.institutions, "exchanges"));
    case "us-transport":
      return unitedStatesOnly(groups.transport);
    case "us-stores":
      return unitedStatesOnly(groups.stores);
    case "us-communications":
      return unitedStatesOnly(groups.communications);
    case "us-military":
      return unitedStatesOnly(groups.military);
    case "us-shipping":
      return unitedStatesOnly(groups.shipping);
    case "us-food":
      return unitedStatesOnly(groups.food);
    case "us-weather":
      return unitedStatesOnly(groups.weather);
    case "country":
      return filterSections(groups.world, (entry) => entry.country === country);
    default:
      return [];
  }
}

let cache = null;

export function catalog() {
  if (cache) return cache;
  const groups = loadGroups();
  const countries = [];
  const seen = new Set();
  for (const [title] of groups.world) {
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    countries.push(title);
  }
  countries.sort((a, b) => a.localeCompare(b));
  const searches = SEARCHES.map((search) => ({
    ...search,
    count: allEntries(selectSections(groups, search.id)).length,
  }));
  cache = { groups, countries, searches };
  return cache;
}

export function placesFor(id, country) {
  const { groups } = catalog();
  return allEntries(selectSections(groups, id, country)).map((entry) => ({ ...entry }));
}

export { ROOT };
