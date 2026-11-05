// GMRT 断层识别 · 页面逻辑（地图、区域选择、参数导入、运行进度、结果展示）
/* global L */
import { ALT_KEYS, FEATURES, FEATURE_LABEL, GROUPS, PARAM_ORDER, SCHEMA, buildTransfer, changedKeys, clone,
  extractStep5Block, parseImport, parsePyBlock, sameValue, validateParams } from "./params.js";

const APP_VERSION = "1.1.0";
const PRESETS = { mar29n: { name: "MAR 29°N · CD99", bbox: [-43.75, -42.55, 28.74, 29.36] } };
const MAX_CELLS = 8e6;                                // 浏览器里允许的分析网格像元上限（约 1.4 GB 内存）
const WARN_CELLS = 4e6;
const COLORS = { inward: "#ff4d6d", outward: "#ffb020", unknown: "#c7d2e0", casing: "#060c1a", axis: "#f8fafc", aoi: "#38bdf8" };
const HEAT = ["#ffe066", "#ffa94d", "#ff6b4a", "#e8384f", "#b5179e"];   // 断距：浅 -> 深
const STEPS = [
  { num: 0, title: "准备 Python 引擎", w: 0 },
  { num: 1, title: "下载 GMRT 网格", w: 0 },
  { num: 2, title: "读取 GeoTIFF 与地理参考", w: 1 },
  { num: 3, title: "重投影到 UTM 米制网格", w: 6 },
  { num: 4, title: "数据调理", w: 9 },
  { num: 6, title: "地形导数与区域走向", w: 8 },
  { num: 7, title: "陡坎中心线候选", w: 10 },
  { num: 8, title: "断距测量", w: 6 },
  { num: 9, title: "像元属性图与骨架化", w: 4 },
  { num: 10, title: "骨架拆成像元路径", w: 10 },
  { num: 11, title: "按朝向分段并平滑", w: 3 },
  { num: 12, title: "共线同朝向线段的连接", w: 3 },
  { num: 13, title: "候选属性与形态特征", w: 10 },
  { num: 14, title: "接受规则与评分器", w: 1 },
  { num: 15, title: "中轴与内倾 / 外倾", w: 6 },
  { num: 16, title: "构造应变", w: 4 },
  { num: 17, title: "输出与地图预览", w: 10 },
];
const STEP_W_TOTAL = STEPS.reduce((a, s) => a + s.w, 0);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式等 */ } },
};
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "—"
  : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtMB = (b) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
const pct = (v, d = 1) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
const hemi = (v, pos, neg) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? pos : neg}`;
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style") n.setAttribute("style", v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== undefined) n.append(c);
  return n;
}
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
let toastTimer = null;
function toast(text, ms = 3200) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ 状态
const saved = store.get("gfd.settings", {});
const state = {
  bbox: saved.bbox || PRESETS.mar29n.bbox.slice(),
  res: saved.res || "max",
  basemap: saved.basemap || "gmrt",
  params: null,        // 当前识别参数（读入实现文件第 5 步后才有）
  source: null,        // 参数来源：{ kind: "builtin" } 或 { kind: "file", name, format, meta, base, alt, imported }
  fieldText: {},       // 手动填写中暂时无效的输入
  parked: {},          // 取消勾选的评分器特征的数值
  colorMode: "polarity",
  legendCollapsed: window.matchMedia("(max-width: 860px)").matches,
  estimate: null,
  running: false,
  result: null,
};
(() => {   // URL #bbox=W,E,S,N&res=max 优先于本地设置
  const h = new URLSearchParams(location.hash.slice(1));
  const b = (h.get("bbox") || "").split(",").map(Number);
  if (b.length === 4 && b.every(Number.isFinite)) state.bbox = b;
  if (["max", "high", "med"].includes(h.get("res"))) state.res = h.get("res");
})();
function persist() {
  store.set("gfd.settings", { bbox: state.bbox, res: state.res, basemap: state.basemap });
  const h = `#bbox=${state.bbox.map((v) => +v.toFixed(5)).join(",")}&res=${state.res}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

// ------------------------------------------------------------------ 地图
const map = L.map("map", { zoomControl: false, preferCanvas: true, worldCopyJump: true, minZoom: 2, maxZoom: 17,
  zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
L.control.zoom({ position: "topright", zoomInTitle: "放大", zoomOutTitle: "缩小" }).addTo(map);
L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 140 }).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
for (const [name, z] of [["preview", 350], ["aoi", 390], ["faults", 420], ["axis", 430]]) {
  map.createPane(name).style.zIndex = z;
}
map.getPane("preview").style.pointerEvents = "none";
map.getPane("aoi").style.pointerEvents = "none";
const faultRenderer = L.canvas({ pane: "faults", tolerance: 6 });
const axisRenderer = L.canvas({ pane: "axis" });

const ESRI_ATTR = "Tiles © Esri — GEBCO, NOAA, CHS, OSU, UNH, CSUMB, National Geographic, DeLorme, NAVTEQ, Esri";
const BASEMAPS = {
  gmrt: () => L.tileLayer.wms("https://www.gmrt.org/services/mapserver/wms_merc?", {
    layers: "GMRT", format: "image/jpeg", version: "1.3.0", maxZoom: 17,
    attribution: '地形 © <a href="https://www.gmrt.org" target="_blank" rel="noopener">GMRT</a> (Ryan et al., 2009, CC BY 4.0)' }),
  esri: () => L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 13, maxZoom: 17, attribution: ESRI_ATTR }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 13, maxZoom: 17 })]),
  coverage: () => L.tileLayer.wms("https://www.gmrt.org/services/mapserver/wms_merc_mask?", {
    layers: "GMRTMask", format: "image/png", version: "1.3.0", maxZoom: 17,
    attribution: '多波束覆盖 © <a href="https://www.gmrt.org" target="_blank" rel="noopener">GMRT</a> (Ryan et al., 2009, CC BY 4.0)' }),
  dark: () => L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 16, maxZoom: 17, attribution: "Tiles © Esri — Esri, DeLorme, NAVTEQ" }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 16, maxZoom: 17 })]),
};
let baseLayer = null;
function setBasemap(name) {
  if (!BASEMAPS[name]) name = "gmrt";
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = BASEMAPS[name]().addTo(map);
  state.basemap = name;
  for (const b of $$("#basemaps button")) b.setAttribute("aria-checked", String(b.dataset.v === name));
  persist();
}
$("#basemaps").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setBasemap(b.dataset.v); });
$("#btn-coverage").addEventListener("click", () => setBasemap("coverage"));

map.on("mousemove", (e) => {
  const { lat, lng } = e.latlng.wrap();
  $("#coords").textContent = `${hemi(lat, "N", "S")}  ${hemi(lng, "E", "W")}  ·  z${map.getZoom().toFixed(1)}`;
});
map.on("mouseout", () => { $("#coords").textContent = ""; });

// ------------------------------------------------------------------ 研究区域（矩形 + 拖动手柄 + 框选）
const inputs = { w: $("#in-w"), e: $("#in-e"), s: $("#in-s"), n: $("#in-n") };
const aoiRect = L.rectangle([[0, 0], [0, 0]], { pane: "aoi", renderer: L.svg({ pane: "aoi" }), color: COLORS.aoi, weight: 2,
  dashArray: "7 5", fillColor: COLORS.aoi, fillOpacity: 0.05, interactive: false }).addTo(map);
const MOVE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M12 2l-3 3m3-3 3 3M12 22l-3-3m3 3 3-3M2 12l3-3m-3 3 3 3M22 12l-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const corners = [0, 1, 2, 3].map((i) => L.marker([0, 0], {
  draggable: true, keyboard: false, zIndexOffset: 1000, title: "拖动调整范围",
  icon: L.divIcon({ className: "aoi-handle", iconSize: [14, 14] }) }).addTo(map));
const mover = L.marker([0, 0], { draggable: true, keyboard: false, zIndexOffset: 1001, title: "拖动移动研究区域",
  icon: L.divIcon({ className: "aoi-handle move", html: MOVE_SVG, iconSize: [22, 22] }) }).addTo(map);

