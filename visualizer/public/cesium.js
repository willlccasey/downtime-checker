const state = {
  results: [],
  running: false,
  total: 0,
  done: 0,
  up: 0,
  down: 0,
  startedAt: 0,
  heading: "AWAITING TASKING",
  filter: "all",
  selected: null,
  viewer: null,
  points: new Map(),
  arcs: new Map(),
  origin: null,
  sdrSource: null,
  radioSource: null,
  streamSource: null,
  gpsSource: null,
  conflictSource: null,
  scanSource: null,
  sdrStations: [],
  sdrOpenId: "",
  radioPoints: [],
  radioOpenId: "",
  radioCount: 0,
  streamPoints: [],
  streamOpenId: "",
  gpsZones: [],
  gpsDate: "",
  gpsReady: false,
  conflicts: [],
  conflictsReady: false,
  live: {
    jamming: { source: null, points: [] },
    aircraft: { source: null, points: [] },
    ships: { source: null, points: [] },
  },
  layers: {
    sdr: true,
    radio: true,
    stream: true,
    gps: true,
    jamming: true,
    aircraft: true,
    ships: true,
    conflicts: true,
    scan: true,
  },
  basemap: "sat",
  labels: false,
  terrain: true,
  terrainProvider: null,
  ellipsoidTerrain: null,
  openKind: "",
  openId: "",
  feedMode: "sdr",
};

const COLORS = {
  up: Cesium.Color.fromCssColorString("#3dff9a"),
  down: Cesium.Color.fromCssColorString("#ff4d4d"),
  pending: Cesium.Color.fromCssColorString("#ffb020"),
};

// Same hub the canvas globe draws its search lines from.
const ORIGIN = { lat: 35.84, lon: -90.7 };
const TERRAIN_MAX_Z = 12;
const TERRAIN_GRID = 65;
const BASEMAPS = {
  sat: {
    url: "/tiles/eox/{z}/{y}/{x}.jpg",
    credit: "Sentinel-2 cloudless - s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)",
    maximumLevel: 14,
  },
  live: {
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
    credit: "NASA GIBS / VIIRS SNPP true color",
    maximumLevel: 9,
  },
  night: {
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    credit: "NASA Black Marble / VIIRS",
    maximumLevel: 8,
  },
  streets: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    credit: "© OpenStreetMap contributors",
    maximumLevel: 19,
  },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

async function boot() {
  const [catalog] = await Promise.all([
    fetch("/api/catalog").then((response) => response.json()),
    startGlobe(),
  ]);
  renderSearches(catalog);
  fillCountries(catalog.countries);
  hookUi();
  connectEvents();
  tickClock();
  showDataMode();
  Promise.allSettled([
    loadWebsdr(),
    loadRadio(),
    loadStreams(),
    loadGps(),
    loadConflicts(),
    pollLiveFeeds(),
  ]).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) statusLive(failed.reason?.message || String(failed.reason));
    else statusLive();
  });
  setInterval(pollLiveFeeds, 8000);
}

async function showDataMode() {
  try {
    const ready = await fetch("/api/ready").then((response) => response.json());
    const el = document.getElementById("data-mode");
    if (!el) return;
    el.hidden = false;
    el.textContent = ready.offline ? "OFFLINE" : "DATA";
    el.classList.toggle("offline", Boolean(ready.offline));
    el.title = ready.offline ? `Pack ${ready.pack}` : `Cache ${ready.cache}`;
  } catch {
    /* optional */
  }
}

function imageryProvider(id) {
  const spec = BASEMAPS[id] || BASEMAPS.sat;
  return new Cesium.UrlTemplateImageryProvider({
    url: spec.url,
    credit: spec.credit,
    maximumLevel: spec.maximumLevel,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
  });
}

function labelProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Reference_Labels/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    credit: "NASA GIBS place names",
    maximumLevel: 9,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
  });
}

function applyBasemap() {
  const viewer = state.viewer;
  if (!viewer) return;
  const layers = viewer.imageryLayers;
  layers.removeAll();
  layers.addImageryProvider(imageryProvider(state.basemap));
  if (state.labels && state.basemap !== "streets") {
    layers.addImageryProvider(labelProvider());
  }
  for (const button of document.querySelectorAll("[data-basemap]")) {
    button.classList.toggle("on", button.dataset.basemap === state.basemap);
  }
  const labels = document.querySelector("[data-labels]");
  if (labels) labels.classList.toggle("on", state.labels);
}

