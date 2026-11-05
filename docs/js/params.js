// GMRT 断层识别 · 核心参数：说明、解析（数据传递文件 JSON / Python 参数块）、校验、导出
// 参数与实现文件（py/gmrt_fault_detect.py）第 5 步一一对应；数值来自开发笔记本。

export const FORMAT = "gmrt-fault-params";
export const FORMAT_VERSION = 1;

// 第 13 步计算的 10 个形态特征（评分器可以选用其中任意几个）
export const FEATURES = [
  ["log10_length_m", "log₁₀ 长度"],
  ["log10_throw_m", "log₁₀ 断距"],
  ["throw_iqr_rel", "断距相对离散"],
  ["scarp_slope_deg", "陡坎平均坡度"],
  ["peak_slope_deg", "峰值坡度"],
  ["log10_width_m", "log₁₀ 宽度"],
  ["straightness", "平直度"],
  ["strike_dev_deg", "走向偏离"],
  ["facing_consistency", "朝向一致性"],
  ["truncated_frac", "截断比例"],
];
export const FEATURE_LABEL = Object.fromEntries(FEATURES);

// type: float | bool | floatOrNull | features | floatList；min/max 为闭区间，gt 表示必须严格大于 min
export const SCHEMA = {
  SIGMA_M: { label: "平滑尺度 σ", unit: "m", type: "float", min: 0, gt: true, help: "开发笔记本步骤 6：尺度选择（脊线坡度双峰程度 Ashman D 最大）" },
  ORIENT_TOL_DEG: { label: "朝向容差", unit: "°", type: "float", min: 0, max: 90, gt: true, help: "步骤 5：纹理方向 80% 权重半宽（限制在 20–45°）" },
  SLOPE_HIGH_DEG: { label: "高坡度阈值", unit: "°", type: "float", min: 0, max: 89, gt: true, help: "步骤 7：坡度混合模型后验 P(陡坎) = 0.9" },
  SLOPE_LOW_DEG: { label: "低坡度阈值", unit: "°", type: "float", min: 0, max: 89, gt: true, help: "步骤 7：后验 P(陡坎) = 0.5" },
  STOP_SLOPE_DEG: { label: "坡折坡度", unit: "°", type: "float", min: 0, max: 89, help: "步骤 7：坡度第 30 百分位" },
  EDGE_BUFFER_M: { label: "边缘缓冲", unit: "m", type: "float", min: 0, help: "步骤 7：max(2 像元, 2σ)" },
  SIMPLIFY_TOL_M: { label: "迹线简化容差", unit: "m", type: "float", min: 0, help: "步骤 7：max(0.6 像元, 30 m)" },
  MIN_CANDIDATE_M: { label: "候选最短长度", unit: "m", type: "float", min: 0, help: "步骤 7：max(300 m, 6 像元)" },
  MIN_LENGTH_M: { label: "断层最短长度", unit: "m", type: "float", min: 0, help: "步骤 10–13：接受规则" },
  MIN_THROW_M: { label: "最小断距", unit: "m", type: "float", min: 0, help: "步骤 10–13：接受规则" },
  MAX_STRIKE_DEV_DEG: { label: "最大走向偏离", unit: "°", type: "float", min: 0, max: 90, help: "步骤 10–13：接受规则" },
  USE_SCORER: { label: "使用评分器", type: "bool", help: "步骤 12–13：target-decoy 逻辑回归评分器" },
  SCORER_FEATURES: { label: "评分器特征", type: "features", help: "步骤 12" },
  SCORER_MEAN: { label: "特征均值", type: "floatList", help: "步骤 12：标准化用的均值" },
  SCORER_SCALE: { label: "特征尺度", type: "floatList", positive: true, help: "步骤 12：标准化用的尺度" },
  SCORER_COEF: { label: "系数", type: "floatList", help: "步骤 12：标准化后的逻辑回归系数" },
  SCORER_INTERCEPT: { label: "截距", unit: "", type: "float", help: "步骤 12：逻辑回归截距" },
  SCORER_THRESHOLD: { label: "评分阈值 P(断层)", unit: "", type: "float", min: 0, max: 1, help: "步骤 13：按 decoy 估计的 FDR 选出" },
  KEEP_OUTWARD: { label: "保留外倾陡坎", type: "bool", help: "步骤 15：CD99 TOBI 侧扫独立检验" },
  STRIKE_FIXED: { label: "固定区域走向", unit: "°", type: "floatOrNull", min: -360, max: 360, help: "留空 = 用结构张量自动估计" },
  REL_STOP: { label: "相对坡折比例", unit: "", type: "float", min: 0, max: 1, help: "坡度 < 它 × 峰值坡度时视为到达坡折" },
  RISE_TOL_DEG: { label: "坡度回升容差", unit: "°", type: "float", min: 0, help: "坡度回升超过它，视为进入下一条陡坎" },
  MAX_WALK_M: { label: "沿倾向最远距离", unit: "m", type: "float", min: 0, gt: true, help: "测断距时最远走多远" },
  MIN_PIXEL_THROW_M: { label: "像元最小断距", unit: "m", type: "float", min: 0, help: "单个中心线像元的断距下限" },
  LINK_GAP_M: { label: "连接最大间隙", unit: "m", type: "float", min: 0, help: "连接共线线段时允许的最大间隙" },
  LINK_ANGLE_DEG: { label: "连接最大转角", unit: "°", type: "float", min: 0, max: 180, help: "连接时允许的最大方向变化" },
};
export const PARAM_ORDER = Object.keys(SCHEMA);
// 统计 FDR 备选方案只改这 4 个接受规则
export const ALT_KEYS = ["MIN_LENGTH_M", "MIN_THROW_M", "MAX_STRIKE_DEV_DEG", "USE_SCORER"];
// 手动填写表单的分组
export const GROUPS = [
  { title: "尺度与坡度", src: "步骤 5–7", keys: ["SIGMA_M", "ORIENT_TOL_DEG", "SLOPE_HIGH_DEG", "SLOPE_LOW_DEG", "STOP_SLOPE_DEG"] },
  { title: "随网格换算的设置", src: "步骤 7", keys: ["EDGE_BUFFER_M", "SIMPLIFY_TOL_M", "MIN_CANDIDATE_M"] },
  { title: "接受规则", src: "步骤 10–13", keys: ["MIN_LENGTH_M", "MIN_THROW_M", "MAX_STRIKE_DEV_DEG", "USE_SCORER", "SCORER_THRESHOLD", "SCORER_INTERCEPT"] },
  { title: "评分器特征", src: "步骤 12", scorer: true, keys: ["SCORER_FEATURES", "SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"] },
  { title: "极性", src: "步骤 15", keys: ["KEEP_OUTWARD"] },
  { title: "算法固定常数", src: "不随数据集标定", keys: ["STRIKE_FIXED", "REL_STOP", "RISE_TOL_DEG", "MAX_WALK_M", "MIN_PIXEL_THROW_M", "LINK_GAP_M", "LINK_ANGLE_DEG"] },
];