function normBbox(b) {
  let [w, e, s, n] = b.map(Number);
  if (w > e) [w, e] = [e, w];
  if (s > n) [s, n] = [n, s];
  w = Math.max(-180, Math.min(180, w)); e = Math.max(-180, Math.min(180, e));
  s = Math.max(-85, Math.min(85, s)); n = Math.max(-85, Math.min(85, n));
  return [w, e, s, n].map((v) => Math.round(v * 1e6) / 1e6);
}
function cornerLatLngs([w, e, s, n]) { return [[n, w], [n, e], [s, e], [s, w]]; }
function setBbox(b, { fit = false, from = "code" } = {}) {
  state.bbox = normBbox(b);
  const [w, e, s, n] = state.bbox;
  aoiRect.setBounds([[s, w], [n, e]]);
  cornerLatLngs(state.bbox).forEach((ll, i) => { if (from !== `corner${i}`) corners[i].setLatLng(ll); });
  if (from !== "mover") mover.setLatLng([(s + n) / 2, (w + e) / 2]);
  if (from !== "input") {
    for (const k of ["w", "e", "s", "n"]) inputs[k].value = state.bbox[{ w: 0, e: 1, s: 2, n: 3 }[k]].toFixed(4).replace(/\.?0+$/, "");
  }
  for (const k of ["w", "e", "s", "n"]) inputs[k].closest(".bf").classList.remove("invalid");
  $("#hint-w").textContent = hemi(w, "E", "W").replace(/\.\d+/, (m) => m.slice(0, 3));
  $("#hint-e").textContent = hemi(e, "E", "W").replace(/\.\d+/, (m) => m.slice(0, 3));
  $("#hint-s").textContent = hemi(s, "N", "S").replace(/\.\d+/, (m) => m.slice(0, 3));
  $("#hint-n").textContent = hemi(n, "N", "S").replace(/\.\d+/, (m) => m.slice(0, 3));
  const isPreset = Object.entries(PRESETS).find(([, p]) => p.bbox.every((v, i) => Math.abs(v - state.bbox[i]) < 1e-6));
  $("#preset").value = isPreset ? isPreset[0] : "custom";
  if (fit) map.fitBounds(aoiRect.getBounds(), { padding: [40, 40] });
  persist();
  scheduleEstimate();
  if (state.params) renderSource();
}
corners.forEach((m, i) => {
  m.on("drag", () => {
    const p = m.getLatLng();
    const o = L.latLng(cornerLatLngs(state.bbox)[(i + 2) % 4]);
    setBbox([p.lng, o.lng, p.lat, o.lat], { from: `corner${i}` });
  });
  m.on("dragend", () => setBbox(state.bbox));
});
mover.on("drag", () => {
  const c = mover.getLatLng();
  const [w, e, s, n] = state.bbox;
  const hw = (e - w) / 2;
  const hh = (n - s) / 2;
  setBbox([c.lng - hw, c.lng + hw, c.lat - hh, c.lat + hh], { from: "mover" });
});
function readInputs() {
  const v = ["w", "e", "s", "n"].map((k) => parseFloat(inputs[k].value));
  const bad = { w: !Number.isFinite(v[0]) || v[0] < -180 || v[0] > 180, e: !Number.isFinite(v[1]) || v[1] < -180 || v[1] > 180,
    s: !Number.isFinite(v[2]) || v[2] < -85 || v[2] > 85, n: !Number.isFinite(v[3]) || v[3] < -85 || v[3] > 85 };
  if (!bad.w && !bad.e && v[0] >= v[1]) { bad.w = true; bad.e = true; }
  if (!bad.s && !bad.n && v[2] >= v[3]) { bad.s = true; bad.n = true; }
  for (const k of ["w", "e", "s", "n"]) inputs[k].closest(".bf").classList.toggle("invalid", bad[k]);
  return Object.values(bad).some(Boolean) ? null : v;
}
for (const k of ["w", "e", "s", "n"]) {
  inputs[k].addEventListener("input", debounce(() => { const v = readInputs(); if (v) setBbox(v, { from: "input" }); }, 350));
  inputs[k].addEventListener("change", () => { const v = readInputs(); if (v) setBbox(v, { fit: true }); });
}
$("#preset").addEventListener("change", (e) => { const p = PRESETS[e.target.value]; if (p) setBbox(p.bbox, { fit: true }); });
$("#btn-view").addEventListener("click", () => {
  const b = map.getBounds().pad(-0.08);
  setBbox([b.getWest(), b.getEast(), b.getSouth(), b.getNorth()]);
});
$("#btn-fit").addEventListener("click", () => map.fitBounds(aoiRect.getBounds(), { padding: [40, 40] }));