function makeTerrariumTerrain() {
  const cache = new Map();
  const grid = TERRAIN_GRID;
  async function heightsFor(x, y, level) {
    const z = Math.min(level, TERRAIN_MAX_Z);
    const shift = level - z;
    const px = x >> shift;
    const py = y >> shift;
    const key = `${z}/${px}/${py}`;
    let tile = cache.get(key);
    if (!tile) {
      try {
        const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${px}/${py}.png`);
        if (!response.ok) throw new Error(String(response.status));
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        bitmap.close();
        const decoded = new Float32Array(width * height);
        for (let i = 0, p = 0; i < decoded.length; i += 1, p += 4) {
          decoded[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
        }
        tile = { decoded, width, height };
        if (cache.size > 96) cache.delete(cache.keys().next().value);
        cache.set(key, tile);
      } catch {
        return new Float32Array(grid * grid);
      }
    }
    const out = new Float32Array(grid * grid);
    const fracX = shift ? (x - (px << shift)) / (1 << shift) : 0;
    const fracY = shift ? (y - (py << shift)) / (1 << shift) : 0;
    const span = shift ? 1 / (1 << shift) : 1;
    const x0 = fracX * (tile.width - 1);
    const y0 = fracY * (tile.height - 1);
    const xSpan = Math.max(1, span * (tile.width - 1));
    const ySpan = Math.max(1, span * (tile.height - 1));
    for (let row = 0; row < grid; row += 1) {
      const sy = Math.min(tile.height - 1, Math.round(y0 + (row / (grid - 1)) * ySpan));
      for (let col = 0; col < grid; col += 1) {
        const sx = Math.min(tile.width - 1, Math.round(x0 + (col / (grid - 1)) * xSpan));
        out[row * grid + col] = tile.decoded[sy * tile.width + sx];
      }
    }
    return out;
  }
  return new Cesium.CustomHeightmapTerrainProvider({
    width: grid,
    height: grid,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: "Terrain Mapzen / AWS Open Data (SRTM, GMTED, NED)",
    callback: (x, y, level) => heightsFor(x, y, level),
  });
}

function setTerrain(on) {
  state.terrain = Boolean(on);
  if (!state.viewer) return;
  state.viewer.terrainProvider = state.terrain ? state.terrainProvider : state.ellipsoidTerrain;
  const button = document.querySelector("[data-terrain]");
  if (button) button.classList.toggle("on", state.terrain);
}

async function startGlobe() {
  state.ellipsoidTerrain = new Cesium.EllipsoidTerrainProvider();
  state.terrainProvider = makeTerrariumTerrain();
  const viewer = new Cesium.Viewer("cesium", {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: true,
    baseLayer: new Cesium.ImageryLayer(imageryProvider("sat")),
    terrainProvider: state.terrainProvider,
    skyBox: false,
  });
  const controller = viewer.scene.screenSpaceCameraController;
  controller.minimumZoomDistance = 40;
  controller.maximumZoomDistance = 40000000;
  viewer.scene.globe.maximumScreenSpaceError = 1.4;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#070b10");
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#10202c");
  viewer.scene.globe.enableLighting = false;
  if ("verticalExaggeration" in viewer.scene) viewer.scene.verticalExaggeration = 1.2;
  state.viewer = viewer;
  applyBasemap();
  setTerrain(true);
  state.sdrSource = new Cesium.CustomDataSource("websdr");
  state.radioSource = new Cesium.CustomDataSource("uniden-radio");
  state.streamSource = new Cesium.CustomDataSource("hpdb-streams");
  state.gpsSource = new Cesium.CustomDataSource("gpsjam");
  state.conflictSource = new Cesium.CustomDataSource("conflicts");
  state.scanSource = new Cesium.CustomDataSource("scan");
  viewer.dataSources.add(state.sdrSource);
  viewer.dataSources.add(state.radioSource);
  viewer.dataSources.add(state.streamSource);
  viewer.dataSources.add(state.gpsSource);
  viewer.dataSources.add(state.conflictSource);
  viewer.dataSources.add(state.scanSource);
  for (const key of ["jamming", "aircraft", "ships"]) {
    state.live[key].source = new Cesium.CustomDataSource(key);
    viewer.dataSources.add(state.live[key].source);
  }
  for (const key of Object.keys(state.layers)) setLayer(key, state.layers[key]);
  viewer.camera.setView({
    destination: Cesium.Rectangle.fromDegrees(-168, -48, 150, 72),
  });
  ensureOrigin();
  viewer.selectedEntityChanged.addEventListener((entity) => {
    if (!entity) return;
    if (entity._pin) {
      openPin(entity._pin);
      return;
    }
    if (entity._radio) {
      openRadio(entity._radio, { fly: false });
      return;
    }
    if (entity._stream) {
      openStream(entity._stream, { fly: false });
      return;
    }
    if (entity._live) {
      showLive(entity._live);
      return;
    }
    if (entity._resultIndex == null) return;
    const result = state.results[entity._resultIndex];
    if (result) showSelected(result);
  });
}

function renderSearches(catalog) {
  const select = document.getElementById("grid-search");
  if (!select) return;
  const groups = [
    ["Global", catalog.searches.filter((item) => item.group === "global")],
    ["United States", catalog.searches.filter((item) => item.group === "us")],
  ];
  select.innerHTML = groups.map(([label, items]) => {
    const opts = items.map((item) => `<option value="${esc(item.id)}">${esc(item.label)} (${item.count})</option>`).join("");
    return `<optgroup label="${esc(label)}">${opts}</optgroup>`;
  }).join("");
  if ([...select.options].some((opt) => opt.value === "everything")) select.value = "everything";
}

function fillCountries(list) {
  const select = document.getElementById("country");
  select.innerHTML = list.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
}

function hookUi() {
  document.getElementById("btn-stop").addEventListener("click", () => {
    fetch("/api/stop", { method: "POST" });
  });
  document.getElementById("btn-grid-run").addEventListener("click", () => {
    const id = document.getElementById("grid-search").value;
    if (id) startScan(id);
  });
  document.getElementById("btn-country").addEventListener("click", () => {
    const country = document.getElementById("country").value;
    startScan("country", country);
  });
  document.getElementById("sdr-back").addEventListener("click", closePin);
  document.getElementById("sdr-filter").addEventListener("input", renderSdrList);
  document.getElementById("radio-filter").addEventListener("input", renderRadioList);
  document.getElementById("stream-filter").addEventListener("input", renderStreamList);
  document.getElementById("gps-filter").addEventListener("input", renderGpsList);
  document.getElementById("conflict-filter").addEventListener("input", renderConflictList);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePin();
  });
  for (const button of document.querySelectorAll("[data-layer-toggle]")) {
    button.addEventListener("click", () => {
      const layer = button.dataset.layerToggle;
      setLayer(layer, !state.layers[layer]);
    });
  }
  for (const button of document.querySelectorAll("[data-feed]")) {
    button.addEventListener("click", () => setFeedMode(button.dataset.feed));
  }
  for (const button of document.querySelectorAll("[data-basemap]")) {
    button.addEventListener("click", () => {
      state.basemap = button.dataset.basemap;
      applyBasemap();
    });
  }
  const labels = document.querySelector("[data-labels]");
  if (labels) {
    labels.addEventListener("click", () => {
      state.labels = !state.labels;
      applyBasemap();
    });
  }
  const terrain = document.querySelector("[data-terrain]");
  if (terrain) {
    terrain.addEventListener("click", () => setTerrain(!state.terrain));
  }
  for (const chip of document.querySelectorAll("[data-filter]")) {
    chip.addEventListener("click", () => {
      for (const other of document.querySelectorAll("[data-filter]")) other.classList.remove("on");
      chip.classList.add("on");
      state.filter = chip.dataset.filter;
      renderFeed();
    });
  }
}

async function startScan(id, country) {
  if (state.running) return;
  const response = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, country: country || "" }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    setStatus(body.error || "SCAN REFUSED");
  }
}

function connectEvents() {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "hello") applySnapshot(event.state);
    if (event.type === "scan-start") {
      clearPoints();
      state.results = [];
      state.running = true;
      state.total = event.total;
      state.done = 0;
      state.up = 0;
      state.down = 0;
      state.startedAt = Date.now();
      state.heading = event.heading;
      state.selected = null;
      document.getElementById("heading").textContent = event.heading.toUpperCase();
      document.getElementById("btn-stop").hidden = false;
      setFeedMode("returns");
      document.getElementById("link-dot").className = "pulse-dot live";
      document.getElementById("selected").hidden = true;
      setStatus(`TASKING ${event.total} NODES · ${event.heading.toUpperCase()}`);
      renderFeed();
      updateHud();
    }
    if (event.type === "result") {
      state.results[event.result.index] = event.result;
      state.done = event.done;
      state.up = event.up;
      state.down = event.down;
      upsertPoint(event.result);
      prependFeed(event.result);
      updateHud();
    }
    if (event.type === "location") {
      state.results[event.result.index] = event.result;
      upsertPoint(event.result);
      if (state.selected?.address === event.result.address) showSelected(event.result);
    }
    if (event.type === "locating") setStatus(`RESOLVING ${event.count} COORDINATES`);
    if (event.type === "scan-done") {
      state.running = false;
      document.getElementById("btn-stop").hidden = true;
      document.getElementById("link-dot").className = event.down ? "pulse-dot hot" : "pulse-dot live";
      setStatus(`COMPLETE · ${event.up} UP · ${event.down} DOWN · ${(event.ms / 1000).toFixed(1)}s`);
      updateHud();
    }
    if (event.type === "scan-stop") {
      state.running = false;
      document.getElementById("btn-stop").hidden = true;
      setStatus("SCAN ABORTED");
      updateHud();
    }
    if (event.type === "error") setStatus(event.message);
  };
  stream.onerror = () => setStatus("EVENT STREAM DROPPED · RECONNECTING");
}

function applySnapshot(snap) {
  clearPoints();
  state.results = snap.results || [];
  state.running = Boolean(snap.running);
  state.total = snap.total || 0;
  state.done = snap.done || 0;
  state.up = snap.up || 0;
  state.down = snap.down || 0;
  state.heading = snap.heading || state.heading;
  document.getElementById("heading").textContent = (state.heading || "AWAITING TASKING").toUpperCase();
  document.getElementById("btn-stop").hidden = !snap.running;
  for (const result of state.results) {
    if (result) upsertPoint(result);
  }
  renderFeed();
  updateHud();
}

function clearPoints() {
  if (!state.viewer) return;
  if (state.scanSource) state.scanSource.entities.removeAll();
  state.points.clear();
  state.arcs.clear();
  ensureOrigin();
}

function ensureOrigin() {
  if (!state.viewer || state.origin) return;
  state.origin = state.viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(ORIGIN.lon, ORIGIN.lat, 0),
    point: {
      pixelSize: 8,
      color: Cesium.Color.fromCssColorString("#7ef6ff"),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function arcPositions(lat, lon) {
  const start = Cesium.Cartesian3.fromDegrees(ORIGIN.lon, ORIGIN.lat, 0);
  const end = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const distance = Cesium.Cartesian3.distance(start, end);
  if (distance < 1500) return null;
  const height = Math.min(Math.max(distance * 0.18, 25000), 900000);
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const steps = 40;
  const positions = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const cart = new Cesium.Cartesian3();
    Cesium.Cartesian3.lerp(start, end, t, cart);
    Cesium.Cartesian3.normalize(cart, cart);
    Cesium.Cartesian3.multiplyByScalar(cart, radius + Math.sin(t * Math.PI) * height, cart);
    positions.push(cart);
  }
  return positions;
}

function upsertArc(result) {
  if (!state.viewer || !state.scanSource || result.lat == null || result.lon == null) return;
  const positions = arcPositions(result.lat, result.lon);
  if (!positions) return;
  const color = COLORS[result.status] || COLORS.pending;
  const material = new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color });
  let entity = state.arcs.get(result.index);
  if (!entity) {
    entity = state.scanSource.entities.add({
      polyline: {
        positions,
        width: 3,
        material,
        arcType: Cesium.ArcType.NONE,
      },
    });
    state.arcs.set(result.index, entity);
    return;
  }
  entity.polyline.positions = positions;
  entity.polyline.material = material;
}

function upsertPoint(result) {
  if (!state.viewer || !state.scanSource || result.lat == null || result.lon == null) return;
  const color = COLORS[result.status] || COLORS.pending;
  let entity = state.points.get(result.index);
  const position = Cesium.Cartesian3.fromDegrees(result.lon, result.lat, 0);
  if (!entity) {
    entity = state.scanSource.entities.add({
      position,
      point: {
        pixelSize: result.status === "down" ? 11 : 8,
        color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity._resultIndex = result.index;
    state.points.set(result.index, entity);
    upsertArc(result);
    return;
  }
  entity.position = position;
  entity.point.pixelSize = result.status === "down" ? 11 : 8;
  entity.point.color = color;
  upsertArc(result);
}

function visibleResults() {
  return state.results.filter((result) => result && (state.filter === "all" || result.status === state.filter));
}

function prependFeed(result) {
  if (state.filter !== "all" && result.status !== state.filter) return;
  const feed = document.getElementById("feed");
  feed.prepend(rowEl(result));
  while (feed.children.length > 400) feed.lastChild.remove();
}

function renderFeed() {
  const feed = document.getElementById("feed");
  feed.innerHTML = "";
  const items = visibleResults().slice().reverse().slice(0, 400);
  for (const result of items) feed.append(rowEl(result));
}

function rowEl(result) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <div class="badge ${esc(result.status)}">${esc(result.status.toUpperCase())}</div>
    <div>
      <div class="name">${esc(result.name)}</div>
      <div class="host">${esc(result.address)}${result.method && result.method !== "none" ? " · " + esc(result.method) : ""}</div>
    </div>
    <div>${result.ms || 0}ms</div>`;
  row.addEventListener("click", () => focusResult(result));
  return row;
}

function focusResult(result) {
  showSelected(result);
  const entity = state.points.get(result.index);
  if (!entity || !state.viewer) return;
  state.viewer.selectedEntity = entity;
  state.viewer.flyTo(entity, { duration: 0.8 });
}

function showSelected(result) {
  state.selected = result;
  const box = document.getElementById("selected");
  box.hidden = false;
  box.innerHTML = `<b>${esc(result.status.toUpperCase())}</b> ${esc(result.name)}<br>${esc(result.address)}${result.ip ? " · " + esc(result.ip) : ""}<br>${esc(result.location || result.country || "location pending")}<br>${result.ms || 0}ms · ${esc(result.method || "—")}`;
}

function updateHud() {
  document.getElementById("stat-done").textContent = state.done;
  document.getElementById("stat-total").textContent = `/ ${state.total}`;
  document.getElementById("stat-up").textContent = state.up;
  document.getElementById("stat-down").textContent = state.down;
  document.getElementById("stat-pct").textContent = state.done ? `${Math.round((state.up / state.done) * 100)}%` : "—";
  document.getElementById("progress").style.width = state.total ? `${(state.done / state.total) * 100}%` : "0%";
  setCount("scan", state.results.filter(Boolean).length);
}

function setStatus(text) {
  document.getElementById("status-line").textContent = text;
}

function tickClock() {
  document.getElementById("clock").textContent = new Date().toISOString().slice(11, 19) + "Z";
  setTimeout(tickClock, 1000);
}

function setFeedMode(mode) {
  const allowed = ["sdr", "radio", "stream", "gps", "conflicts", "returns"];
  state.feedMode = allowed.includes(mode) ? mode : "sdr";
  for (const name of allowed) {
    const pane = document.getElementById(`${name}-pane`);
    if (pane) pane.hidden = state.feedMode !== name;
  }
  for (const button of document.querySelectorAll("[data-feed]")) {
    button.classList.toggle("on", button.dataset.feed === state.feedMode);
  }
  const title = document.getElementById("feed-title");
  if (state.feedMode === "sdr") title.textContent = `WEBSDR ${state.sdrStations.length}`;
  else if (state.feedMode === "radio") title.textContent = `RADIO ${state.radioCount || state.radioPoints.length}`;
  else if (state.feedMode === "stream") title.textContent = `STREAM ${state.streamPoints.length}`;
  else if (state.feedMode === "gps") title.textContent = `GPS ${state.gpsZones.length}`;
  else if (state.feedMode === "conflicts") title.textContent = `CONFLICTS ${state.conflicts.length}`;
  else title.textContent = "LIVE RETURNS";
}

function addFlyButton(nav, { id, label, countId, layer, feed, rectangle }) {
  const fly = document.createElement("button");
  fly.type = "button";
  fly.id = id;
  fly.innerHTML = `<span>${label}</span><span class="count" id="${countId}" data-count="${layer}">…</span>`;
  fly.addEventListener("click", () => {
    closePin();
    setLayer(layer, true);
    setFeedMode(feed);
    if (!state.viewer) return;
    if (rectangle) {
      state.viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(...rectangle),
        duration: 1.2,
      });
      return;
    }
    const source = sourceFor(layer);
    if (source && source.entities.values.length) {
      state.viewer.flyTo(source, { duration: 1.1 });
    }
  });
  nav.append(fly);
}

function sourceFor(layer) {
  if (layer === "sdr") return state.sdrSource;
  if (layer === "gps") return state.gpsSource;
  if (layer === "conflicts") return state.conflictSource;
  if (layer === "radio") return state.radioSource;
  if (layer === "stream") return state.streamSource;
  if (layer === "scan") return state.scanSource;
  if (state.live[layer]?.source) return state.live[layer].source;
  return null;
}

function setCount(key, value) {
  const text = String(value);
  for (const el of document.querySelectorAll(`[data-count="${key}"]`)) el.textContent = text;
}

function setLayer(layer, on) {
  if (!Object.prototype.hasOwnProperty.call(state.layers, layer)) return;
  state.layers[layer] = Boolean(on);
  const source = sourceFor(layer);
  if (source) source.show = state.layers[layer];
  for (const button of document.querySelectorAll(`[data-layer-toggle="${layer}"]`)) {
    button.classList.toggle("on", state.layers[layer]);
    button.setAttribute("aria-pressed", state.layers[layer] ? "true" : "false");
  }
  const host = document.getElementById("cesium");
  if (host) {
    host.dataset.visibleLayers = Object.keys(state.layers).filter((key) => state.layers[key]).join(" ");
  }
}

function layerStatus(error) {
  statusLive(error);
}

function wrapName(name) {
  const words = String(name || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 34 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function sdrPin(station) {
  return {
    kind: "sdr",
    id: station.id,
    name: station.name,
    url: station.url,
    lat: station.lat,
    lon: station.lon,
    meta: [station.qth, station.users ? `${station.users} listening` : "", ...(station.bands || [])]
      .filter(Boolean)
      .join(" · "),
  };
}

async function loadWebsdr() {
  const response = await fetch("/api/websdr");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "WebSDR list failed");
  state.sdrStations = Array.isArray(body.stations) ? body.stations : [];
  setCount("sdr", state.sdrStations.length);
  placeMarkers(state.sdrSource, "sdr", state.sdrStations.map(sdrPin), "/icons/ham-radio.png", true);
  const host = document.getElementById("cesium");
  if (host && state.sdrSource) host.dataset.pins = String(state.sdrSource.entities.values.length);
  renderSdrList();
  layerStatus(body.stale ? "SDR CACHED" : "");
}

async function loadGps() {
  const response = await fetch("/api/gpsjam");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "GPS Jam failed");
  state.gpsZones = Array.isArray(body.zones) ? body.zones : [];
  state.gpsDate = body.date || "";
  state.gpsReady = true;
  setCount("gps", state.gpsZones.length);
  const credit = document.getElementById("gps-credit");
  if (credit) {
    credit.textContent = `${body.date || ""}${body.stale ? " · cached" : ""} · gpsjam.org`;
    credit.title = body.credit || "";
  }
  placeMarkers(state.gpsSource, "gps", state.gpsZones, "/icons/satellite.png", false);
  const host = document.getElementById("cesium");
  if (host && state.gpsSource) host.dataset.gps = String(state.gpsSource.entities.values.length);
  renderGpsList();
  layerStatus(body.stale ? "GPS CACHED" : "");
}

async function loadConflicts() {
  const response = await fetch("/api/conflicts");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Conflict tracker failed");
  state.conflicts = Array.isArray(body.conflicts) ? body.conflicts : [];
  state.conflictsReady = true;
  setCount("conflicts", state.conflicts.length);
  const credit = document.getElementById("conflict-credit");
  if (credit) {
    credit.textContent = `${body.stale ? "cached · " : ""}cfr.org/global-conflict-tracker`;
    credit.title = body.credit || "";
  }
  placeMarkers(state.conflictSource, "conflicts", state.conflicts, "/icons/bomb.png", false);
  const host = document.getElementById("cesium");
  if (host && state.conflictSource) host.dataset.conflicts = String(state.conflictSource.entities.values.length);
  renderConflictList();
  layerStatus(body.stale ? "CONFLICTS CACHED" : "");
}

function placeMarkers(source, layer, items, icon, stack) {
  if (!state.viewer || !source) return;
  source.entities.removeAll();
  source.show = Boolean(state.layers[layer]);
  const stacks = new Map();
  for (const item of items) {
    if (item.lat == null || item.lon == null) continue;
    let shift = 0;
    if (stack) {
      const key = `${Number(item.lat).toFixed(4)},${Number(item.lon).toFixed(4)}`;
      const n = stacks.get(key) || 0;
      stacks.set(key, n + 1);
      shift = n * 28;
    }
    const entity = source.entities.add({
      name: item.name,
      position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat, 0),
      billboard: {
        image: icon,
        width: 48,
        height: 48,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(shift, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(4e5, 1, 1.2e7, 0.62),
      },
      label: {
        text: item.kind === "gps" ? `${wrapName(item.name)}\n${Math.round(item.pct)}%` : wrapName(item.name),
        font: "12px ui-monospace, monospace",
        fillColor: Cesium.Color.fromCssColorString("#e8f7ff"),
        outlineColor: Cesium.Color.fromCssColorString("#041018"),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#102028").withAlpha(0.9),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(shift, -30),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(5e5, 1, 7e6, 0.45),
      },
    });
    entity._pin = item;
  }
}

function renderSdrList() {
  const list = document.getElementById("sdr-list");
  if (!list) return;
  const query = (document.getElementById("sdr-filter").value || "").trim().toLowerCase();
  const stations = state.sdrStations
    .filter((station) => {
      if (!query) return true;
      const hay = `${station.name} ${station.qth} ${station.url} ${(station.bands || []).join(" ")}`.toLowerCase();
      return hay.includes(query);
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = "";
  for (const station of stations) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sdr-row";
    row.dataset.lat = String(station.lat);
    row.dataset.lon = String(station.lon);
    row.dataset.url = station.url;
    if (state.openKind === "sdr" && station.id === state.openId) row.classList.add("on");
    const band = station.bands && station.bands.length ? station.bands[0] : "";
    row.innerHTML = `<div class="name">${esc(station.name)}</div><div class="host">${esc(station.qth || "")}${band ? " · " + esc(band) : ""} · ${station.users || 0} listening</div>`;
    row.addEventListener("click", () => openPin(sdrPin(station), { fly: true }));
    list.append(row);
  }
  if (state.feedMode === "sdr") {
    document.getElementById("feed-title").textContent = `WEBSDR ${stations.length}`;
  }
}

function renderGpsList() {
  const list = document.getElementById("gps-list");
  if (!list) return;
  const query = (document.getElementById("gps-filter").value || "").trim().toLowerCase();
  const zones = state.gpsZones
    .filter((zone) => {
      if (!query) return true;
      return `${zone.name} ${zone.note || ""} ${zone.pct} ${zone.date || ""}`.toLowerCase().includes(query);
    })
    .slice()
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  list.innerHTML = "";
  for (const zone of zones) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sdr-row";
    row.dataset.lat = String(zone.lat);
    row.dataset.lon = String(zone.lon);
    row.dataset.url = zone.url;
    if (state.openKind === "gps" && zone.id === state.openId) row.classList.add("on");
    row.innerHTML = `<div class="name">${esc(zone.name)}</div><div class="host">${esc(zone.pct)}% · ${zone.hexes} hexes · ${zone.bad} aircraft</div>`;
    row.addEventListener("click", () => openPin(zone, { fly: true }));
    list.append(row);
  }
  if (state.feedMode === "gps") {
    document.getElementById("feed-title").textContent = `GPS ${zones.length}`;
  }
}

function renderConflictList() {
  const list = document.getElementById("conflict-list");
  if (!list) return;
  const query = (document.getElementById("conflict-filter").value || "").trim().toLowerCase();
  const conflicts = state.conflicts.filter((conflict) => {
    if (!query) return true;
    return `${conflict.name} ${conflict.region} ${conflict.status} ${conflict.types} ${conflict.description}`.toLowerCase().includes(query);
  });
  list.innerHTML = "";
  for (const conflict of conflicts) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sdr-row";
    row.dataset.lat = String(conflict.lat);
    row.dataset.lon = String(conflict.lon);
    row.dataset.url = conflict.url;
    if (state.openKind === "conflict" && conflict.id === state.openId) row.classList.add("on");
    const status = String(conflict.status || "").toLowerCase().replace(/\s+/g, "-");
    row.innerHTML = `<div class="name">${esc(conflict.name)}</div><div class="host"><span class="st-${esc(status)}">${esc(conflict.status || "")}</span>${conflict.region ? " · " + esc(conflict.region) : ""}${conflict.types ? " · " + esc(conflict.types) : ""}</div>`;
    row.addEventListener("click", () => openPin(conflict, { fly: true }));
    list.append(row);
  }
  if (state.feedMode === "conflicts") {
    document.getElementById("feed-title").textContent = `CONFLICTS ${conflicts.length}`;
  }
}

