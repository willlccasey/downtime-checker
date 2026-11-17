#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, placesFor, SEARCHES } from "./lib/catalogs.mjs";
import {
  LOOKUP_WORKERS,
  checkHost,
  enrichLocation,
  locateFromCache,
  mapPool,
  saveCache,
} from "./lib/checker.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, "public");
const PORT = Number(process.env.PORT) || 4173;
const WORKERS = 24;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const clients = new Set();
const state = {
  running: false,
  scanId: 0,
  heading: "",
  searchId: "",
  total: 0,
  done: 0,
  up: 0,
  down: 0,
  startedAt: 0,
  finishedAt: 0,
  results: [],
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function snapshot() {
  return { ...state, clients: clients.size };
}

async function runScan({ id, country }) {
  const search = SEARCHES.find((item) => item.id === id);
  const heading =
    id === "country"
      ? country || "Country"
      : search?.label || id;
  const places = placesFor(id, country);
  if (!places.length) {
    throw Object.assign(new Error("No places in that search."), { status: 400 });
  }

  state.running = true;
  state.scanId += 1;
  const scanId = state.scanId;
  state.heading = heading;
  state.searchId = id;
  state.total = places.length;
  state.done = 0;
  state.up = 0;
  state.down = 0;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.results = places.map((place) => ({
    ...place,
    status: "pending",
    method: "",
    ms: 0,
    ip: "",
    lat: place.lat ?? null,
    lon: place.lon ?? null,
  }));

  emit({ type: "scan-start", scanId, heading, searchId: id, country: country || "", total: places.length });

  const pendingLookups = [];
  await mapPool(places, WORKERS, async (place, index) => {
    if (scanId !== state.scanId) return;
    const checked = await checkHost(place.address);
    const located = locateFromCache(place, checked.ips);
    const result = {
      ...place,
      status: checked.status,
      method: checked.method,
      ms: checked.ms,
      ip: located.ip || checked.ips[0] || "",
      ips: checked.ips,
      location: located.location,
      city: located.city,
      region: located.region,
      country: located.country || place.country || "",
      lat: located.lat,
      lon: located.lon,
      approx: Boolean(located.approx),
      index,
    };
    state.results[index] = result;
    state.done += 1;
    if (checked.status === "up") state.up += 1;
    else state.down += 1;
    emit({ type: "result", scanId, done: state.done, total: state.total, up: state.up, down: state.down, result });
    if (!located.location || located.approx) pendingLookups.push({ index, place, ips: checked.ips });
  });

  if (scanId === state.scanId && pendingLookups.length) {
    emit({ type: "locating", scanId, count: pendingLookups.length });
    await mapPool(pendingLookups, LOOKUP_WORKERS, async (item) => {
      if (scanId !== state.scanId) return;
      const found = await enrichLocation(item.place, item.ips);
      const current = state.results[item.index];
      if (!current) return;
      Object.assign(current, {
        location: found.location || current.location,
        city: found.city || current.city,
        region: found.region || current.region,
        country: found.country || current.country,
        lat: found.lat ?? current.lat,
        lon: found.lon ?? current.lon,
        ip: found.ip || current.ip,
        approx: Boolean(found.approx),
      });
      emit({ type: "location", scanId, result: current });
    });
    saveCache();
  }

  if (scanId !== state.scanId) return;
  state.running = false;
  state.finishedAt = Date.now();
  const countries = [...new Set(state.results.map((r) => r.country).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  emit({
    type: "scan-done",
    scanId,
    up: state.up,
    down: state.down,
    total: state.total,
    ms: state.finishedAt - state.startedAt,
    countries,
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) {
    send(res, 403, "Forbidden", "text/plain");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, "Not found", "text/plain");
      return;
    }
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/catalog") {
      const { searches, countries } = catalog();
      send(res, 200, { searches, countries });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(res, 200, snapshot());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", state: snapshot() })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/scan") {
      if (state.running) {
        send(res, 409, { error: "A scan is already running." });
        return;
      }
      const body = await readJson(req);
      const id = String(body.id || "").trim();
      const country = String(body.country || "").trim();
      if (!id) {
        send(res, 400, { error: "Missing search id." });
        return;
      }
      send(res, 202, { ok: true });
      runScan({ id, country }).catch((err) => {
        state.running = false;
        emit({ type: "error", message: err.message || String(err) });
        console.error(err);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      state.scanId += 1;
      state.running = false;
      state.finishedAt = Date.now();
      emit({ type: "scan-stop", scanId: state.scanId });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      send(res, 204, "", "image/x-icon");
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, err.status || 500, { error: err.message || String(err) });
  }
});

catalog();
server.listen(PORT, "127.0.0.1", () => {
  const { searches } = catalog();
  const weather = searches.find((s) => s.id === "weather");
  console.log(`Downtime visualizer  http://127.0.0.1:${PORT}`);
  console.log(`${searches.reduce((n, s) => n + (s.group === "global" ? s.count : 0), 0)} catalog rows across searches`);
  if (weather) console.log(`Weather search: ${weather.count} places`);
});