// 框选：按住拖动画矩形（鼠标、触屏、触控笔都可以）
const mapEl = $("#map");
let drawing = false;
let drawStart = null;
let drawRect = null;
function setDrawing(on) {
  drawing = on;
  mapEl.classList.toggle("drawing", on);
  $("#draw-hint").hidden = !on;
  $("#btn-draw").classList.toggle("active", on);
  mapEl.style.touchAction = on ? "none" : "";
  if (on) { map.dragging.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable(); } else {
    map.dragging.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable();
    if (drawRect) { map.removeLayer(drawRect); drawRect = null; }
    drawStart = null;
  }
}
$("#btn-draw").addEventListener("click", () => setDrawing(!drawing));
mapEl.addEventListener("pointerdown", (e) => {
  if (!drawing || (e.pointerType === "mouse" && e.button !== 0)) return;
  if (e.target.closest(".leaflet-control-container")) return;
  e.preventDefault();
  e.stopPropagation();
  drawStart = map.mouseEventToLatLng(e);
  try { mapEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  drawRect = L.rectangle(L.latLngBounds(drawStart, drawStart), { pane: "aoi", renderer: L.svg({ pane: "aoi" }), color: COLORS.aoi,
    weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
}, true);
mapEl.addEventListener("pointermove", (e) => {
  if (!drawing || !drawStart || !drawRect) return;
  e.stopPropagation();
  drawRect.setBounds(L.latLngBounds(drawStart, map.mouseEventToLatLng(e)));
}, true);
mapEl.addEventListener("pointerup", (e) => {
  if (!drawing || !drawStart || !drawRect) return;
  e.stopPropagation();
  const b = L.latLngBounds(drawStart, map.mouseEventToLatLng(e));
  const big = Math.abs(b.getEast() - b.getWest()) > 0.005 && Math.abs(b.getNorth() - b.getSouth()) > 0.005;
  setDrawing(false);
  if (big) setBbox([b.getWest(), b.getEast(), b.getSouth(), b.getNorth()]);
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawing) setDrawing(false); });

// ------------------------------------------------------------------ 数据量估算（GMRT 元数据服务）
let estimateAbort = null;
const scheduleEstimate = debounce(estimate, 450);
function setEstimate(level, html) {
  const box = $("#estimate");
  box.dataset.level = level;
  $("#estimate-text").replaceChildren(...html);
  const icon = box.querySelector("use");
  icon.setAttribute("href", level === "info" ? "#i-info" : "#i-alert");
}
async function estimate() {
  const [w, e, s, n] = state.bbox;
  const latC = (s + n) / 2;
  const kmW = (e - w) * 111.32 * Math.cos((latC * Math.PI) / 180);
  const kmH = (n - s) * 110.57;
  const size = el("span", { text: `约 ${fmt(kmW, kmW < 10 ? 1 : 0)} × ${fmt(kmH, kmH < 10 ? 1 : 0)} km` });
  if (estimateAbort) estimateAbort.abort();
  estimateAbort = new AbortController();
  setEstimate("info", [size, document.createTextNode(" · 正在向 GMRT 查询网格大小…")]);
  try {
    const q = new URLSearchParams({ west: w, east: e, south: s, north: n, format: "geotiff", resolution: state.res, mformat: "json" });
    const r = await fetch(`https://www.gmrt.org/services/GridServer/metadata?${q}`, { signal: estimateAbort.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = await r.json();
    const gb = m.grid_bounds || {};
    const width = Number(m.width);
    const height = Number(m.height);
    const dlon = (Number(gb.east) - Number(gb.west)) / width;
    const dlat = (Number(gb.north) - Number(gb.south)) / height;
    const degM = (Math.PI / 180) * 6378137;
    const nativeM = Math.min(dlon * degM * Math.cos((latC * Math.PI) / 180), dlat * degM);
    const px = Math.max(5, 5 * Math.floor(nativeM / 5));
    const nx = Math.round((kmW * 1000) / px);
    const ny = Math.round((kmH * 1000) / px);
    const cells = nx * ny;
    const bytes = width * height * 4 + 600;
    state.estimate = { width, height, px, nx, ny, cells, bytes, ok: cells <= MAX_CELLS && nx >= 60 && ny >= 60 };
    const parts = [size, document.createTextNode(" · GMRT "), el("b", { text: `${fmt(width)} × ${fmt(height)}` }),
      document.createTextNode(` 节点（${m.meters_per_node ?? "?"} m），下载 `), el("b", { text: fmtMB(bytes) }),
      el("br"), document.createTextNode("分析网格约 "), el("b", { text: `${fmt(nx)} × ${fmt(ny)}` }),
      document.createTextNode(` @ ${px} m（${(cells / 1e6).toFixed(1)} M 像元）`)];
    if (cells > MAX_CELLS) {
      state.estimate.message = `分析网格约 ${(cells / 1e6).toFixed(1)} M 像元，超过浏览器版上限 ${MAX_CELLS / 1e6} M。请缩小区域或降低分辨率。`;
      setEstimate("error", [...parts, el("br"), el("b", { text: "区域太大：" }), document.createTextNode("请缩小区域或降低 GMRT 分辨率。")]);
    } else if (nx < 60 || ny < 60) {
      state.estimate.message = "区域太小（分析网格不足 60 × 60 像元），请框选更大的范围。";
      setEstimate("error", [...parts, el("br"), el("b", { text: "区域太小：" }), document.createTextNode("至少需要约 60 × 60 个分析像元。")]);
    } else if (cells > WARN_CELLS || m.lessThanMaxNodes === false) {
      setEstimate("warn", [...parts, el("br"), document.createTextNode(m.lessThanMaxNodes === false
        ? "GMRT 会自动降低此范围的分辨率。" : "区域较大：计算可能需要几分钟、约 1 GB 内存。")]);
    } else {
      setEstimate("info", parts);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    state.estimate = null;
    setEstimate("warn", [size, document.createTextNode(" · 无法连接 GMRT 元数据服务，运行时以实际下载为准。")]);
  }
}

// ------------------------------------------------------------------ 识别参数：数据导入（上传文件 / 手动填写）、常用设置、导出
// state.params 是唯一的数据源：常用设置、手动填写表单、上传文件都读写它；运行时整套传给 Python（覆盖实现文件第 5 步）。
const builtin = { params: null, alt: null, error: "" };
const BUILTIN_DATASET = { aoi_name: "mar29n", bbox: PRESETS.mar29n.bbox, gmrt_res: "max" };
const srcBase = () => (state.source && state.source.base) || builtin.params;
const srcAlt = () => (!state.source || state.source.kind === "builtin" ? builtin.alt : state.source.alt);
function setSeg(id, v) { for (const b of $$(`#${id} button`)) b.setAttribute("aria-checked", String(b.dataset.v === v)); }
function persistParams() { store.set("gfd.params.v2", { params: state.params, source: state.source }); }
function fieldValidity() {
  const v = validateParams(state.params);
  for (const [k, raw] of Object.entries(state.fieldText)) v.fields[k] = `“${raw}” 不是有效的数值`;
  v.errors = Object.entries(v.fields).map(([k, e]) => `${k}（${SCHEMA[k].label}）：${e}`);
  v.ok = v.errors.length === 0;
  return v;
}
function sourceLabel() {
  const s = state.source;
  if (!s || s.kind === "builtin") return "实现文件内置参数";
  return `已导入：${s.name}`;
}

async function initParams() {
  try {
    const py = await (await fetch("py/gmrt_fault_detect.py")).text();
    const r = parsePyBlock(extractStep5Block(py));
    const v = validateParams(r.params);
    if (!v.ok) throw new Error(v.errors.join("；"));
    builtin.params = r.params;
    builtin.alt = r.alt;
  } catch (err) {
    builtin.error = String(err.message || err);
    $("#source-title").textContent = "无法读取实现文件第 5 步的参数";
    $("#source-sub").textContent = builtin.error;
    $("#params-tag").textContent = "出错";
    return;
  }
  const st = store.get("gfd.params.v2", null);
  if (st && st.params && st.source && validateParams(st.params).ok) {
    state.params = st.params;
    state.source = st.source;
  } else {
    state.params = clone(builtin.params);
    state.source = { kind: "builtin" };
  }
  buildForm();
  renderParamsUI();
}

function onParamsChanged(from = "") {
  persistParams();
  renderSource();
  renderQuick();
  syncForm(from);
}
function renderParamsUI() {
  renderSource();
  renderQuick();
  syncForm("");
  renderScorerTable();
}

function renderSource() {
  if (!state.params) return;
  const s = state.source;
  const base = srcBase();
  const changed = changedKeys(state.params, base);
  const meta = (s && s.meta) || {};
  const ds = s && s.kind !== "builtin" ? meta.dataset : BUILTIN_DATASET;
  if (!s || s.kind === "builtin") {
    $("#source-title").textContent = "实现文件内置参数";
    $("#source-sub").textContent = "py/gmrt_fault_detect.py 第 5 步：研究员从开发笔记本手动抄写 · MAR 29°N（GMRT max）";
  } else {
    $("#source-title").textContent = `已导入：${s.name}`;
    const parts = [];
    parts.push({ transfer: "数据传递文件", json: "JSON 参数", python: "Python 参数块" }[s.format] || "参数");
    if (meta.producer) parts.push(meta.producer);
    if (ds && ds.aoi_name) parts.push(`数据集 ${ds.aoi_name}${ds.gmrt_res ? `（GMRT ${ds.gmrt_res}）` : ""}`);
    if (meta.created) parts.push(meta.created.slice(0, 10));
    if (s.imported !== undefined) parts.push(`${s.imported}/${PARAM_ORDER.length} 个参数`);
    const dg = meta.diagnostics;
    if (dg && dg.ml && Number.isFinite(dg.ml.cv_auc)) parts.push(`交叉验证 AUC ${dg.ml.cv_auc.toFixed(3)} · 估计 FDR ${Number(dg.ml.estimated_fdr).toFixed(3)}`);
    $("#source-sub").textContent = parts.join(" · ");
  }
  $("#params-tag").textContent = (!s || s.kind === "builtin" ? "内置 · MAR 29°N" : "已导入") + (changed.length ? " · 已修改" : "");
  $("#source-mod").hidden = changed.length === 0;
  $("#source-mod-text").textContent = changed.length
    ? `已手动修改 ${changed.length} 项：${changed.slice(0, 4).join("、")}${changed.length > 4 ? " 等" : ""}` : "";
  const bb = ds && Array.isArray(ds.bbox) && ds.bbox.length === 4 && ds.bbox.every(Number.isFinite) ? ds.bbox : null;
  const differs = bb && bb.some((v, i) => Math.abs(v - state.bbox[i]) > 1e-6);
  const useBtn = $("#btn-use-bbox");
  useBtn.hidden = !differs || !s || s.kind === "builtin";
  if (!useBtn.hidden) useBtn.textContent = `使用这组参数的研究区域：${bb.join(", ")}${ds.aoi_name ? `（${ds.aoi_name}）` : ""}`;
  const v = fieldValidity();
  $("#btn-run").disabled = !v.ok || state.running;
  $("#btn-run").title = v.ok ? "" : `参数有误：${v.errors[0]}`;
}

function renderQuick() {
  if (!state.params) return;
  const p = state.params;
  const base = srcBase();
  const alt = srcAlt();
  const isMl = ALT_KEYS.every((k) => sameValue(p[k], base[k]));
  const isStats = Boolean(alt) && ALT_KEYS.every((k) => k in alt ? sameValue(p[k], alt[k]) : sameValue(p[k], base[k]));
  setSeg("seg-scheme", isMl ? "ml" : isStats ? "stats" : "");
  $('#seg-scheme button[data-v="stats"]').disabled = !alt;
  $('#seg-scheme button[data-v="stats"]').title = alt ? "" : "当前参数来源没有提供统计 FDR 备选方案";
  $("#scheme-hint").textContent = isMl
    ? `开发笔记本第 12–13 步：target-decoy 逻辑回归评分器，${p.SCORER_FEATURES.length} 个形态特征，阈值按估计 FDR 选出。`
    : isStats
      ? `开发笔记本第 10 步：统计 FDR 控制（更保守）——最短 ${fmt(alt.MIN_LENGTH_M / 1000, 2)} km、断距 ≥ ${fmt(alt.MIN_THROW_M)} m、走向偏离 ≤ ${fmt(alt.MAX_STRIKE_DEV_DEG)}°，不用评分器。`
      : "当前的接受规则与两种方案都不同（已手动修改）。";
  $("#f-threshold").hidden = p.USE_SCORER !== true;
  if (document.activeElement !== $("#in-threshold")) $("#in-threshold").value = p.SCORER_THRESHOLD;
  $("#out-threshold").textContent = Number.isFinite(p.SCORER_THRESHOLD) ? +p.SCORER_THRESHOLD.toFixed(6) + "" : "—";
  if (document.activeElement !== $("#in-minlen")) $("#in-minlen").value = p.MIN_LENGTH_M;
  $("#chk-outward").checked = p.KEEP_OUTWARD === true;
}
$("#seg-scheme").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled || !state.params) return;
  const from = b.dataset.v === "stats" ? srcAlt() : srcBase();
  if (!from) return;
  for (const k of ALT_KEYS) state.params[k] = clone(k in from ? from[k] : srcBase()[k]);
  onParamsChanged("quick");
});
$("#in-threshold").addEventListener("input", (e) => {
  if (!state.params) return;
  state.params.SCORER_THRESHOLD = Math.round(Number(e.target.value) * 1000) / 1000;
  onParamsChanged("quick");
});
$("#in-minlen").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (!state.params || !Number.isFinite(v) || v < 0) { renderQuick(); return; }
  state.params.MIN_LENGTH_M = v;
  onParamsChanged("quick");
});
$("#chk-outward").addEventListener("change", (e) => {
  if (!state.params) return;
  state.params.KEEP_OUTWARD = e.target.checked;
  onParamsChanged("quick");
});