function findPin(kind, id) {
  const source = sourceFor(kind === "conflict" ? "conflicts" : kind);
  if (!source) return null;
  for (const entity of source.entities.values) {
    if (entity._pin && entity._pin.kind === kind && entity._pin.id === id) return entity;
  }
  return null;
}

function openPin(pin, options = {}) {
  if (!pin || !pin.url) return;
  state.openKind = pin.kind;
  state.openId = pin.id;
  const layer = pin.kind === "conflict" ? "conflicts" : pin.kind;
  if (state.layers[layer] === false) setLayer(layer, true);
  document.getElementById("sdr-title").textContent = pin.name;
  document.getElementById("sdr-meta").textContent = pin.meta || "";
  const pop = document.getElementById("sdr-pop");
  pop.href = pin.url;
  const frame = document.getElementById("sdr-frame");
  frame.title = pin.name;
  if (frame.dataset.url !== pin.url) {
    frame.dataset.url = pin.url;
    frame.src = pin.url;
  }
  document.getElementById("sdr-listen").hidden = false;
  renderSdrList();
  renderGpsList();
  renderConflictList();
  renderRadioList();
  renderStreamList();
  const entity = findPin(pin.kind, pin.id);
  if (entity && state.viewer && state.viewer.selectedEntity !== entity) {
    state.viewer.selectedEntity = entity;
  }
  if (options.fly && state.viewer && Number.isFinite(Number(pin.lat)) && Number.isFinite(Number(pin.lon))) {
    const height = pin.kind === "sdr" ? 280000 : 800000;
    state.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(pin.lon, pin.lat, height),
      duration: 0.9,
    });
  }
}

