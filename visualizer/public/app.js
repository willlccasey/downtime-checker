const globe = document.getElementById("globe");
const spark = document.getElementById("spark");
const gctx = globe.getContext("2d");
const sctx = spark.getContext("2d");

const state = {
  land: [],
  rotY: 0.35,
  rotX: 0.18,
  zoom: 1,
  dragging: false,
  lastX: 0,
  lastY: 0,
  auto: true,
  results: [],
  arcs: [],
  pulses: [],
  times: [],
  filter: "all",
  selected: null,
  heading: "AWAITING TASKING",
  running: false,
  total: 0,
  done: 0,
  up: 0,
  down: 0,
  startedAt: 0,
};

const ORIGIN = { lat: 35.84, lon: -90.7 };

async function boot() {
  const [land, catalog] = await Promise.all([
    fetch("/world-land.json").then((r) => r.json()),
    fetch("/api/catalog").then((r) => r.json()),
  ]);
  state.land = densifyLand(land);
  const params = new URLSearchParams(location.search);
  if (params.has("rot")) {
    state.rotY = Number(params.get("rot")) || 0;
    state.auto = false;
  }
  renderSearches(catalog);
  fillCountries(catalog.countries);
  hookUi();
  connectEvents();
  tickClock();
  resize();
  loop();
  window.addEventListener("resize", resize);
}

function renderSearches(catalog) {
  const nav = document.getElementById("searches");
  nav.innerHTML = "";
  const groups = [
    ["GLOBAL", catalog.searches.filter((s) => s.group === "global")],
    ["UNITED STATES", catalog.searches.filter((s) => s.group === "us")],
  ];
  for (const [label, items] of groups) {
    const h = document.createElement("h3");
    h.textContent = label;
    nav.append(h);
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.id = item.id;
      btn.innerHTML = `<span>${item.label}</span><span class="count">${item.count}</span>`;
      btn.addEventListener("click", () => startScan(item.id));
      nav.append(btn);
    }
  }
}

function fillCountries(list) {
  const select = document.getElementById("country");
  select.innerHTML = list.map((name) => `<option value="${name}">${name}</option>`).join("");
}

function hookUi() {
  document.getElementById("btn-country").addEventListener("click", () => {
    const country = document.getElementById("country").value;
    startScan("country", country);
  });
  document.getElementById("btn-stop").addEventListener("click", () => {
    fetch("/api/stop", { method: "POST" });
  });
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
      chip.classList.add("on");
      state.filter = chip.dataset.filter;
      renderFeed();
    });
  }
  globe.addEventListener("pointerdown", (e) => {
    state.dragging = true;
    state.auto = false;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    globe.setPointerCapture(e.pointerId);
  });
  globe.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    state.rotY += (e.clientX - state.lastX) * 0.005;
    state.rotX = clamp(state.rotX + (e.clientY - state.lastY) * 0.004, -1.1, 1.1);
    state.lastX = e.clientX;
    state.lastY = e.clientY;
  });
  globe.addEventListener("pointerup", () => { state.dragging = false; });
  globe.addEventListener("wheel", (e) => {
    e.preventDefault();
    state.zoom = clamp(state.zoom * (e.deltaY > 0 ? 0.94 : 1.06), 0.7, 2.4);
  }, { passive: false });
  globe.addEventListener("click", (e) => {
    if (state.dragging) return;
    const hit = pickNode(e.offsetX, e.offsetY);
    if (hit) selectResult(hit);
  });
}