// ---- 手动填写：逐项表单
function buildForm() {
  const root = $("#param-form");
  root.replaceChildren();
  GROUPS.forEach((g, gi) => {
    const det = el("details", { class: "pgroup", "data-group": String(gi) });
    if (gi === 0) det.open = true;
    det.append(el("summary", {}, el("span", { class: "pg-title", text: g.title }), el("span", { class: "pg-src", text: g.src }),
      el("span", { class: "pg-flag", "aria-hidden": "true" })));
    const body = el("div", { class: "pg-body" });
    if (g.scorer) {
      body.append(el("div", { class: "s-head", "aria-hidden": "true" }, el("span", { text: "均值" }), el("span", { text: "尺度" }),
        el("span", { text: "系数" })));
      body.append(el("div", { class: "slist", id: "scorer-table", role: "group", "aria-label": "评分器特征" }));
      body.append(el("div", { class: "perr", id: "scorer-err", hidden: "" }));
      body.append(el("p", { class: "hint", text: "勾选的特征按顺序组成 SCORER_FEATURES；均值、尺度用于标准化，系数是标准化后的逻辑回归系数。" }));
    } else {
      for (const k of g.keys) {
        const s = SCHEMA[k];
        const id = `p-${k}`;
        const row = el("div", { class: "prow", "data-k": k, title: s.help || "" });
        const ctrl = s.type === "bool"
          ? el("label", { class: "mini-switch" }, el("input", { id, type: "checkbox", "data-k": k }), el("span", { class: "track", "aria-hidden": "true" }))
          : el("div", { class: "pin" }, el("input", { id, type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", "data-k": k,
            placeholder: s.type === "floatOrNull" ? "自动" : "" }), el("span", { class: "pu", text: s.unit || "" }));
        row.append(el("span", { class: "dot", "aria-hidden": "true" }),
          el("label", { class: "plabel", for: id }, el("span", { class: "pl", text: s.label }), el("code", { text: k })),
          ctrl, el("div", { class: "perr", hidden: "" }));
        body.append(row);
      }
    }
    det.append(body);
    root.append(det);
  });
}
const fmtVal = (v) => (v === null || v === undefined ? "" : String(v));
function syncForm(from) {
  if (!state.params) return;
  const v = fieldValidity();
  const base = srcBase();
  const active = document.activeElement;
  for (const row of $$("#param-form .prow")) {
    const k = row.dataset.k;
    const inp = row.querySelector("input");
    if (inp.type === "checkbox") inp.checked = state.params[k] === true;
    else if (inp !== active && !(k in state.fieldText)) inp.value = fmtVal(state.params[k]);
    row.classList.toggle("changed", !sameValue(state.params[k], base[k]));
    const err = v.fields[k];
    row.classList.toggle("invalid", Boolean(err));
    const pe = row.querySelector(".perr");
    pe.hidden = !err;
    pe.textContent = err || "";
  }
  const sErr = ["SCORER_FEATURES", "SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"].map((k) => v.fields[k] && `${k}：${v.fields[k]}`).filter(Boolean);
  $("#scorer-err").hidden = !sErr.length;
  $("#scorer-err").textContent = sErr.join("；");
  if (from !== "scorer" && !(active && active.closest && active.closest("#scorer-table"))) renderScorerTable();
  GROUPS.forEach((g, gi) => {
    const det = $(`#param-form .pgroup[data-group="${gi}"]`);
    const ch = g.keys.some((k) => !sameValue(state.params[k], base[k]));
    const bad = g.keys.some((k) => v.fields[k]);
    det.classList.toggle("changed", ch);
    det.classList.toggle("invalid", bad);
  });
}
function renderScorerTable() {
  const tb = $("#scorer-table");
  if (!tb || !state.params) return;
  const p = state.params;
  const base = srcBase();
  const used = Array.isArray(p.SCORER_FEATURES) ? p.SCORER_FEATURES : [];
  const order = [...used, ...FEATURES.map(([f]) => f).filter((f) => !used.includes(f))];
  tb.replaceChildren(...order.map((f) => {
    const i = used.indexOf(f);
    const on = i >= 0;
    const vals = on ? [p.SCORER_MEAN[i], p.SCORER_SCALE[i], p.SCORER_COEF[i]] : (state.parked[f] || [0, 1, 0]);
    const bi = (base.SCORER_FEATURES || []).indexOf(f);
    const row = el("div", { class: on ? "srow" : "srow off", "data-f": f },
      el("label", { class: "s-name", title: f }, el("input", { type: "checkbox", "data-f": f, "aria-label": `使用 ${f}`, ...(on ? { checked: "" } : {}) }),
        el("span", { class: "fl", text: FEATURE_LABEL[f] }), el("code", { text: f })));
    const vals3 = el("div", { class: "s-vals" });
    ["SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"].forEach((key, col) => {
      const changed = on && (bi < 0 || !sameValue(vals[col], base[key][bi]));
      vals3.append(el("input", { type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false",
        "data-f": f, "data-col": String(col), value: fmtVal(vals[col]), class: changed ? "changed" : "",
        "aria-label": `${f} ${["均值", "尺度", "系数"][col]}`, ...(on ? {} : { disabled: "" }) }));
    });
    row.append(vals3);
    return row;
  }));
}
$("#param-form").addEventListener("input", (e) => {
  const t = e.target;
  if (!state.params || t.type === "checkbox") return;
  if (t.dataset.k) {
    const k = t.dataset.k;
    const txt = t.value.trim();
    if (SCHEMA[k].type === "floatOrNull" && (txt === "" || /^none$/i.test(txt))) {
      state.params[k] = null;
      delete state.fieldText[k];
    } else {
      const v = txt === "" ? NaN : Number(txt);
      if (Number.isFinite(v)) { state.params[k] = v; delete state.fieldText[k]; } else state.fieldText[k] = t.value;
    }
    onParamsChanged("form");
  } else if (t.dataset.col !== undefined) {
    const f = t.dataset.f;
    const col = Number(t.dataset.col);
    const key = ["SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"][col];
    const i = state.params.SCORER_FEATURES.indexOf(f);
    const v = t.value.trim() === "" ? NaN : Number(t.value);
    const fk = `${key}`;
    if (i >= 0 && Number.isFinite(v)) {
      state.params[key] = state.params[key].slice();
      state.params[key][i] = v;
      delete state.fieldText[fk];
    } else if (i >= 0) state.fieldText[fk] = t.value;
    t.classList.toggle("bad", !Number.isFinite(v));
    onParamsChanged("scorer");
  }
});
$("#param-form").addEventListener("change", (e) => {
  const t = e.target;
  if (!state.params || t.type !== "checkbox") return;
  if (t.dataset.k) {
    state.params[t.dataset.k] = t.checked;
    onParamsChanged("form");
  } else if (t.dataset.f) {
    const f = t.dataset.f;
    const p = state.params;
    const i = p.SCORER_FEATURES.indexOf(f);
    if (t.checked && i < 0) {
      const [m, s, c] = state.parked[f] || [0, 1, 0];
      p.SCORER_FEATURES = [...p.SCORER_FEATURES, f];
      p.SCORER_MEAN = [...p.SCORER_MEAN, m];
      p.SCORER_SCALE = [...p.SCORER_SCALE, s];
      p.SCORER_COEF = [...p.SCORER_COEF, c];
    } else if (!t.checked && i >= 0) {
      state.parked[f] = [p.SCORER_MEAN[i], p.SCORER_SCALE[i], p.SCORER_COEF[i]];
      for (const key of ["SCORER_FEATURES", "SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"]) p[key] = p[key].filter((_, j) => j !== i);
    }
    for (const key of ["SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"]) delete state.fieldText[key];
    onParamsChanged("form");
    renderScorerTable();
  }
});

// ---- 选项卡
function selectTab(t) {
  for (const b of $$(".tabs [role=tab]")) {
    const on = b.dataset.tab === t;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const n of ["quick", "manual", "upload"]) $(`#tab-${n}`).hidden = n !== t;
}
$(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b) selectTab(b.dataset.tab); });
$(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const tabs = $$(".tabs [role=tab]");
  const i = tabs.findIndex((b) => b.getAttribute("aria-selected") === "true");
  const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(n.dataset.tab);
  n.focus();
});

// ---- 上传文件 / 粘贴
function showImportResult(r, name) {
  const box = $("#import-result");
  box.hidden = false;
  box.dataset.kind = r.ok ? "ok" : "error";
  const kids = [el("strong", { text: r.ok ? `已导入 ${name}` : `无法导入 ${name}` })];
  if (r.ok) {
    const ds = r.meta && r.meta.dataset;
    const lines = [`格式：${{ transfer: "数据传递文件（开发笔记本第 16 步）", json: "JSON 参数", python: "Python 参数块" }[r.kind]}`,
      `参数：${r.imported}/${PARAM_ORDER.length} 个${r.alt ? "，含统计 FDR 备选方案" : ""}`];
    if (ds && ds.aoi_name) lines.push(`数据集：${ds.aoi_name} · ${Array.isArray(ds.bbox) ? ds.bbox.join(", ") : ""}${ds.gmrt_res ? ` · GMRT ${ds.gmrt_res}` : ""}${ds.epsg ? ` · EPSG:${ds.epsg}` : ""}`);
    if (r.meta && r.meta.created) lines.push(`导出时间：${r.meta.created}`);
    kids.push(el("ul", {}, ...lines.map((t) => el("li", { text: t }))));
  } else {
    kids.push(el("ul", {}, ...(r.errors || []).slice(0, 8).map((t) => el("li", { text: t }))));
  }
  if (r.warnings && r.warnings.length) kids.push(el("ul", { class: "warn" }, ...r.warnings.map((t) => el("li", { text: t }))));
  box.replaceChildren(...kids);
}
function applyImport(r, name) {
  showImportResult(r, name);
  if (!r.ok) return false;
  state.params = r.params;
  state.source = { kind: "file", name, format: r.kind, meta: r.meta, base: clone(r.params), alt: r.alt, imported: r.imported };
  state.fieldText = {};
  state.parked = {};
  onParamsChanged("import");
  renderScorerTable();
  toast(`已导入 ${name}：${r.imported} 个参数`);
  return true;
}
async function importFile(file) {
  if (!builtin.params) { toast("内置参数还没有读取完，请稍候"); return; }
  if (file.size > 2e6) { showImportResult({ ok: false, errors: ["文件太大（超过 2 MB），不像数据传递文件"] }, file.name); return; }
  applyImport(parseImport(await file.text(), builtin.params, file.name), file.name);
}
const dz = $("#dropzone");
$("#file-input").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file-input").click(); } });
for (const ev of ["dragenter", "dragover"]) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); });
dz.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) importFile(f); });
$("#btn-paste").addEventListener("click", () => {
  if (!builtin.params) return;
  if (applyImport(parseImport($("#ta-paste").value, builtin.params, "粘贴的文本"), "粘贴的文本")) $("#ta-paste").value = "";
});