function closePin() {
  const frame = document.getElementById("sdr-frame");
  frame.src = "about:blank";
  frame.dataset.url = "";
  state.openKind = "";
  state.openId = "";
  document.getElementById("sdr-listen").hidden = true;
  renderSdrList();
  renderGpsList();
  renderConflictList();
  renderRadioList();
  renderStreamList();
}

async function loadRadio() {
  const response = await fetch("/api/radio");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Uniden radio overlay failed");
  state.radioPoints = Array.isArray(body.points) ? body.points : [];
  state.radioCount = Number(body.count) || state.radioPoints.length;
  setCount("radio", state.radioCount);
  placeRadioPins(state.radioPoints);
  renderRadioList();
  const stamp = body.updated ? ` · ${body.updated}` : "";
  setStatus(`${state.radioCount} UNIDEN SITES${stamp} · ${state.radioPoints.length} ON GLOBE · ${body.source || "HPDB"}`);
}

function placeRadioPins(points) {
  if (!state.viewer || !state.radioSource) return;
  state.radioSource.entities.removeAll();
  state.radioSource.show = Boolean(state.layers.radio);
  const gold = Cesium.Color.fromCssColorString("#f5c542");
  const outline = Cesium.Color.fromCssColorString("#2a1c04");
  for (const site of points) {
    if (site.lat == null || site.lon == null) continue;
    const entity = state.radioSource.entities.add({
      name: site.name,
      position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 0),
      point: {
        pixelSize: site.n > 20 ? 8 : 5,
        color: gold,
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(2e5, 1.2, 8e6, 0.45),
      },
    });
    entity._radio = site;
  }
}

