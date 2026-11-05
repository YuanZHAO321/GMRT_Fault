// GMRT 断层识别 · 计算线程
// 在 Web Worker 里加载 Pyodide（编译成 WebAssembly 的 CPython），下载 GMRT 网格写进虚拟文件系统，
// 再原样运行 py/gmrt_fault_detect.py（与实现笔记本同一套瀑布式代码），把结果文件读回页面。

const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PACKAGES = ["numpy", "scipy", "pyproj"];
const TIFFFILE_WHEEL = new URL("../vendor/tifffile/tifffile-2026.10.15-py3-none-any.whl", import.meta.url).href;
const SCRIPT_URL = new URL("../py/gmrt_fault_detect.py", import.meta.url).href;
const GRIDSERVER = "https://www.gmrt.org/services/GridServer";
const GRID_CACHE = "gfd-gmrt-grids-v1";
const GRID_CACHE_MAX = 6;
// 这些参数影响第 1–13 步。区域和它们都没变时，再次运行只重算第 14–17 步（筛选、极性、应变、输出）。
const EARLY_PARAMS = ["SIGMA_M", "ORIENT_TOL_DEG", "SLOPE_HIGH_DEG", "SLOPE_LOW_DEG", "STOP_SLOPE_DEG", "EDGE_BUFFER_M",
  "SIMPLIFY_TOL_M", "MIN_CANDIDATE_M", "STRIKE_FIXED", "REL_STOP", "RISE_TOL_DEG", "MAX_WALK_M", "MIN_PIXEL_THROW_M",
  "LINK_GAP_M", "LINK_ANGLE_DEG"];

let pyodide = null;
let initPromise = null;
let scriptText = "";
let sections = {};
// 上一次成功运行留下的 Python 命名空间（含第 1–13 步的全部中间结果）
let last = null; // { key, dir, ns }
let workDir = null; // 当前区域在虚拟文件系统里的目录（GeoTIFF 原始数据在这里，换区域时删掉）

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function throttle(fn, ms) {
  let t = 0;
  return (...args) => {
    const now = performance.now();
    if (now - t >= ms) { t = now; fn(...args); }
  };
}

// 按脚本里 "# N. 标题" 的步骤分隔块切开
function splitSections(text) {
  const re = /^# =+\n# (\d+)\. [^\n]*\n# =+$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push([Number(m[1]), m.index]);
  const out = {};
  marks.forEach(([num, start], i) => { out[num] = text.slice(start, i + 1 < marks.length ? marks[i + 1][1] : text.length); });
  return out;
}

async function fetchWithProgress(urls, onProgress) {
  let loaded = 0;
  let total = 0;
  const report = throttle(() => onProgress(loaded, total), 120);
  await Promise.all(urls.map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
    total += Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      report();
    }
  }));
  onProgress(loaded, Math.max(total, loaded));
}

function onStdout(line) {
  if (line.startsWith("@@step ")) {
    const m = /^@@step (\d+) (.*)$/.exec(line);
    if (m) post({ type: "step", num: Number(m[1]), title: m[2] });
    return;
  }
  if (line.startsWith("@@done")) return;
  post({ type: "log", line });
}