// ---- 来源卡片上的操作：导出、恢复、撤销、使用文件中的区域
function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
$("#btn-export").addEventListener("click", () => {
  if (!state.params) return;
  const s = state.source;
  const ds = !s || s.kind === "builtin" ? BUILTIN_DATASET : (s.meta && s.meta.dataset) || null;
  const changed = changedKeys(state.params, srcBase());
  const obj = buildTransfer(state.params, { alt: srcAlt(), dataset: ds, producer: `GMRT 断层识别网页版 v${APP_VERSION}`,
    basedOn: !s || s.kind === "builtin" ? "实现文件第 5 步（内置参数）" : s.name, appliedTo: { bbox: state.bbox, gmrt_res: state.res } });
  if (changed.length) obj.modified = changed;
  const stem = (ds && ds.aoi_name) || "web";
  downloadText(JSON.stringify(obj, null, 1), `gmrt_fault_params_${stem}${changed.length ? "_modified" : ""}.json`, "application/json");
});
$("#btn-builtin").addEventListener("click", () => {
  if (!builtin.params) return;
  state.params = clone(builtin.params);
  state.source = { kind: "builtin" };
  state.fieldText = {};
  state.parked = {};
  onParamsChanged("reset");
  renderScorerTable();
  toast("已恢复实现文件内置参数");
});
$("#btn-undo-mod").addEventListener("click", () => {
  state.params = clone(srcBase());
  state.fieldText = {};
  state.parked = {};
  onParamsChanged("reset");
  renderScorerTable();
});
$("#btn-use-bbox").addEventListener("click", () => {
  const ds = state.source && state.source.meta && state.source.meta.dataset;
  if (!ds || !Array.isArray(ds.bbox)) return;
  if (["max", "high", "med"].includes(ds.gmrt_res)) state.res = ds.gmrt_res;
  renderRes();
  setBbox(ds.bbox, { fit: true });
  renderSource();
});

function renderRes() { setSeg("seg-res", state.res); }
$("#seg-res").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.res = b.dataset.v;
  renderRes();
  persist();
  scheduleEstimate();
});

// ------------------------------------------------------------------ Python 引擎（Web Worker + Pyodide）
let worker = null;
let engine = { state: "idle", versions: null };
function setEngine(st, text, meta) {
  engine.state = st;
  const btn = $("#engine");
  btn.dataset.state = st;
  $("#engine-text").textContent = text;
  if (meta !== undefined) $("#engine-meta").textContent = meta;
}
function engineIdleText() {
  const cached = store.get("gfd.engineCached", false);
  setEngine("idle", cached ? "Python 引擎未启动 · 点击启动" : "Python 引擎未加载 · 点击预加载",
    cached ? "已缓存" : "首次约 28 MB");
}
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    e.preventDefault?.();
    const msg = e.message || "计算线程无法启动（浏览器可能不支持模块化 Web Worker）";
    setEngine("error", "引擎加载失败 · 点击重试");
    if (state.running) failRun({ message: msg, detail: msg });
    worker = null;
  };
  setEngine("loading", "正在加载 Python 引擎…");
  worker.postMessage({ type: "init" });
  return worker;
}
$("#engine").addEventListener("click", () => { if (engine.state === "idle" || engine.state === "error") ensureWorker(); });

function onWorkerMessage(ev) {
  const m = ev.data || {};
  if (m.type === "engine") {
    let text = "";
    if (m.phase === "download") {
      text = m.total ? `下载 Python 运行时与科学计算包 ${fmtMB(m.loaded)} / ${fmtMB(Math.max(m.total, m.loaded))}` : "下载 Python 运行时…";
      if (state.running) stepProgress(0, text, m.total ? Math.min(0.99, m.loaded / m.total) : null, m.total ? fmtMB(m.loaded) : "");
    } else {
      text = { boot: "启动 Python 解释器…", packages: "加载 numpy · scipy · pyproj…", tifffile: "安装 tifffile…" }[m.phase] || "加载中…";
      if (state.running) stepProgress(0, text, null);
    }
    setEngine("loading", text);
  } else if (m.type === "ready") {
    engine.versions = m.versions;
    store.set("gfd.engineCached", true);
    setEngine("ready", `Python 引擎就绪 · Python ${m.versions.python}`, `Pyodide ${m.versions.pyodide}`);
    $("#engine").title = Object.entries(m.versions).map(([k, v]) => `${k} ${v}`).join("\n");
    if (state.running) stepDone(0, `${m.seconds.toFixed(1)} s`);
    log(`[引擎] Pyodide ${m.versions.pyodide} · Python ${m.versions.python} · numpy ${m.versions.numpy} · scipy ${m.versions.scipy} · tifffile ${m.versions.tifffile} · pyproj ${m.versions.pyproj}（${m.seconds.toFixed(1)} s）`, "s");
  } else if (m.type === "mode") {
    run.quick = m.quick;
    $("#run-mode").textContent = m.quick ? "快速重算：复用第 1–13 步" : "";
    if (m.quick) for (const s of STEPS) if (s.num >= 1 && s.num <= 13) stepSkip(s.num, "复用");
  } else if (m.type === "step") {
    stepActivate(m.num);
  } else if (m.type === "download") {
    const t = m.phase === "request" ? "等待 GMRT 生成网格…"
      : `${m.fromCache ? "本地缓存" : "下载"} ${fmtMB(m.loaded)}${m.total && m.phase !== "done" ? ` / ${fmtMB(m.total)}` : ""}`;
    stepProgress(1, `下载 GMRT 网格 · ${t}`, m.total ? m.loaded / m.total : null, m.phase === "request" ? "" : fmtMB(m.loaded));
    if (m.phase === "done") log(`[下载] GMRT topo-mask ${fmtMB(m.loaded)}${m.fromCache ? "（来自本地缓存）" : ""}`, "s");
  } else if (m.type === "log") {
    log(m.line, m.level === "warn" ? "w" : "");
  } else if (m.type === "result") {
    finishRun(m);
  } else if (m.type === "error") {
    if (m.during === "init" && !state.running) {
      setEngine("error", `引擎加载失败：${m.message}`.slice(0, 80) + " · 点击重试");
      worker?.terminate();
      worker = null;
      return;
    }
    if (m.during === "init") { worker?.terminate(); worker = null; setEngine("error", "引擎加载失败 · 点击重试"); }
    failRun(m);
  }
}

// ------------------------------------------------------------------ 运行与进度
const run = { t0: 0, timer: null, active: null, stepT0: 0, quick: false };
function log(line, cls = "") {
  const pre = $("#log");
  const span = el("span", { class: cls, text: line + "\n" });
  pre.append(span);
  $("#log-count").textContent = String(pre.childElementCount);
  if (pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60) pre.scrollTop = pre.scrollHeight;
}
function stepLi(num) { return $(`#steps li[data-num="${num}"]`); }
function resetSteps() {
  const ol = $("#steps");
  ol.replaceChildren(...STEPS.map((s) => el("li", { "data-num": String(s.num) },
    el("span", { class: "st" }), el("span", { class: "nm", text: s.title }), el("span", { class: "t" }))));
  ol.hidden = false;
  run.active = null;
}
function setProgress(frac, text) {
  const bar = $("#pbar");
  bar.classList.toggle("indeterminate", frac === null);
  if (frac !== null) {
    bar.querySelector("i").style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
  }
  if (text) {
    $("#ptext").textContent = text;
    $("#map-status-text").textContent = text;
  }
}
function overall(num, inner = 0) {
  if (num === 0) return 0.10 * inner;
  if (num === 1) return 0.10 + 0.15 * inner;
  let acc = 0;
  for (const s of STEPS) {
    if (s.num < 2) continue;
    if (s.num === num) return 0.25 + 0.75 * ((acc + s.w * inner) / STEP_W_TOTAL);
    acc += s.w;
  }
  return 1;
}
function closeActive(mark = "done", note) {
  if (run.active === null) return;
  const li = stepLi(run.active);
  if (li && li.classList.contains("active")) {
    li.classList.remove("active");
    li.classList.add(mark);
    if (mark === "done") li.querySelector(".st").innerHTML = '<svg><use href="#i-check"/></svg>';
    if (mark === "failed") li.querySelector(".st").innerHTML = '<svg><use href="#i-x"/></svg>';
    li.querySelector(".t").textContent = note ?? `${((performance.now() - run.stepT0) / 1000).toFixed(1)} s`;
  }
  run.active = null;
}
function stepActivate(num) {
  if (run.active === num) return;
  closeActive();
  const li = stepLi(num);
  if (!li) return;
  li.classList.remove("skipped", "done");
  li.classList.add("active");
  li.querySelector(".t").textContent = "";
  run.active = num;
  run.stepT0 = performance.now();
  const idx = STEPS.filter((s) => s.num >= 1).findIndex((s) => s.num === num) + 1;
  const name = STEPS.find((s) => s.num === num)?.title || "";
  setProgress(overall(num, 0), num === 0 ? name : `第 ${idx}/${STEPS.length - 1} 步 · ${name}`);
  li.scrollIntoView({ block: "nearest" });
}
function stepProgress(num, text, frac, short = "") {
  if (run.active !== num) stepActivate(num);
  const li = stepLi(num);
  if (li) li.querySelector(".t").textContent = short;
  setProgress(frac === null ? null : overall(num, frac), text);
}
function stepDone(num, note) {
  if (run.active !== num) stepActivate(num);
  closeActive("done", note);
}
function stepSkip(num, note) {
  const li = stepLi(num);
  if (!li) return;
  li.classList.remove("active");
  li.classList.add("skipped");
  li.querySelector(".t").textContent = note;
}
function setRunning(on) {
  state.running = on;
  $("#btn-run").hidden = on;
  $("#btn-cancel").hidden = !on;
  $("#progress").hidden = false;
  $("#map-status").hidden = !on;
  for (const id of ["btn-draw", "btn-view"]) $(`#${id}`).disabled = on;
  for (const k of Object.keys(inputs)) inputs[k].disabled = on;
  for (const m of [...corners, mover]) { if (on) m.dragging?.disable(); else m.dragging?.enable(); }
  clearInterval(run.timer);
  if (on) {
    run.t0 = performance.now();
    run.timer = setInterval(() => { $("#ptime").textContent = `${((performance.now() - run.t0) / 1000).toFixed(0)} s`; }, 500);
  }
}
function startRun() {
  if (state.running) return;
  if (drawing) setDrawing(false);
  const bbox = readInputs();
  if (!bbox) { toast("四边经纬度有误：请检查西 < 东、南 < 北，且在有效范围内。"); return; }
  setBbox(bbox);
  if (state.estimate && state.estimate.message && !state.estimate.ok) { toast(state.estimate.message, 5000); return; }
  if (!state.params) { toast(builtin.error ? `参数读取失败：${builtin.error}` : "参数还在读取，请稍候"); return; }
  const pv = fieldValidity();
  if (!pv.ok) { selectTab("manual"); syncForm(""); toast(`参数有误：${pv.errors[0]}`, 5000); return; }
  $("#run-error").hidden = true;
  $("#run-mode").textContent = "";
  run.quick = false;
  resetSteps();
  setRunning(true);
  setProgress(0, "准备中…");
  const nChanged = changedKeys(state.params, srcBase()).length;
  log(`—— ${new Date().toLocaleTimeString("zh-CN")} 开始：${state.bbox.join(", ")} · ${state.res} · 参数：${sourceLabel()}${nChanged ? `（手动修改 ${nChanged} 项）` : ""}`, "s");
  if (engine.state === "ready") { stepActivate(0); stepDone(0, "已就绪"); } else stepActivate(0);
  const isPreset = $("#preset").value !== "custom";
  const cfg = { bbox: state.bbox, res: state.res, aoiName: isPreset ? $("#preset").value : "aoi", params: clone(state.params),
    maxCells: MAX_CELLS };
  ensureWorker().postMessage({ type: "run", cfg });
}
function cancelRun() {
  if (!state.running) return;
  worker?.terminate();
  worker = null;
  closeActive("failed", "已取消");
  setRunning(false);
  setProgress(0, "已取消");
  $("#pbar").classList.remove("indeterminate");
  log("—— 已取消（计算线程已终止，下次运行会重新启动引擎，文件来自缓存）", "w");
  engineIdleText();
}
function failRun(m) {
  closeActive("failed", "出错");
  setRunning(false);
  $("#pbar").classList.remove("indeterminate");
  setProgress(0, "运行失败");
  $("#run-error").hidden = false;
  $("#run-error-title").textContent = m.during === "init" ? "Python 引擎加载失败" : "运行出错";
  $("#run-error-text").textContent = m.message || "未知错误";
  $("#run-error-detail").textContent = m.detail || "";
  log(`[错误] ${m.message}`, "w");
}
$("#btn-run").addEventListener("click", startRun);
$("#btn-cancel").addEventListener("click", cancelRun);