function renderRadioList() {
  const list = document.getElementById("radio-list");
  if (!list) return;
  const query = (document.getElementById("radio-filter").value || "").trim().toLowerCase();
  const sites = state.radioPoints
    .filter((site) => {
      if (!query) return true;
      const hay = `${site.name} ${site.mode} ${(site.mhz || []).join(" ")}`.toLowerCase();
      return hay.includes(query);
    })
    .slice()
    .sort((a, b) => (b.n || 0) - (a.n || 0) || a.name.localeCompare(b.name))
    .slice(0, 500);
  list.innerHTML = "";
  for (const site of sites) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "radio-row";
    if (site.id === state.radioOpenId) row.classList.add("on");
    const mhz = (site.mhz || []).map((m) => `${m} MHz`).join(" · ");
    row.innerHTML = `<div class="name">${esc(site.name)}</div><div class="host">${esc(site.mode || "HPDB")} · ${site.n || 0} freqs${mhz ? " · " + esc(mhz) : ""}</div>`;
    row.addEventListener("click", () => openRadio(site, { fly: true }));
    list.append(row);
  }
  if (state.feedMode === "radio") {
    document.getElementById("feed-title").textContent = `RADIO ${state.radioCount || state.radioPoints.length}`;
  }
}

function findRadioEntity(id) {
  if (!state.radioSource) return null;
  for (const entity of state.radioSource.entities.values) {
    if (entity._radio && entity._radio.id === id) return entity;
  }
  return null;
}