export const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

// ------------------------------------------------------------------ Python 参数块解析（只认字面量，不执行代码）
// 按顶层的换行和分号切分语句，忽略 # 注释，括号内可以换行
export function splitStatements(text) {
  const out = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      cur += c;
      if (c === "\\" && k + 1 < text.length) { cur += text[++k]; } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "#") { while (k + 1 < text.length && text[k + 1] !== "\n") k++; continue; }
    if (c === "[" || c === "(" || c === "{") depth++;
    if (c === "]" || c === ")" || c === "}") depth = Math.max(0, depth - 1);
    if ((c === "\n" || c === ";") && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Python 字面量：数字、True/False/None、字符串、列表/元组
export function parsePyLiteral(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = (msg) => { throw new Error(`${msg}（位置 ${i + 1}：…${src.slice(i, i + 12)}）`); };
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === "[" || ch === "(") {
      const close = ch === "[" ? "]" : ")";
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (src[i] === close) { i++; return arr; }
        arr.push(value());
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === close) { i++; return arr; }
        fail(`缺少 "," 或 "${close}"`);
      }
    }
    if (ch === "'" || ch === '"') {
      i++;
      let s = "";
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++;
        s += src[i++];
      }
      if (src[i] !== ch) fail("字符串没有结束");
      i++;
      return s;
    }
    const m = /^(?:True|False|None|[-+]?(?:\d+(?:_\d+)*\.?\d*(?:_\d+)*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(src.slice(i));
    if (!m) fail("无法识别的数值");
    i += m[0].length;
    if (m[0] === "True") return true;
    if (m[0] === "False") return false;
    if (m[0] === "None") return null;
    const v = Number(m[0].replace(/_/g, ""));
    if (!Number.isFinite(v)) fail("数值无效");
    return v;
  };
  const v = value();
  ws();
  if (i < src.length) fail("多余的内容");
  return v;
}