async function startScan(id, country) {
  document.querySelectorAll(".searches button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.id === id);
  });
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, country }),
  });
  if (res.status === 409) {
    setStatus("SCAN ALREADY IN FLIGHT");
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    setStatus(body.error || "SCAN FAILED TO START");
  }
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.type === "hello" && event.state?.results?.length) {
      applySnapshot(event.state);
    }
    if (event.type === "scan-start") {
      state.results = [];
      state.arcs = [];
      state.pulses = [];
      state.times = [];
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
      document.getElementById("link-dot").className = "pulse-dot live";
      document.getElementById("selected").hidden = true;
      setStatus(`TASKING ${event.total} NODES · ${event.heading.toUpperCase()}`);
      renderFeed();
      renderCountries();
    }
    if (event.type === "result") {
      state.results[event.result.index] = event.result;
      state.done = event.done;
      state.up = event.up;
      state.down = event.down;
      state.times.push(event.result.ms);
      if (event.result.lat != null && event.result.lon != null) {
        state.arcs.push({
          from: ORIGIN,
          to: event.result,
          born: performance.now(),
          up: event.result.status === "up",
        });
        if (state.arcs.length > 48) state.arcs.shift();
        state.pulses.push({ lat: event.result.lat, lon: event.result.lon, born: performance.now(), up: event.result.status === "up" });
      }
      prependFeed(event.result);
      updateHud();
    }
    if (event.type === "location") {
      state.results[event.result.index] = event.result;
      if (state.selected?.address === event.result.address) selectResult(event.result);
    }
    if (event.type === "locating") setStatus(`RESOLVING ${event.count} COORDINATES`);
    if (event.type === "scan-done") {
      state.running = false;
      document.getElementById("btn-stop").hidden = true;
      document.getElementById("link-dot").className = event.down ? "pulse-dot hot" : "pulse-dot live";
      setStatus(`COMPLETE · ${event.up} UP · ${event.down} DOWN · ${(event.ms / 1000).toFixed(1)}s`);
      renderCountries();
    }
    if (event.type === "scan-stop") {
      state.running = false;
      document.getElementById("btn-stop").hidden = true;
      setStatus("SCAN ABORTED");
    }
    if (event.type === "error") setStatus(event.message);
  };
  es.onerror = () => setStatus("EVENT STREAM DROPPED · RECONNECTING");
}

function applySnapshot(snap) {
  state.results = snap.results || [];
  state.running = snap.running;
  state.total = snap.total;
  state.done = snap.done;
  state.up = snap.up;
  state.down = snap.down;
  state.heading = snap.heading || state.heading;
  document.getElementById("heading").textContent = (state.heading || "AWAITING TASKING").toUpperCase();
  document.getElementById("btn-stop").hidden = !snap.running;
  renderFeed();
  renderCountries();
  updateHud();
}

function visibleResults() {
  return state.results.filter((r) => r && (state.filter === "all" || r.status === state.filter));
}