async function init() {
  const t0 = performance.now();
  post({ type: "engine", phase: "download", loaded: 0, total: 0 });
  const lock = await (await fetch(INDEX_URL + "pyodide-lock.json")).json();
  const need = new Set();
  const stack = [...PACKAGES];
  while (stack.length) {
    const name = stack.pop();
    if (need.has(name) || !lock.packages[name]) continue;
    need.add(name);
    stack.push(...(lock.packages[name].depends || []));
  }
  // 先带进度地把运行时和包取到本地缓存，随后 loadPyodide / loadPackage 直接命中缓存
  const files = ["pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip",
    ...[...need].map((n) => lock.packages[n].file_name)];
  await fetchWithProgress(files.map((f) => (/^https?:/.test(f) ? f : INDEX_URL + f)),
    (loaded, total) => post({ type: "engine", phase: "download", loaded, total }));

  post({ type: "engine", phase: "boot" });
  const { loadPyodide } = await import(INDEX_URL + "pyodide.mjs");
  pyodide = await loadPyodide({ indexURL: INDEX_URL });
  pyodide.setStdout({ batched: onStdout });
  pyodide.setStderr({ batched: (line) => post({ type: "log", line, level: "warn" }) });

  post({ type: "engine", phase: "packages" });
  await pyodide.loadPackage(PACKAGES, {
    messageCallback: () => {},
    errorCallback: (msg) => post({ type: "log", line: msg, level: "warn" }),
  });

  post({ type: "engine", phase: "tifffile" });
  const wheel = await (await fetch(TIFFFILE_WHEEL)).arrayBuffer();
  const purelib = pyodide.runPython("import sysconfig; sysconfig.get_paths()['purelib']");
  pyodide.unpackArchive(wheel, "zip", { extractDir: purelib });

  scriptText = await (await fetch(SCRIPT_URL, { cache: "no-cache" })).text();
  sections = splitSections(scriptText);
  for (const n of [5, 14, 15, 16, 17]) {
    if (!sections[n]) throw new Error(`脚本里找不到第 ${n} 步的分隔块`);
  }
  pyodide.runPython("import importlib; importlib.invalidate_caches()\n"
    + "import numpy, scipy.ndimage, scipy.spatial, scipy.stats, tifffile, pyproj");
  const versions = JSON.parse(pyodide.runPython(
    "import sys, json, numpy, scipy, tifffile, pyproj\n"
    + "json.dumps({'python': sys.version.split()[0], 'numpy': numpy.__version__, 'scipy': scipy.__version__, "
    + "'tifffile': tifffile.__version__, 'pyproj': pyproj.__version__})"));
  post({ type: "ready", versions: { pyodide: pyodide.version, ...versions }, seconds: (performance.now() - t0) / 1000 });
}

function ensureInit() {
  if (!initPromise) initPromise = init().catch((err) => { initPromise = null; throw err; });
  return initPromise;
}

function gridUrl(bbox, res, layer) {
  const [w, e, s, n] = bbox;
  const q = new URLSearchParams({ west: w.toFixed(6), east: e.toFixed(6), south: s.toFixed(6), north: n.toFixed(6),
    layer, format: "geotiff", resolution: res });
  return `${GRIDSERVER}?${q}`;
}