async function loadStreams() {
  const response = await fetch("/api/streams");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Stream overlay failed");
  state.streamPoints = Array.isArray(body.points) ? body.points : [];
  setCount("stream", state.streamPoints.length);
  placeStreamPins(state.streamPoints);
  renderStreamList();
}

function placeStreamPins(points) {
  if (!state.viewer || !state.streamSource) return;
  state.streamSource.entities.removeAll();
  state.streamSource.show = Boolean(state.layers.stream);
  const color = Cesium.Color.fromCssColorString("#c084fc");
  const outline = Cesium.Color.fromCssColorString("#2a1038");
  for (const site of points) {
    if (site.lat == null || site.lon == null) continue;
    const entity = state.streamSource.entities.add({
      name: site.name,
      position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 0),
      point: {
        pixelSize: site.online === false ? 6 : 8,
        color: site.online === false ? color.withAlpha(0.35) : color,
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(2e5, 1.25, 8e6, 0.5),
      },
    });
    entity._stream = site;
  }
}

function renderStreamList() {
  const list = document.getElementById("stream-list");
  if (!list) return;
  const query = (document.getElementById("stream-filter").value || "").trim().toLowerCase();
  const sites = state.streamPoints
    .filter((site) => {
      if (!query) return true;
      const hay = `${site.name} ${site.county} ${site.state} ${site.source} ${site.hpdbName || ""}`.toLowerCase();
      return hay.includes(query);
    })
    .slice()
    .sort((a, b) => (b.listeners || 0) - (a.listeners || 0) || a.name.localeCompare(b.name))
    .slice(0, 500);
  list.innerHTML = "";
  for (const site of sites) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "stream-row";
    if (site.id === state.streamOpenId) row.classList.add("on");
    const where = [site.county, site.state, site.source].filter(Boolean).join(" · ");
    row.innerHTML = `<div class="name">${esc(site.name)}</div><div class="host">${esc(where)}${site.listeners ? " · " + site.listeners + " listening" : ""}${site.hpdbName ? " · HPDB " + esc(site.hpdbName) : ""}</div>`;
    row.addEventListener("click", () => openStream(site, { fly: true }));
    list.append(row);
  }
  if (state.feedMode === "stream") {
    document.getElementById("feed-title").textContent = `STREAM ${state.streamPoints.length}`;
  }
}