// 解析参数块：NAME = 字面量；"# 备选…" 后面被注释掉的赋值作为统计 FDR 备选方案
export function parsePyBlock(text) {
  const params = {};
  const alt = {};
  const unknown = [];
  const errors = [];
  const assign = (stmt, target) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(stmt);
    if (!m) return;
    if (!SCHEMA[m[1]]) { if (/^[A-Z][A-Z0-9_]*$/.test(m[1])) unknown.push(m[1]); return; }
    try { target[m[1]] = parsePyLiteral(m[2]); } catch (e) { errors.push(`${m[1]}：${e.message}`); }
  };
  let altMode = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("#")) { if (t) altMode = false; continue; }
    const body = t.replace(/^#+\s*/, "");
    if (/备选/.test(body)) { altMode = true; continue; }
    if (altMode && /^[A-Z_][A-Z0-9_]*\s*=/.test(body)) { for (const st of splitStatements(body)) assign(st, alt); continue; }
    altMode = false;
  }
  for (const st of splitStatements(text)) assign(st, params);
  return { params, alt: Object.keys(alt).length ? alt : null, unknown: [...new Set(unknown)], errors };
}

// 从实现文件里取出第 5 步手动抄写的参数块
export function extractStep5Block(pyText) {
  const head = /^# =+\n# 5\. [^\n]*\n# =+\n/m.exec(pyText);
  if (!head) throw new Error("实现文件里找不到第 5 步");
  const body = pyText.slice(head.index + head[0].length);
  const end = body.indexOf("\n# ===================== 网页端的参数覆盖");
  return (end >= 0 ? body.slice(0, end) : body).trim() + "\n";
}

// ------------------------------------------------------------------ 校验
function checkValue(key, v) {
  const s = SCHEMA[key];
  if (s.type === "bool") return typeof v === "boolean" ? null : "应为 True / False";
  if (s.type === "features") {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return "应为特征名列表";
    const bad = v.filter((x) => !FEATURE_LABEL[x]);
    if (bad.length) return `不认识的特征：${bad.join(", ")}`;
    if (new Set(v).size !== v.length) return "特征重复";
    return null;
  }
  if (s.type === "floatList") {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) return "应为数值列表";
    if (s.positive && v.some((x) => x <= 0)) return "每一项都必须大于 0";
    return null;
  }
  if (s.type === "floatOrNull" && v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return s.type === "floatOrNull" ? "应为数值，或留空（自动）" : "应为数值";
  if (s.min !== undefined && (s.gt ? v <= s.min : v < s.min)) return s.gt ? `必须大于 ${s.min}` : `不能小于 ${s.min}`;
  if (s.max !== undefined && v > s.max) return `不能大于 ${s.max}`;
  return null;
}

// 返回 { ok, fields: {参数: 错误}, errors: [文字] }
export function validateParams(p) {
  const fields = {};
  for (const k of PARAM_ORDER) {
    if (!(k in p)) { fields[k] = "缺少"; continue; }
    const e = checkValue(k, p[k]);
    if (e) fields[k] = e;
  }
  if (!fields.SLOPE_LOW_DEG && !fields.SLOPE_HIGH_DEG && p.SLOPE_LOW_DEG > p.SLOPE_HIGH_DEG) {
    fields.SLOPE_LOW_DEG = "不能大于高坡度阈值";
  }
  if (!fields.SCORER_FEATURES) {
    const n = p.SCORER_FEATURES.length;
    for (const k of ["SCORER_MEAN", "SCORER_SCALE", "SCORER_COEF"]) {
      if (!fields[k] && p[k].length !== n) fields[k] = `长度 ${p[k].length} 与特征数 ${n} 不一致`;
    }
    if (p.USE_SCORER === true && n === 0) fields.SCORER_FEATURES = "使用评分器时至少要选一个特征";
  }
  const errors = Object.entries(fields).map(([k, e]) => `${k}（${SCHEMA[k].label}）：${e}`);
  return { ok: errors.length === 0, fields, errors };
}