// ------------------------------------------------------------------ 结果
const layers = { faults: null, casing: null, axis: null, axisCasing: null, preview: null, previewUrl: null, byId: new Map() };
const downloads = {};
let selectedId = null;
let throwDomain = [0, 400];

function heatColor(v) {
  const t = Math.max(0, Math.min(1, (v - throwDomain[0]) / Math.max(1e-9, throwDomain[1] - throwDomain[0])));
  const x = t * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEAT[i].match(/\w\w/g).map((h) => parseInt(h, 16));
  const b = HEAT[i + 1].match(/\w\w/g).map((h) => parseInt(h, 16));
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(",")})`;
}
function faultColor(p) {
  if (state.colorMode === "throw") return heatColor(p.throw_median_m ?? 0);
  return COLORS[p.polarity] || COLORS.unknown;
}
function lineWeight() { const z = map.getZoom(); return z >= 12 ? 3.2 : z >= 10 ? 2.4 : 1.8; }
function styleFaults() {
  if (!layers.faults) return;
  const w = lineWeight();
  layers.casing.setStyle({ weight: w + 2.6 });
  layers.faults.eachLayer((ly) => {
    const sel = ly.feature.properties.id === selectedId;
    ly.setStyle({ color: faultColor(ly.feature.properties), weight: sel ? w + 2 : w, opacity: 1 });
  });
}
map.on("zoomend", styleFaults);
const POL_TEXT = { inward: "内倾", outward: "外倾", unknown: "未定" };
function popupFor(p) {
  const rows = [
    ["极性", POL_TEXT[p.polarity] || p.polarity], ["长度", `${fmt(p.length_km, 2)} km`], ["走向", `${fmt(p.strike_deg, 1)}°`],
    ["陡坎朝向", `${fmt(p.facing_az, 0)}°（${p.facing_side === "E" ? "朝东" : "朝西"}）`],
    ["断距中位数", `${fmt(p.throw_median_m, 0)} m`], ["断距 P90", `${fmt(p.throw_p90_m, 0)} m`],
    ["陡坎宽度", `${fmt(p.scarp_width_median_m, 0)} m`], ["陡坎坡度", `${fmt(p.scarp_slope_median_deg, 1)}°`],
    ["离中轴", p.dist_axis_km === null || p.dist_axis_km === undefined ? "—" : `${fmt(p.dist_axis_km, 2)} km（${p.flank} 翼）`],
    ["平直度", fmt(p.straightness, 3)], ["连接段数", fmt(p.n_segments)],
  ];
  if (p.score !== null && p.score !== undefined) rows.push(["评分 P(断层)", fmt(p.score, 3)]);
  const box = el("div", { class: "fpop" },
    el("h4", {}, el("i", { style: `background:${faultColor(p)}` }), document.createTextNode(`断层 #${p.id}`)),
    el("table", {}, ...rows.map(([k, v]) => el("tr", {}, el("td", { text: k }), el("td", { text: v })))));
  return box;
}
function selectFault(id, { zoom = false, popup = false } = {}) {
  selectedId = id;
  styleFaults();
  const ly = layers.byId.get(id);
  for (const tr of $$("#ftable tbody tr")) tr.classList.toggle("sel", Number(tr.dataset.id) === id);
  if (!ly) return;
  ly.bringToFront();
  if (zoom) map.fitBounds(ly.getBounds(), { maxZoom: 12.5, padding: [60, 60] });
  if (popup) ly.openPopup(ly.getBounds().getCenter());
}
function renderLegend() {
  const lg = $("#legend");
  if (!state.result) { lg.hidden = true; return; }
  const kids = [el("h4", { text: state.colorMode === "throw" ? "断层 · 断距中位数" : "断层 · 极性" })];
  if (state.colorMode === "throw") {
    kids.push(el("div", { class: "ramp", style: `background:linear-gradient(90deg,${HEAT.join(",")})` }));
    kids.push(el("div", { class: "ramp-labels" }, el("span", { text: `${fmt(throwDomain[0])} m` }),
      el("span", { text: `${fmt((throwDomain[0] + throwDomain[1]) / 2)}` }), el("span", { text: `≥ ${fmt(throwDomain[1])} m` })));
  } else {
    const s = state.result.summary;
    const shown = state.result.faults.features.reduce((a, f) => { a[f.properties.polarity] = (a[f.properties.polarity] || 0) + 1; return a; }, {});
    for (const k of ["inward", "outward", "unknown"]) {
      if (!shown[k] && !(k === "outward" && s.axis.ok)) continue;
      const note = shown[k] ? `${fmt(shown[k])} 条` : (k === "outward" ? `${fmt(s.n_outward_all)} 条，未保留` : "");
      kids.push(el("div", { class: "row" }, el("span", { class: "ln", style: `border-color:${COLORS[k]}` }),
        el("span", { text: `${POL_TEXT[k]}陡坎` }), el("span", { class: "muted", text: note })));
    }
  }
  if (state.result.axis.features.length) {
    kids.push(el("div", { class: "row" }, el("span", { class: "ln dash", style: `border-color:${COLORS.axis}` }),
      el("span", { text: "扩张中轴" })));
  }
  if (layers.preview && map.hasLayer(layers.preview)) {
    const pv = state.result.summary.preview;
    kids.push(el("div", { class: "sep" }), el("h4", { text: "分析网格水深" }),
      el("div", { class: "ramp", style: `background:linear-gradient(90deg,${pv.stops.map(([t, c]) => `rgb(${c.join(",")}) ${t * 100}%`).join(",")})` }),
      el("div", { class: "ramp-labels" }, el("span", { text: `${fmt(pv.depth_lo_m)} m` }), el("span", { text: `${fmt(pv.depth_hi_m)} m` })));
  }
  const head = el("button", { class: "lg-head", type: "button", "aria-expanded": String(!state.legendCollapsed) },
    el("span", { text: "图例" }), el("span", { class: "lg-chev", "aria-hidden": "true", text: state.legendCollapsed ? "▸" : "▾" }));
  head.addEventListener("click", () => { state.legendCollapsed = !state.legendCollapsed; renderLegend(); });
  lg.replaceChildren(head, el("div", { class: "lg-body" }, ...kids));
  lg.classList.toggle("collapsed", state.legendCollapsed);
  lg.hidden = false;
}
function setColorMode(mode) {
  state.colorMode = mode;
  setSeg("seg-color", mode);
  styleFaults();
  renderLegend();
  renderTable();
}
$("#seg-color").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setColorMode(b.dataset.v); });

function toggleLayer(id, on) {
  const ls = { "ly-faults": [layers.casing, layers.faults], "ly-axis": [layers.axisCasing, layers.axis], "ly-aoi": [aoiRect, ...corners, mover],
    "ly-preview": [layers.preview] }[id];
  for (const l of ls || []) { if (!l) continue; if (on) l.addTo(map); else map.removeLayer(l); }
  renderLegend();
}
for (const id of ["ly-faults", "ly-axis", "ly-aoi", "ly-preview"]) $(`#${id}`).addEventListener("change", (e) => toggleLayer(id, e.target.checked));
$("#in-opacity").addEventListener("input", (e) => { layers.preview?.setOpacity(Number(e.target.value)); });