function findStreamEntity(id) {
  if (!state.streamSource) return null;
  for (const entity of state.streamSource.entities.values) {
    if (entity._stream && entity._stream.id === id) return entity;
  }
  return null;
}

function openStream(site, options = {}) {
  if (!site || !site.url) return;
  state.streamOpenId = site.id;
  setFeedMode("stream");
  const box = document.getElementById("selected");
  box.hidden = false;
  const match = site.hpdbName ? ` · HPDB ${site.hpdbName}` : "";
  box.innerHTML = `<b>STREAM</b> ${esc(site.name)}<br>${esc(site.source || "")} · ${esc(site.county || "")} ${esc(site.state || "")}${match}<br>${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}`;
  renderStreamList();
  const entity = findStreamEntity(site.id);
  if (entity && state.viewer && state.viewer.selectedEntity !== entity) {
    state.viewer.selectedEntity = entity;
  }
  if (options.fly && state.viewer) {
    state.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 180000),
      duration: 0.9,
    });
  }
  const panel = document.getElementById("sdr-listen");
  document.getElementById("sdr-title").textContent = site.name;
  document.getElementById("sdr-meta").textContent = [site.county, site.state, site.source, site.hpdbName].filter(Boolean).join(" · ");
  const pop = document.getElementById("sdr-pop");
  pop.href = site.url;
  const frame = document.getElementById("sdr-frame");
  if (frame.dataset.url !== site.url) {
    frame.dataset.url = site.url;
    frame.src = site.url;
  }
  panel.hidden = false;
}

