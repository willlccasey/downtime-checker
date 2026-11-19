#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PUBLIC = path.join(ROOT, "public");
const CESIUM_VERSION = "1.128.0";

export const DATASETS = {
  websdr: { file: "websdr.json", cache: "websdr.json", list: "stations" },
  gpsjam: { file: "gpsjam.json", cache: "gpsjam.json", list: "zones" },
  conflicts: { file: "conflicts.json", cache: "cfr.json", list: "conflicts" },
  streams: { file: "streams.json", cache: "hpdb-streams.json", list: "points" },
  radio: { file: "radio.json", cache: "radio.json", list: "points" },
  feeds: { file: "feeds.json", cache: "feeds.json" },
};

export function offline() {
  const flag = String(process.env.OFFLINE || process.env.DATA_OFFLINE || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

export function packDir() {
  return process.env.DATA_DIR || path.join(ROOT, "data");
}

export function cacheDir() {
  if (process.env.DATA_CACHE) return process.env.DATA_CACHE;
  if (process.env.FLY_APP_NAME) return "/tmp/downtime-cache";
  return path.join(os.homedir(), ".cache/downtime");
}

export function cesiumVendorDir() {
  return path.join(PUBLIC, "vendor", "cesium");
}

export function cesiumIsLocal() {
  return existsSync(path.join(cesiumVendorDir(), "Cesium.js"));
}

function datasetPath(name, where) {
  const spec = DATASETS[name];
  if (!spec) throw new Error(`unknown dataset ${name}`);
  if (where === "pack") return path.join(packDir(), spec.file);
  return path.join(cacheDir(), spec.cache);
}

function readJsonFile(file, name) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const spec = DATASETS[name];
    if (spec?.list && !Array.isArray(data[spec.list])) return null;
    return data;
  } catch {
    return null;
  }
}

export function readDataset(name) {
  const packed = readJsonFile(datasetPath(name, "pack"), name);
  if (packed) return { ...packed, _from: "pack" };
  const cached = readJsonFile(datasetPath(name, "cache"), name);
  if (cached) return { ...cached, _from: "cache" };
  return null;
}

export function writeDataset(name, payload, { pack = false } = {}) {
  const body = { ...payload };
  delete body._from;
  const dest = datasetPath(name, pack ? "pack" : "cache");
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(body));
  return dest;
}

export async function loadDataset(name, { maxAgeMs, fetchFresh }) {
  const stored = readDataset(name);
  if (offline()) {
    if (stored) return { ...stored, stale: true, offline: true };
    throw new Error(`${name} is not in the data pack. Run: node lib/datapack.mjs snapshot`);
  }
  const age = stored ? Date.now() - Number(stored.fetchedAt || 0) : Infinity;
  if (stored && Number.isFinite(maxAgeMs) && age < maxAgeMs) {
    return { ...stored, stale: false };
  }
  try {
    const body = await fetchFresh();
    writeDataset(name, body);
    return { ...body, stale: false, _from: "network" };
  } catch (err) {
    if (stored) return { ...stored, stale: true, error: err.message || String(err) };
    throw err;
  }
}

export function tileCachePath(kind, z, y, x, ext) {
  return path.join(cacheDir(), "tiles", kind, String(z), String(y), `${x}.${ext}`);
}

function fileInfo(file) {
  if (!existsSync(file)) return { present: false };
  const st = statSync(file);
  return { present: true, bytes: st.size, mtimeMs: st.mtimeMs };
}

export function readyStatus() {
  const datasets = {};
  for (const name of Object.keys(DATASETS)) {
    const packed = fileInfo(datasetPath(name, "pack"));
    const cached = fileInfo(datasetPath(name, "cache"));
    const data = readDataset(name);
    const listKey = DATASETS[name].list;
    datasets[name] = {
      pack: packed,
      cache: cached,
      from: data?._from || null,
      count: listKey && data ? data[listKey]?.length || data.count || 0 : data ? 1 : 0,
      fetchedAt: data?.fetchedAt || null,
      source: data?.source || null,
    };
  }
  return {
    offline: offline(),
    pack: packDir(),
    cache: cacheDir(),
    cesium: cesiumIsLocal() ? "local" : "cdn",
    datasets,
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function snapshot() {
  const { loadRadioOverlay } = await import("./hpdb.mjs");
  const { loadStreamOverlay } = await import("./streams.mjs");
  const { websdrCatalog } = await import("./websdr.mjs");
  const { gpsjamCatalog } = await import("./gpsjam.mjs");
  const { conflictCatalog } = await import("./conflicts.mjs");
  const { snapshotFeeds, startFeeds } = await import("./feeds.mjs");
  mkdirSync(packDir(), { recursive: true });
  startFeeds();
  const jobs = [
    ["radio", loadRadioOverlay()],
    ["streams", loadStreamOverlay()],
    ["websdr", websdrCatalog()],
    ["gpsjam", gpsjamCatalog()],
    ["conflicts", conflictCatalog()],
  ];
  for (const [name, job] of jobs) {
    try {
      const body = await job;
      const dest = writeDataset(name, body, { pack: true });
      console.log(`pack ${name}: ${dest}`);
    } catch (err) {
      console.error(`pack ${name}:`, err.message || err);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const feeds = snapshotFeeds();
  const dest = writeDataset("feeds", { fetchedAt: Date.now(), ...feeds }, { pack: true });
  console.log(`pack feeds: ${dest}`);
  writeFileSync(
    path.join(packDir(), "pack.json"),
    `${JSON.stringify({ name: "downtime-data", version: 1, built: new Date().toISOString(), offline: true }, null, 2)}\n`,
  );
  console.log(`data pack ready at ${packDir()}`);
}

async function vendorCesium() {
  const dest = cesiumVendorDir();
  mkdirSync(dest, { recursive: true });
  const tmp = path.join(os.tmpdir(), `cesium-${CESIUM_VERSION}.tgz`);
  const url = `https://registry.npmjs.org/cesium/-/cesium-${CESIUM_VERSION}.tgz`;
  console.log(`downloading Cesium ${CESIUM_VERSION}`);
  await run("curl", ["-fsSL", "-o", tmp, url]);
  const extract = path.join(os.tmpdir(), `cesium-${CESIUM_VERSION}`);
  mkdirSync(extract, { recursive: true });
  await run("tar", ["-xzf", tmp, "-C", extract]);
  const built = path.join(extract, "package", "Build", "Cesium");
  if (!existsSync(path.join(built, "Cesium.js"))) throw new Error("Cesium tarball missing Build/Cesium");
  await run("sh", ["-c", `rm -rf "${dest}" && mkdir -p "${path.dirname(dest)}" && cp -R "${built}" "${dest}"`]);
  console.log(`Cesium vendored at ${dest}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] || "status";
  if (cmd === "status") console.log(JSON.stringify(readyStatus(), null, 2));
  else if (cmd === "snapshot") await snapshot();
  else if (cmd === "vendor-cesium") await vendorCesium();
  else {
    console.error("usage: node lib/datapack.mjs [status|snapshot|vendor-cesium]");
    process.exit(1);
  }
}