function prependFeed(result) {
  if (state.filter !== "all" && result.status !== state.filter) {
    updateHud();
    return;
  }
  const feed = document.getElementById("feed");
  feed.prepend(rowEl(result));
  while (feed.children.length > 400) feed.lastChild.remove();
  updateHud();
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
    <div class="badge ${result.status}">${result.status.toUpperCase()}</div>
    <div>
      <div class="name">${esc(result.name)}</div>
      <div class="host">${esc(result.address)}${result.method && result.method !== "none" ? " · " + result.method : ""}</div>
    </div>
    <div>${result.ms}ms</div>`;
  row.addEventListener("click", () => selectResult(result));
  return row;
}

function renderCountries() {
  const box = document.getElementById("countries");
  const groups = new Map();
  for (const result of state.results) {
    if (!result) continue;
    const key = result.country || "Unknown";
    const g = groups.get(key) || { up: 0, down: 0 };
    if (result.status === "up") g.up += 1;
    if (result.status === "down") g.down += 1;
    groups.set(key, g);
  }
  const ranked = [...groups.entries()]
    .map(([name, g]) => ({ name, ...g, total: g.up + g.down }))
    .sort((a, b) => b.down - a.down || b.total - a.total)
    .slice(0, 12);
  box.innerHTML = ranked.map((g) => {
    const pct = g.total ? (g.up / g.total) * 100 : 0;
    return `<div class="bar ${g.down ? "hot" : ""}"><div><div>${esc(g.name)}</div><div class="track"><div class="fill" style="width:${pct}%"></div></div></div><div>${g.up}/${g.total}</div></div>`;
  }).join("");
}

function selectResult(result) {
  state.selected = result;
  state.auto = false;
  if (result.lon != null) state.rotY = -result.lon * Math.PI / 180;
  if (result.lat != null) state.rotX = result.lat * Math.PI / 180 * 0.65;
  const el = document.getElementById("selected");
  el.hidden = false;
  el.innerHTML = `<b>${esc(result.status.toUpperCase())}</b> ${esc(result.name)}<br>${esc(result.address)}${result.ip ? " · " + esc(result.ip) : ""}<br>${esc(result.location || result.country || "location pending")}<br>${result.ms}ms · ${esc(result.method || "—")}`;
}

function updateHud() {
  document.getElementById("stat-done").textContent = state.done;
  document.getElementById("stat-total").textContent = `/ ${state.total}`;
  document.getElementById("stat-up").textContent = state.up;
  document.getElementById("stat-down").textContent = state.down;
  document.getElementById("stat-pct").textContent = state.done ? `${Math.round((state.up / state.done) * 100)}%` : "—";
  document.getElementById("stat-ms").textContent = state.running
    ? `${((Date.now() - state.startedAt) / 1000).toFixed(0)}s`
    : state.done
      ? "DONE"
      : "IDLE";
  document.getElementById("progress").style.width = state.total ? `${(state.done / state.total) * 100}%` : "0%";
}

function setStatus(text) {
  document.getElementById("status-line").textContent = text;
}

function tickClock() {
  const now = new Date();
  document.getElementById("clock").textContent = now.toISOString().slice(11, 19) + "Z";
  requestAnimationFrame(tickClock);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const canvas of [globe, spark]) {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }
}

function loop() {
  if (state.auto) state.rotY += 0.0016;
  drawGlobe();
  drawSpark();
  requestAnimationFrame(loop);
}

function wrapLon(lon) {
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return lon;
}

function densifyLand(rings) {
  const out = [];
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    const last = ring.length - 1;
    const closed = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
    const count = closed ? last : ring.length;
    const pts = [];
    for (let i = 0; i < count; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % count];
      let dlon = b[0] - a[0];
      if (dlon > 180) dlon -= 360;
      if (dlon < -180) dlon += 360;
      const dlat = b[1] - a[1];
      const steps = Math.max(1, Math.ceil(Math.hypot(dlon, dlat) / 1.6));
      for (let s = 0; s < steps; s += 1) {
        pts.push([wrapLon(a[0] + (dlon * s) / steps), a[1] + (dlat * s) / steps]);
      }
    }
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

function project(lat, lon) {
  const λ = lon * Math.PI / 180 + state.rotY;
  const φ = lat * Math.PI / 180;
  const x = Math.cos(φ) * Math.sin(λ);
  const y = Math.sin(φ);
  const z = Math.cos(φ) * Math.cos(λ);
  const cx = Math.cos(state.rotX);
  const sx = Math.sin(state.rotX);
  return { x, y: y * cx - z * sx, z: y * sx + z * cx };
}

function screen(p, cx, cy, r) {
  return { x: cx + p.x * r, y: cy - p.y * r, front: p.z >= 0 };
}

function limbIntersect(a, b) {
  const dz = b.z - a.z;
  const t = Math.abs(dz) < 1e-12 ? 0 : Math.min(1, Math.max(0, -a.z / dz));
  const x = a.x + t * (b.x - a.x);
  const y = a.y + t * (b.y - a.y);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len, z: 0 };
}

function clipFront(poly) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const cur = poly[i];
    const prev = poly[(i + n - 1) % n];
    const curIn = cur.z >= 0;
    const prevIn = prev.z >= 0;
    if (curIn) {
      if (!prevIn) out.push(limbIntersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(limbIntersect(prev, cur));
    }
  }
  return out;
}

function withLimbArcs(poly) {
  if (poly.length < 3) return poly;
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    out.push(a);
    if (a.z > 1e-4 || b.z > 1e-4) continue;
    let a0 = Math.atan2(a.y, a.x);
    let a1 = Math.atan2(b.y, b.x);
    let delta = a1 - a0;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.07));
    for (let s = 1; s < steps; s += 1) {
      const ang = a0 + (delta * s) / steps;
      out.push({ x: Math.cos(ang), y: Math.sin(ang), z: 0 });
    }
  }
  return out;
}

function strokeClipped(latlons, cx, cy, r) {
  gctx.beginPath();
  let drawing = false;
  let prev = null;
  for (const [lat, lon] of latlons) {
    const p = project(lat, lon);
    if (prev) {
      const aIn = prev.z >= 0;
      const bIn = p.z >= 0;
      if (aIn && bIn) {
        if (!drawing) {
          const a = screen(prev, cx, cy, r);
          gctx.moveTo(a.x, a.y);
          drawing = true;
        }
        const s = screen(p, cx, cy, r);
        gctx.lineTo(s.x, s.y);
      } else if (aIn && !bIn) {
        const s = screen(limbIntersect(prev, p), cx, cy, r);
        if (!drawing) {
          const a = screen(prev, cx, cy, r);
          gctx.moveTo(a.x, a.y);
        }
        gctx.lineTo(s.x, s.y);
        drawing = false;
      } else if (!aIn && bIn) {
        const s = screen(limbIntersect(prev, p), cx, cy, r);
        const b = screen(p, cx, cy, r);
        gctx.moveTo(s.x, s.y);
        gctx.lineTo(b.x, b.y);
        drawing = true;
      } else {
        drawing = false;
      }
    }
    prev = p;
  }
  gctx.stroke();
}

function drawClippedRing(ring, cx, cy, r) {
  const projected = ring.map(([lon, lat]) => project(lat, lon));
  const clipped = withLimbArcs(clipFront(projected));
  if (clipped.length < 3) return;
  gctx.beginPath();
  const first = screen(clipped[0], cx, cy, r);
  gctx.moveTo(first.x, first.y);
  for (let i = 1; i < clipped.length; i += 1) {
    const s = screen(clipped[i], cx, cy, r);
    gctx.lineTo(s.x, s.y);
  }
  gctx.closePath();
  gctx.fill();
}

function drawGlobe() {
  const { width, height } = globe;
  const cx = width / 2;
  const cy = height / 2 + height * 0.02;
  const r = Math.min(width, height) * 0.38 * state.zoom;
  gctx.clearRect(0, 0, width, height);

  const grd = gctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r * 1.4);
  grd.addColorStop(0, "#12324a");
  grd.addColorStop(0.55, "#071422");
  grd.addColorStop(1, "#02050a");
  gctx.fillStyle = grd;
  gctx.beginPath();
  gctx.arc(cx, cy, r, 0, Math.PI * 2);
  gctx.fill();

  gctx.save();
  gctx.beginPath();
  gctx.arc(cx, cy, r, 0, Math.PI * 2);
  gctx.clip();

  gctx.strokeStyle = "rgba(60,240,255,0.08)";
  gctx.lineWidth = 1;
  for (let lat = -60; lat <= 60; lat += 30) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 4) line.push([lat, lon]);
    strokeClipped(line, cx, cy, r);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const line = [];
    for (let lat = -90; lat <= 90; lat += 4) line.push([lat, lon]);
    strokeClipped(line, cx, cy, r);
  }

  gctx.fillStyle = "rgba(60, 240, 255, 0.13)";
  for (const ring of state.land) drawClippedRing(ring, cx, cy, r);

  const now = performance.now();
  state.arcs = state.arcs.filter((a) => now - a.born < 2200);
  for (const arc of state.arcs) {
    const a = project(arc.from.lat, arc.from.lon);
    const b = project(arc.to.lat, arc.to.lon);
    if (a.z < 0 && b.z < 0) continue;
    const mid = {
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5 + 0.28,
      z: (a.z + b.z) * 0.5,
    };
    const sa = screen(a, cx, cy, r);
    const sb = screen(b, cx, cy, r);
    const sm = screen(mid, cx, cy, r);
    const age = (now - arc.born) / 2200;
    gctx.strokeStyle = arc.up
      ? `rgba(61,255,154,${0.55 * (1 - age)})`
      : `rgba(255,59,107,${0.7 * (1 - age)})`;
    gctx.lineWidth = 1.6;
    gctx.beginPath();
    gctx.moveTo(sa.x, sa.y);
    gctx.quadraticCurveTo(sm.x, sm.y, sb.x, sb.y);
    gctx.stroke();
  }

  for (const result of state.results) {
    if (!result || result.lat == null) continue;
    const s = screen(project(result.lat, result.lon), cx, cy, r);
    if (!s.front) continue;
    const up = result.status === "up";
    gctx.fillStyle = result.status === "pending" ? "#f0c14a" : up ? "#3dff9a" : "#ff3b6b";
    gctx.shadowColor = gctx.fillStyle;
    gctx.shadowBlur = 12;
    gctx.beginPath();
    gctx.arc(s.x, s.y, result === state.selected ? 5.5 : 2.4, 0, Math.PI * 2);
    gctx.fill();
    gctx.shadowBlur = 0;
  }

  state.pulses = state.pulses.filter((p) => now - p.born < 900);
  for (const pulse of state.pulses) {
    const s = screen(project(pulse.lat, pulse.lon), cx, cy, r);
    if (!s.front) continue;
    const t = (now - pulse.born) / 900;
    gctx.strokeStyle = pulse.up ? `rgba(61,255,154,${1 - t})` : `rgba(255,59,107,${1 - t})`;
    gctx.lineWidth = 2;
    gctx.beginPath();
    gctx.arc(s.x, s.y, 4 + t * 18, 0, Math.PI * 2);
    gctx.stroke();
  }

  gctx.restore();

  gctx.beginPath();
  gctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  gctx.strokeStyle = "rgba(60,240,255,0.18)";
  gctx.lineWidth = 2;
  gctx.stroke();
  gctx.beginPath();
  gctx.arc(cx, cy, r + 18, 0, Math.PI * 2);
  gctx.strokeStyle = "rgba(60,240,255,0.08)";
  gctx.stroke();

  const atm = gctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.18);
  atm.addColorStop(0, "rgba(60,240,255,0)");
  atm.addColorStop(1, "rgba(60,240,255,0.12)");
  gctx.fillStyle = atm;
  gctx.beginPath();
  gctx.arc(cx, cy, r * 1.18, 0, Math.PI * 2);
  gctx.fill();
}

function pickNode(x, y) {
  const dpr = globe.width / globe.getBoundingClientRect().width;
  const px = x * dpr;
  const py = y * dpr;
  const cx = globe.width / 2;
  const cy = globe.height / 2 + globe.height * 0.02;
  const r = Math.min(globe.width, globe.height) * 0.38 * state.zoom;
  let best = null;
  let bestD = 14 * dpr;
  for (const result of state.results) {
    if (!result || result.lat == null) continue;
    const s = screen(project(result.lat, result.lon), cx, cy, r);
    if (!s.front) continue;
    const d = Math.hypot(s.x - px, s.y - py);
    if (d < bestD) {
      bestD = d;
      best = result;
    }
  }
  return best;
}

function drawSpark() {
  const { width, height } = spark;
  sctx.clearRect(0, 0, width, height);
  const data = state.times.slice(-80);
  if (!data.length) return;
  const max = Math.max(80, ...data);
  sctx.beginPath();
  data.forEach((ms, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * width;
    const y = height - (ms / max) * (height - 6) - 3;
    if (i === 0) sctx.moveTo(x, y);
    else sctx.lineTo(x, y);
  });
  sctx.strokeStyle = "#3cf0ff";
  sctx.lineWidth = 1.5;
  sctx.stroke();
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

boot().catch((err) => setStatus(String(err)));
