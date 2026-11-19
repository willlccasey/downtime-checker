import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CAPITALS, ROOT } from "./catalogs.mjs";
import { offline } from "./datapack.mjs";

const CACHE_PATH = path.join(ROOT, "locations.json");
const PING_WAIT = 2;
const TCP_WAIT = 3000;
const LOOKUP_WORKERS = 8;
const darwin = os.platform() === "darwin";

let locationCache = null;
let cacheDirty = false;

function loadCache() {
  if (locationCache) return locationCache;
  try {
    locationCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    locationCache = {};
  }
  return locationCache;
}

function saveCache() {
  if (!cacheDirty) return;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(locationCache, null, 2) + "\n");
  cacheDirty = false;
}

function isPublicIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

export async function resolveIPv4(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [host];
  try {
    const records = await Promise.race([
      dns.lookup(host, { all: true, family: 4 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), TCP_WAIT)),
    ]);
    const ips = [];
    for (const rec of records) {
      if (rec.address && !ips.includes(rec.address)) ips.push(rec.address);
    }
    return ips;
  } catch {
    return [];
  }
}

function pingCommand(host) {
  const wait = String(darwin ? PING_WAIT * 1000 : PING_WAIT);
  if (darwin) return ["ping", ["-n", "-c", "1", "-W", wait, host]];
  return ["ping", ["-4", "-n", "-c", "1", "-W", wait, host]];
}

export function pingHost(host) {
  return new Promise((resolve) => {
    const [bin, args] = pingCommand(host);
    const child = spawn(bin, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, (PING_WAIT + 3) * 1000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function portOpen(ip, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port, timeout: TCP_WAIT });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

export async function checkHost(host) {
  const started = Date.now();
  const ips = await resolveIPv4(host);
  if (await pingHost(host)) {
    return { status: "up", method: "ping", ms: Date.now() - started, ips };
  }
  const targets = ips.length ? ips.slice(0, 2) : /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? [host] : [];
  for (const ip of targets) {
    if (await portOpen(ip, 443)) {
      return { status: "up", method: "https", ms: Date.now() - started, ips };
    }
    if (await portOpen(ip, 80)) {
      return { status: "up", method: "http", ms: Date.now() - started, ips };
    }
  }
  return { status: "down", method: "none", ms: Date.now() - started, ips };
}

function formatLocation(data) {
  const city = String(data.city || "").trim();
  const region = String(data.region || "").trim();
  const postal = String(data.postal || "").trim();
  const country = String(data.country || "").trim();
  if (city && region) {
    let place = `${city}, ${region}`;
    if (postal) place += ` ${postal}`;
    if (country) place += `, ${country}`;
    return place;
  }
  return [city, region, postal, country].filter(Boolean).join(", ");
}

async function lookupIp(ip) {
  if (offline()) return null;
  try {
    const res = await fetch(`https://ipwho.is/${ip}`, {
      headers: { "User-Agent": "downtime-visualizer" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data || !data.success) return null;
    const lat = Number(data.latitude);
    const lon = Number(data.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const location = formatLocation(data);
    if (!location) return null;
    return {
      location,
      city: String(data.city || "").trim(),
      region: String(data.region || "").trim(),
      country: String(data.country || "").trim(),
      lat,
      lon,
    };
  } catch {
    return null;
  }
}

function jitter(lat, lon, key) {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const a = ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
  const r = 0.28 + ((h >>> 8) % 100) / 400;
  return [lat + Math.sin(a) * r, lon + Math.cos(a) * r];
}

export function locateFromCache(entry, ips) {
  const cache = loadCache();
  const publicIp = (ips || []).find(isPublicIPv4);
  if (publicIp && cache[publicIp]?.location) {
    const found = cache[publicIp];
    return attachCoords(entry, { ...found, ip: publicIp });
  }
  if (Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) {
    return attachCoords(entry, {
      location: entry.location,
      city: entry.city,
      region: entry.region,
      country: entry.country,
      lat: entry.lat,
      lon: entry.lon,
      ip: publicIp || entry.ip,
    });
  }
  const country = entry.country;
  if (country && CAPITALS[country]) {
    const [lat, lon] = jitter(...CAPITALS[country], entry.address);
    return {
      location: entry.location || country,
      city: entry.city || "",
      region: entry.region || "",
      country,
      lat,
      lon,
      ip: publicIp || "",
      approx: true,
    };
  }
  return {
    location: entry.location || "",
    city: "",
    region: "",
    country: country || "",
    lat: null,
    lon: null,
    ip: publicIp || "",
  };
}

function attachCoords(entry, found) {
  const [lat, lon] = jitter(found.lat, found.lon, entry.address);
  return { ...found, lat, lon };
}

export async function enrichLocation(entry, ips) {
  const cache = loadCache();
  const publicIp = (ips || []).find(isPublicIPv4);
  if (!publicIp) return locateFromCache(entry, ips);
  if (cache[publicIp]?.location) return locateFromCache(entry, ips);
  const found = await lookupIp(publicIp);
  if (!found) return locateFromCache(entry, ips);
  cache[publicIp] = found;
  cacheDirty = true;
  return attachCoords(entry, { ...found, ip: publicIp });
}

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export { LOOKUP_WORKERS, saveCache };