function setDownload(id, name, data, type) {
  if (downloads[id]) URL.revokeObjectURL(downloads[id]);
  downloads[id] = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = $(`#${id}`);
  a.href = downloads[id];
  a.download = name;
}

function finishRun(m) {
  closeActive();
  setRunning(false);
  setProgress(1, `完成 · 用时 ${m.seconds.toFixed(1)} s${m.quick ? "（快速重算）" : ""}`);
  const faults = JSON.parse(m.faults);
  const axis = JSON.parse(m.axis);
  const summary = JSON.parse(m.summary);
  state.result = { faults, axis, summary };
  const s = summary;
  log(`—— 完成：${s.n_candidates} 条候选 → 接受 ${s.n_accepted} 条 → 保留 ${s.n_faults} 条断层，总长 ${fmt(s.total_length_km, 0)} km（${m.seconds.toFixed(1)} s）`, "s");

  // 图层
  for (const k of ["faults", "casing", "axis", "axisCasing"]) if (layers[k]) map.removeLayer(layers[k]);
  layers.byId.clear();
  selectedId = null;
  const thr = faults.features.map((f) => f.properties.throw_median_m).filter(Number.isFinite).sort((a, b) => a - b);
  throwDomain = [0, thr.length ? Math.max(50, Math.round(thr[Math.floor(0.95 * (thr.length - 1))] / 10) * 10) : 400];
  layers.casing = L.geoJSON(faults, { pane: "faults", renderer: faultRenderer, interactive: false,
    style: { color: COLORS.casing, opacity: 0.78, weight: lineWeight() + 2.6, lineCap: "round", lineJoin: "round" } });
  layers.faults = L.geoJSON(faults, {
    pane: "faults", renderer: faultRenderer,
    style: (f) => ({ color: faultColor(f.properties), weight: lineWeight(), opacity: 1, lineCap: "round", lineJoin: "round" }),
    onEachFeature: (f, ly) => {
      const p = f.properties;
      layers.byId.set(p.id, ly);
      ly.bindTooltip(`#${p.id} · ${POL_TEXT[p.polarity] || ""} · ${fmt(p.length_km, 1)} km · 断距 ${fmt(p.throw_median_m, 0)} m`,
        { sticky: true, className: "ftip", direction: "top", offset: [0, -6] });
      ly.bindPopup(() => popupFor(p), { maxWidth: 320 });
      ly.on("click", () => selectFault(p.id));
      ly.on("mouseover", () => ly.setStyle({ weight: lineWeight() + 2 }));
      ly.on("mouseout", () => ly.setStyle({ weight: p.id === selectedId ? lineWeight() + 2 : lineWeight() }));
    },
  });
  layers.axisCasing = L.geoJSON(axis, { pane: "axis", renderer: axisRenderer, interactive: false,
    style: { color: COLORS.casing, weight: 5, opacity: 0.7 } });
  layers.axis = L.geoJSON(axis, { pane: "axis", renderer: axisRenderer, interactive: false,
    style: { color: COLORS.axis, weight: 2.2, dashArray: "10 7", opacity: 0.95 } });
  if (m.preview) {
    if (layers.preview) map.removeLayer(layers.preview);
    if (layers.previewUrl) URL.revokeObjectURL(layers.previewUrl);
    const blob = new Blob([m.preview], { type: "image/png" });
    layers.previewUrl = URL.createObjectURL(blob);
    const pv = s.preview;
    layers.preview = L.imageOverlay(layers.previewUrl, [[pv.south, pv.west], [pv.north, pv.east]],
      { pane: "preview", opacity: Number($("#in-opacity").value), interactive: false });
    downloads.previewBlob = blob;
    setDownload("dl-preview", `gmrt_preview_${s.aoi_name}.png`, blob);
  }
  for (const id of ["ly-faults", "ly-axis", "ly-preview"]) toggleLayer(id, $(`#${id}`).checked);
  if (!m.quick && layers.preview) map.fitBounds(layers.preview.getBounds(), { padding: [30, 30] });

  // 下载
  const tag = `${s.aoi_name}_${s.gmrt_res}`;
  setDownload("dl-geojson", `gmrt_faults_${tag}.geojson`, m.faults, "application/geo+json");
  setDownload("dl-csv", `gmrt_faults_${tag}.csv`, m.csv, "text/csv");
  setDownload("dl-axis", `gmrt_axis_${tag}.geojson`, m.axis, "application/geo+json");
  setDownload("dl-summary", `gmrt_summary_${tag}.json`, m.summary, "application/json");

  renderKpis();
  renderCharts();
  renderTable();
  renderLegend();
  $("#res-meta").textContent = `${s.grid[0]} × ${s.grid[1]} @ ${s.pixel_m} m · EPSG:${s.epsg}`;
  $("#sec-results").hidden = false;
  if (m.quick) toast(`快速重算完成（${m.seconds.toFixed(1)} s）：复用了第 1–13 步，${fmt(s.n_faults)} 条断层`);
  if (window.matchMedia("(max-width: 860px)").matches) $("#sec-results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderKpis() {
  const s = state.result.summary;
  const e45 = (s.strain || []).find((r) => r.dip_deg === 45);
  const k = $("#kpis");
  const polSub = s.axis.ok
    ? [el("span", {}, el("i", { style: `background:${COLORS.inward}` }), document.createTextNode(`内倾 ${fmt(s.n_inward_all)}`)),
      el("span", {}, el("i", { style: `background:${COLORS.outward}` }),
        document.createTextNode(`外倾 ${fmt(s.n_outward_all)}${s.params.KEEP_OUTWARD ? "" : "（未保留）"}`))]
    : [el("span", { text: "未能确定中轴，极性未判断" })];
  k.replaceChildren(
    el("div", { class: "kpi hero" },
      el("div", {}, el("div", { class: "k-label", text: "识别出的断层" }),
        el("div", { class: "k-value" }, document.createTextNode(fmt(s.n_faults)), el("small", { text: "条" })),
        el("div", { class: "k-sub" }, ...polSub)),
      el("div", { style: "text-align:right" }, el("div", { class: "k-label", text: "总长度" }),
        el("div", { class: "k-value" }, document.createTextNode(fmt(s.total_length_km, 0)), el("small", { text: "km" })))),
    el("div", { class: "kpi" }, el("div", { class: "k-label", text: "区域走向" }),
      el("div", { class: "k-value" }, document.createTextNode(fmt(s.strike_deg, 1)), el("small", { text: "°" })),
      el("div", { class: "k-sub", text: "结构张量估计" })),
    el("div", { class: "kpi" }, el("div", { class: "k-label", text: "扩张中轴方位" }),
      el("div", { class: "k-value" }, document.createTextNode(s.axis.ok ? fmt(s.axis.azimuth_deg, 1) : "—"), el("small", { text: s.axis.ok ? "°" : "" })),
      el("div", { class: "k-sub", text: s.axis.ok ? `${s.axis.n_picks} 个谷底点 · Theil–Sen` : "谷底点不足" })),
    el("div", { class: "kpi" }, el("div", { class: "k-label", text: "候选 → 接受" }),
      el("div", { class: "k-value", text: `${fmt(s.n_candidates)} → ${fmt(s.n_accepted)}` }),
      el("div", { class: "k-sub", text: s.params.USE_SCORER ? `评分阈值 ${fmt(s.params.SCORER_THRESHOLD, 3)}` : "统计规则（无评分器）" })),
    el("div", { class: "kpi" }, el("div", { class: "k-label", text: "构造应变（倾角 45°）" }),
      el("div", { class: "k-value", text: e45 ? `${pct(e45.E)} · ${pct(e45.W)}` : "—" }),
      el("div", { class: "k-sub", text: e45 ? `东翼 · 西翼 · ${e45.n_profiles_E}/${e45.n_profiles_W} 条剖面` : "无中轴，未计算" })),
  );
}

// ---- 图表：单系列直方图与走向玫瑰图（SVG，悬停显示数值；数值同样可在断层列表中查到）
function chartTip(fig) {
  let tip = fig.querySelector(".chart-tip");
  if (!tip) { tip = el("div", { class: "chart-tip" }); tip.hidden = true; fig.append(tip); }
  return tip;
}
function showTip(fig, x, y, strong, sub) {
  const tip = chartTip(fig);
  tip.replaceChildren(el("strong", { text: strong }), el("span", { text: sub }));
  tip.style.left = `${x}px`;
  tip.style.top = `${y - 6}px`;
  tip.hidden = false;
}
function niceStep(max, n = 4) {
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) || mag * 10;
}
function histogram(fig, values, edges, { unit, labelEvery = 1, fmtEdge = (v) => fmt(v) }) {
  const W = 360;
  const H = 150;
  const m = { l: 34, r: 8, t: 10, b: 24 };
  const counts = new Array(edges.length - 1).fill(0);
  for (const v of values) {
    let i = edges.findIndex((e, k) => k < edges.length - 1 && v >= e && v < edges[k + 1]);
    if (i < 0 && v >= edges[edges.length - 1]) i = counts.length - 1;
    if (i >= 0) counts[i] += 1;
  }
  const maxC = Math.max(1, ...counts);
  const step = niceStep(maxC);
  const yMax = Math.ceil(maxC / step) * step;
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const bw = pw / counts.length;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${fig.querySelector("figcaption").firstChild.textContent}` });
  for (let v = 0; v <= yMax; v += step) {
    const y = m.t + ph - (v / yMax) * ph;
    svg.append(svgEl("line", { class: v === 0 ? "baseline" : "gridline", x1: m.l, x2: W - m.r, y1: y, y2: y }));
    const t = svgEl("text", { class: "tick", x: m.l - 6, y: y + 3.5, "text-anchor": "end" });
    t.textContent = fmt(v);
    svg.append(t);
  }
  counts.forEach((c, i) => {
    const x0 = m.l + i * bw + 1;
    const w = Math.min(24, Math.max(1, bw - 2));
    const x = x0 + (bw - 2 - w) / 2;
    const h = (c / yMax) * ph;
    const y = m.t + ph - h;
    const r = Math.min(4, w / 2, h);
    const hit = svgEl("rect", { class: "bar-hit", x: m.l + i * bw, y: m.t, width: bw, height: ph });
    const bar = svgEl("path", { class: "bar", d: h <= 0 ? "" : `M${x},${m.t + ph}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${m.t + ph}Z` });
    hit.addEventListener("pointermove", () => {
      bar.classList.add("hover");
      const fr = fig.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      const sx = sr.width / W;
      showTip(fig, sr.left - fr.left + (x + w / 2) * sx, sr.top - fr.top + y * sx, `${fmt(c)} 条`,
        `${fmtEdge(edges[i])}–${fmtEdge(edges[i + 1])} ${unit}`);
    });
    hit.addEventListener("pointerleave", () => { bar.classList.remove("hover"); chartTip(fig).hidden = true; });
    svg.append(hit, bar);
  });
  edges.forEach((e, i) => {
    if (i % labelEvery !== 0 && i !== edges.length - 1) return;
    if (i !== edges.length - 1 && edges.length - 1 - i < labelEvery && (edges.length - 1) % labelEvery !== 0) return;
    const t = svgEl("text", { class: "tick", x: m.l + i * bw, y: H - 8, "text-anchor": "middle" });
    t.textContent = fmtEdge(e);
    svg.append(t);
  });
  fig.querySelector("svg")?.remove();
  fig.append(svg);
}
function rose(fig, strikes, refDeg) {
  const W = 360;
  const H = 210;
  const cx = W / 2;
  const cy = H / 2 + 2;
  const R = 92;
  const bins = new Array(18).fill(0);
  for (const s of strikes) bins[Math.floor((((s % 180) + 180) % 180) / 10) % 18] += 1;
  const maxC = Math.max(1, ...bins);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "走向玫瑰图" });
  for (const f of [0.25, 0.5, 0.75, 1]) svg.append(svgEl("circle", { class: "ring", cx, cy, r: R * f }));
  svg.append(svgEl("line", { class: "gridline", x1: cx - R, x2: cx + R, y1: cy, y2: cy }));
  svg.append(svgEl("line", { class: "gridline", x1: cx, x2: cx, y1: cy - R, y2: cy + R }));
  for (const [lab, x, y] of [["N", cx, cy - R - 6], ["S", cx, cy + R + 14], ["E", cx + R + 10, cy + 4], ["W", cx - R - 10, cy + 4]]) {
    const t = svgEl("text", { class: "tick", x, y, "text-anchor": "middle" });
    t.textContent = lab;
    svg.append(t);
  }
  const ml = svgEl("text", { class: "tick", x: cx + R * 0.72 + 6, y: cy - R * 0.72 - 4 });
  ml.textContent = `${fmt(maxC)} 条`;
  svg.append(ml);
  const pt = (az, r) => [cx + r * Math.sin((az * Math.PI) / 180), cy - r * Math.cos((az * Math.PI) / 180)];
  bins.forEach((c, i) => {
    if (!c) return;
    for (const off of [0, 180]) {
      const a0 = i * 10 + off;
      const a1 = a0 + 10;
      const r = R * (c / maxC);
      const [x0, y0] = pt(a0, r);
      const [x1, y1] = pt(a1, r);
      const wedge = svgEl("path", { class: "wedge", d: `M${cx},${cy}L${x0},${y0}A${r},${r} 0 0 1 ${x1},${y1}Z` });
      wedge.addEventListener("pointermove", (ev) => {
        const rect = fig.getBoundingClientRect();
        showTip(fig, ev.clientX - rect.left, ev.clientY - rect.top, `${fmt(c)} 条`, `走向 ${i * 10}°–${i * 10 + 10}°`);
      });
      wedge.addEventListener("pointerleave", () => { chartTip(fig).hidden = true; });
      svg.append(wedge);
    }
  });
  if (Number.isFinite(refDeg)) {
    const [ax, ay] = pt(refDeg, R + 4);
    const [bx, by] = pt(refDeg + 180, R + 4);
    svg.append(svgEl("line", { class: "ref-line", x1: ax, y1: ay, x2: bx, y2: by }));
  }
  fig.querySelector("svg")?.remove();
  fig.append(svg);
}
function renderCharts() {
  const feats = state.result.faults.features.map((f) => f.properties);
  const s = state.result.summary;
  const thr = feats.map((p) => p.throw_median_m).filter(Number.isFinite);
  const top = Math.max(200, Math.ceil(Math.max(0, ...thr) / 50) * 50);
  const stepT = top > 600 ? 50 : 25;
  const edgesT = [];
  for (let v = 0; v <= Math.min(top, 800); v += stepT) edgesT.push(v);
  histogram($("#chart-throw"), thr.map((v) => Math.min(v, edgesT[edgesT.length - 1] - 1e-9)), edgesT,
    { unit: "m", labelEvery: Math.ceil(edgesT.length / 7) });
  const len = feats.map((p) => p.length_km).filter(Number.isFinite);
  const edgesL = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50].filter((v, i, a) => i === 0 || a[i - 1] < Math.max(1, ...len));
  if (edgesL.length < 3) edgesL.push(edgesL[edgesL.length - 1] * 2);
  histogram($("#chart-length"), len.map((v) => Math.max(v, edgesL[0])), edgesL,
    { unit: "km", labelEvery: 1, fmtEdge: (v) => (v < 1 ? v.toFixed(1) : fmt(v, v % 1 ? 1 : 0)) });
  $("#chart-length figcaption").replaceChildren(document.createTextNode("长度分布"), el("span", { text: "km · 非等宽分箱" }));
  rose($("#chart-rose"), feats.map((p) => p.strike_deg).filter(Number.isFinite), s.strike_deg);
  $("#chart-rose figcaption").replaceChildren(document.createTextNode("走向玫瑰图"), el("span", { text: `虚线：区域走向 ${fmt(s.strike_deg, 1)}°` }));
  $("#chart-throw figcaption").replaceChildren(document.createTextNode("断距（中位数）分布"), el("span", { text: `m · ${fmt(thr.length)} 条` }));
}

const tableSort = { k: "length_km", asc: false };
function renderTable() {
  if (!state.result) return;
  const rows = state.result.faults.features.map((f) => f.properties);
  const { k, asc } = tableSort;
  rows.sort((a, b) => {
    const va = a[k] ?? -Infinity;
    const vb = b[k] ?? -Infinity;
    return (va > vb ? 1 : va < vb ? -1 : 0) * (asc ? 1 : -1);
  });
  for (const th of $$("#ftable th")) {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.classList.toggle("asc", th.dataset.k === k && asc);
  }
  const hasScore = rows.some((p) => p.score !== null && p.score !== undefined);
  $("#ftable th[data-k='score']").hidden = !hasScore;
  const tb = $("#ftable tbody");
  tb.replaceChildren(...rows.map((p) => {
    const tr = el("tr", { "data-id": String(p.id) },
      el("td", { class: "num", text: String(p.id) }),
      el("td", {}, el("span", { class: "pol" }, el("i", { style: `background:${faultColor(p)}` }), document.createTextNode(POL_TEXT[p.polarity] || "—"))),
      el("td", { class: "num", text: fmt(p.length_km, 2) }),
      el("td", { class: "num", text: fmt(p.throw_median_m, 0) }),
      el("td", { class: "num", text: fmt(p.strike_deg, 0) }));
    if (hasScore) tr.append(el("td", { class: "num", text: fmt(p.score, 2) }));
    if (p.id === selectedId) tr.classList.add("sel");
    return tr;
  }));
  $("#table-note").textContent = `${fmt(rows.length)} 条 · 点击一行在地图上定位`;
}
$("#ftable thead").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (!th) return;
  if (tableSort.k === th.dataset.k) tableSort.asc = !tableSort.asc;
  else { tableSort.k = th.dataset.k; tableSort.asc = th.dataset.k === "id" || th.dataset.k === "polarity"; }
  renderTable();
});
$("#ftable tbody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) selectFault(Number(tr.dataset.id), { zoom: true, popup: true });
});

// ------------------------------------------------------------------ PWA：离线缓存与安装
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("#btn-install").hidden = false; });
$("#btn-install").addEventListener("click", async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => null);
  installEvt = null;
  $("#btn-install").hidden = true;
});
window.addEventListener("appinstalled", () => { $("#btn-install").hidden = true; toast("已安装到设备"); });
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("service worker:", err));
  });
}

// ------------------------------------------------------------------ 启动
$("#app-version").textContent = `v${APP_VERSION}`;
setBasemap(state.basemap);
renderRes();
setBbox(state.bbox);
initParams();
map.fitBounds(aoiRect.getBounds(), { padding: [40, 40] });
engineIdleText();
if (store.get("gfd.engineCached", false) && !navigator.connection?.saveData) setTimeout(() => { if (!worker) ensureWorker(); }, 800);