async function downloadGrid(url) {
  let cache = null;
  try { cache = await caches.open(GRID_CACHE); } catch { cache = null; }
  let res = cache ? await cache.match(url) : undefined;
  const fromCache = Boolean(res);
  if (!res) {
    post({ type: "download", phase: "request" });
    res = await fetch(url);
    if (!res.ok) throw new Error(`GMRT GridServer 返回 HTTP ${res.status}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  const report = throttle(() => post({ type: "download", phase: "progress", loaded, total, fromCache }), 120);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    report();
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  post({ type: "download", phase: "done", loaded, total: loaded, fromCache });
  const isTiff = bytes.length > 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d));
  if (!isTiff) {
    const text = new TextDecoder().decode(bytes.slice(0, 400)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(`GMRT 没有返回 GeoTIFF 网格${text ? "：" + text : ""}`);
  }
  if (cache && !fromCache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { "content-type": "image/tiff" } }));
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - GRID_CACHE_MAX))) await cache.delete(k);
    } catch { /* 存储空间不够时只是不缓存 */ }
  }
  return bytes;
}

function fsExists(path) {
  try { pyodide.FS.stat(path); return true; } catch { return false; }
}

function releaseNamespace() {
  if (!last) return;
  try { last.ns.clear(); } catch { /* ignore */ }
  try { last.ns.destroy(); } catch { /* ignore */ }
  last = null;
}

function pyRun(code, globals) {
  return pyodide.runPython(code, { globals, filename: "gmrt_fault_detect.py" });
}

// RUN_CONFIG 以 JSON 交给 Python 再解码：null -> None（pyodide.toPy 会把 null 变成 JsNull），数值类型也与桌面端一致
function setRunConfig(ns, obj) {
  ns.set("_RUN_CONFIG_JSON", JSON.stringify(obj));
  pyodide.runPython("import json as _json\nRUN_CONFIG = _json.loads(_RUN_CONFIG_JSON)\ndel _json, _RUN_CONFIG_JSON", { globals: ns });
}

function removeDir(path) {
  const g = pyodide.toPy({ _path: path });
  pyodide.runPython("import gc, shutil\nshutil.rmtree(_path, ignore_errors=True)\ngc.collect()", { globals: g });
  g.destroy();
}

function readOutputs(outDir, withPreview) {
  const text = (name) => pyodide.FS.readFile(`${outDir}/${name}`, { encoding: "utf8" });
  return { faults: text("faults.geojson"), axis: text("axis.geojson"), summary: text("summary.json"),
    csv: text("faults.csv"), preview: withPreview ? pyodide.FS.readFile(`${outDir}/preview.png`).buffer : null };
}

async function run(cfg) {
  const t0 = performance.now();
  await ensureInit();
  const key = `${cfg.bbox.map((v) => v.toFixed(6)).join("_")}_${cfg.res}`.replace(/[^0-9A-Za-z_.]/g, "m");
  const dir = `/work/${key}`;
  const runConfig = {
    aoi_name: cfg.aoiName || "aoi", bbox: cfg.bbox, gmrt_res: cfg.res, layers: ["topo-mask"],
    raw_dir: `${dir}/raw`, out_dir: `${dir}/out`, params: cfg.params || {}, max_grid_cells: cfg.maxCells || 12000000,
  };

  // 同一区域、第 1–13 步的参数没变：复用上次的中间结果，只执行第 5 步（参数）和第 14–17 步
  if (last && last.key === key && cfg.allowReuse !== false) {
    const ns = last.ns;
    setRunConfig(ns, { ...runConfig, reuse_preview: true });
    let quick = false;
    try {
      quick = pyRun(`_EARLY_BEFORE = {k: globals()[k] for k in ${JSON.stringify(EARLY_PARAMS)}}\n${sections[5]}\n`
        + "_EARLY_SAME = all(globals()[k] == v for k, v in _EARLY_BEFORE.items())\n_EARLY_SAME", ns);
      if (quick) {
        post({ type: "mode", quick: true });
        pyRun("T_START = time.time()\n" + [14, 15, 16, 17].map((n) => sections[n]).join("\n"), ns);
        post({ type: "result", quick: true, seconds: (performance.now() - t0) / 1000, ...readOutputs(runConfig.out_dir, false) });
        return;
      }
    } catch (err) {
      releaseNamespace();     // 命名空间可能只改了一半，下次完整重算
      throw err;
    }
    post({ type: "log", line: "第 1–13 步的参数有改动，重新完整运行" });
  }

  post({ type: "mode", quick: false });
  releaseNamespace();
  if (workDir && workDir !== dir) removeDir(workDir);
  workDir = dir;
  pyodide.FS.mkdirTree(runConfig.raw_dir);
  pyodide.FS.mkdirTree(runConfig.out_dir);
  post({ type: "step", num: 1, title: "下载 GMRT" });
  for (const layer of runConfig.layers) {
    const path = `${runConfig.raw_dir}/gmrt_${layer}.tif`;
    if (!fsExists(path)) pyodide.FS.writeFile(path, await downloadGrid(gridUrl(cfg.bbox, cfg.res, layer)));
    else {
      const size = pyodide.FS.stat(path).size;
      post({ type: "download", phase: "done", loaded: size, total: size, fromCache: true });
    }
  }
  const ns = pyodide.toPy({ __name__: "__main__" });
  setRunConfig(ns, runConfig);
  try {
    pyRun(scriptText, ns);
  } catch (err) {
    try { ns.clear(); ns.destroy(); } catch { /* ignore */ }
    pyodide.runPython("import gc; gc.collect()");
    throw err;
  }
  last = { key, dir, ns };
  const out = readOutputs(runConfig.out_dir, true);
  post({ type: "result", quick: false, seconds: (performance.now() - t0) / 1000, ...out }, [out.preview]);
}

function describe(err) {
  const text = String((err && err.message) || err || "未知错误");
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const lastLine = lines.length ? lines[lines.length - 1].trim() : text;
  const m = /^([A-Za-z_.]*(?:Error|Exception|Interrupt)): (.*)$/.exec(lastLine);
  const kind = m ? m[1] : "Error";
  let message = m ? m[2] : lastLine;
  // 脚本自己抛出的 RuntimeError / ValueError 已经是中文提示；其他错误带上类型，参数块里的错误带上行号
  if (m && !["RuntimeError", "ValueError"].includes(kind)) message = `${kind}: ${message}`;
  const blockLine = [...text.matchAll(/File "<参数块>", line (\d+)/g)].pop();
  if (blockLine) message += `（参数块第 ${blockLine[1]} 行）`;
  if (/MemoryError|Out of memory|memory access out of bounds/i.test(text)) message += " —— 内存不足：请缩小区域或降低分辨率。";
  return { message, kind, detail: text };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === "init") await ensureInit();
    else if (msg.type === "run") await run(msg.cfg);
  } catch (err) {
    post({ type: "error", during: msg.type, ...describe(err) });
  }
};