function openRadio(site, options = {}) {
  if (!site) return;
  closePin();
  state.radioOpenId = site.id;
  setFeedMode("radio");
  const mhz = (site.mhz || []).map((m) => `${m} MHz`).join(" · ");
  const box = document.getElementById("selected");
  box.hidden = false;
  box.innerHTML = `<b>RADIO</b> ${esc(site.name)}<br>${esc(site.mode || "HPDB")} · ${site.n || 0} freqs<br>${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}${mhz ? "<br>" + esc(mhz) : ""}`;
  renderRadioList();
  const entity = findRadioEntity(site.id);
  if (entity && state.viewer && state.viewer.selectedEntity !== entity) {
    state.viewer.selectedEntity = entity;
  }
  if (options.fly && state.viewer) {
    state.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 180000),
      duration: 0.9,
    });
  }
}

const LIVE_STYLE = {
  jamming: { color: "#ff7a3a", outline: "#3a1508", size: (p) => (p.pct > 80 ? 9 : 6), kind: "GPS JAM" },
  aircraft: { color: "#7ec8ff", outline: "#082033", size: () => 5, kind: "ADS-B" },
  ships: { color: "#3dffd0", outline: "#083028", size: () => 5, kind: "AIS" },
  conflicts: { color: "#ff3b6b", outline: "#3a0814", size: () => 11, kind: "CFR WAR" },
};

function aircraftStyle(point) {
  if (point.emergency || point.squawk === "7700") {
    return { color: "#ff5c5c", outline: "#3a0810", size: 10, kind: "ADS-B EMERG" };
  }
  if (point.squawk === "7600" || point.squawk === "7500") {
    return { color: "#ffb020", outline: "#3a2808", size: 9, kind: "ADS-B SQK" };
  }
  if (point.mil) {
    return { color: "#d4e06a", outline: "#2a3008", size: 7, kind: "ADS-B MIL" };
  }
  return { color: "#7ec8ff", outline: "#082033", size: 5, kind: "ADS-B" };
}

async function pollLiveFeeds() {
  const data = await fetch("/api/feeds").then((response) => response.json());
  for (const key of ["jamming", "aircraft", "ships"]) {
    const layer = data[key] || {};
    state.live[key].points = layer.points || [];
    setCount(key, layer.count ?? state.live[key].points.length);
    placeLiveLayer(key, state.live[key].points);
  }
  statusLive();
}

function placeLiveLayer(key, points) {
  const layer = state.live[key];
  if (!layer?.source) return;
  layer.source.entities.removeAll();
  layer.source.show = Boolean(state.layers[key]);
  const base = LIVE_STYLE[key];
  for (const point of points) {
    if (point.lat == null || point.lon == null) continue;
    const style = key === "aircraft" ? aircraftStyle(point) : {
      color: base.color,
      outline: base.outline,
      size: base.size(point),
      kind: base.kind,
    };
    const height = key === "aircraft" ? Number(point.altM) || 0 : 0;
    const entity = layer.source.entities.add({
      name: point.name,
      position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, height),
      point: {
        pixelSize: style.size,
        color: Cesium.Color.fromCssColorString(style.color),
        outlineColor: Cesium.Color.fromCssColorString(style.outline),
        outlineWidth: 1,
        disableDepthTestDistance: key === "aircraft" ? 0 : Number.POSITIVE_INFINITY,
      },
    });
    entity._live = { ...point, kind: style.kind, layer: key };
  }
}

function showLive(item) {
  const box = document.getElementById("selected");
  box.hidden = false;
  let extra = "";
  if (item.url) extra = `<br><a href="${esc(item.url)}" target="_blank" rel="noreferrer">CFR briefing</a>`;
  else if (item.pct != null) extra = `<br>${item.pct}% bad NACp · ${item.bad || 0} degraded`;
  else if (item.layer === "aircraft") {
    const bits = [];
    if (item.hex) bits.push(item.hex);
    if (item.t) bits.push(item.t);
    if (item.r) bits.push(item.r);
    if (item.squawk) bits.push(`sqk ${item.squawk}`);
    extra = bits.length ? `<br>${esc(bits.join(" · "))}` : "";
    extra += `<br>alt ${esc(item.alt ?? "—")} ft · ${esc(item.gs ?? "—")} kt · hdg ${esc(item.track || 0)}`;
    const flags = ["mil", "ladd", "pia", "emergency"].filter((k) => item[k]);
    if (flags.length) extra += `<br>${esc(flags.join(" · "))}`;
  } else if (item.sog != null) extra = `<br>sog ${esc(item.sog)} kn`;
  box.innerHTML = `<b>${esc(item.kind)}</b> ${esc(item.name)}<br>${Number(item.lat).toFixed(2)}, ${Number(item.lon).toFixed(2)}${extra}`;
}

function statusLive(error) {
  const jam = state.live.jamming.points.length;
  const air = state.live.aircraft.points.length;
  const ais = state.live.ships.points.length;
  const gps = state.gpsReady ? `${state.gpsZones.length} GPS` : "GPS …";
  const war = state.conflictsReady ? `${state.conflicts.length} WAR` : "WAR …";
  const parts = [
    `${state.sdrStations.length} WEBSDR`,
    `${state.radioCount || 0} RADIO`,
    `${state.streamPoints.length} STREAMS`,
    gps,
    `JAM ${jam}`,
    `AIR ${air}`,
    `AIS ${ais}`,
    war,
  ];
  if (error) parts.push(error);
  setStatus(parts.join(" · "));
}

boot().catch((error) => setStatus(error.message || String(error)));