export function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function changedKeys(p, base) { return PARAM_ORDER.filter((k) => !sameValue(p[k], base[k])); }

// ------------------------------------------------------------------ 导入
// text：文件内容。返回 { ok, params, alt, meta, kind, warnings, errors }
export function parseImport(text, builtin, name = "") {
  const warnings = [];
  const src = String(text || "").replace(/^﻿/, "").trim();
  if (!src) return { ok: false, errors: ["内容是空的"] };
  let raw = null;
  let alt = null;
  let meta = { name };
  let kind = "";
  if (src.startsWith("{")) {
    let obj;
    try { obj = JSON.parse(src); } catch (e) { return { ok: false, errors: [`JSON 解析失败：${e.message}`] }; }
    if (obj && obj.format === FORMAT) {
      kind = "transfer";
      if (Number(obj.format_version) > FORMAT_VERSION) warnings.push(`文件格式版本 ${obj.format_version} 比网页认识的 ${FORMAT_VERSION} 新`);
      if (!obj.params || typeof obj.params !== "object") return { ok: false, errors: ["数据传递文件里没有 params"] };
      raw = obj.params;
      alt = obj.alternatives && obj.alternatives.stats_fdr ? obj.alternatives.stats_fdr : null;
      meta = { name, producer: obj.producer || "", created: obj.created_utc || "", dataset: obj.dataset || null,
        diagnostics: obj.diagnostics || null, notes: obj.notes || null };
    } else if (obj && typeof obj === "object" && Object.keys(obj).some((k) => SCHEMA[k])) {
      kind = "json";
      raw = obj;
    } else {
      return { ok: false, errors: [`不是数据传递文件：缺少 "format": "${FORMAT}"，也没有认识的参数`] };
    }
    const unknown = Object.keys(raw).filter((k) => !SCHEMA[k]);
    if (unknown.length) warnings.push(`忽略了不认识的字段：${unknown.join(", ")}`);
  } else {
    kind = "python";
    const r = parsePyBlock(src);
    if (r.errors.length) return { ok: false, errors: r.errors };
    raw = r.params;
    alt = r.alt;
    if (r.unknown.length) warnings.push(`忽略了不认识的变量：${r.unknown.join(", ")}`);
    if (!Object.keys(raw).length) return { ok: false, errors: ["没有找到任何参数赋值（形如 SIGMA_M = 75.0）"] };
  }
  const params = {};
  const filled = [];
  for (const k of PARAM_ORDER) {
    if (k in raw) params[k] = clone(raw[k]);
    else { params[k] = clone(builtin[k]); filled.push(k); }
  }
  if (filled.length) warnings.push(`文件没有提供 ${filled.length} 个参数，沿用内置值：${filled.join(", ")}`);
  if (alt) {
    const a = {};
    for (const k of ALT_KEYS) if (k in alt) a[k] = alt[k];
    const bad = Object.entries(a).map(([k, v]) => [k, checkValue(k, v)]).filter(([, e]) => e);
    alt = bad.length || !Object.keys(a).length ? null : a;
    if (bad.length) warnings.push(`备选方案有误，已忽略：${bad.map(([k, e]) => `${k} ${e}`).join("；")}`);
  }
  const v = validateParams(params);
  if (!v.ok) return { ok: false, errors: v.errors, warnings };
  return { ok: true, kind, params, alt, meta, warnings, imported: PARAM_ORDER.length - filled.length };
}

// ------------------------------------------------------------------ 导出（与开发笔记本第 16 步的文件同格式）
export function buildTransfer(params, { alt = null, dataset = null, producer = "", basedOn = "", appliedTo = null } = {}) {
  const ordered = {};
  for (const k of PARAM_ORDER) ordered[k] = clone(params[k]);
  const out = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    producer,
    dataset,
    params: ordered,
    alternatives: alt ? { stats_fdr: clone(alt) } : {},
    units: Object.fromEntries(PARAM_ORDER.map((k) => [k, SCHEMA[k].unit || ""])),
    notes: Object.fromEntries(PARAM_ORDER.map((k) => [k, SCHEMA[k].help || ""])),
  };
  if (basedOn) out.based_on = basedOn;
  if (appliedTo) out.applied_to = appliedTo;
  return out;
}
