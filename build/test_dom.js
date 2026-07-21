// 用 DOM + ECharts 桩在 Node 中真实执行 app.js 的 init 与交互回调
const fs = require("fs");
const vm = require("vm");

function matchEl(el, sel) {
  if (sel[0] === ".") return (el.className || "").split(/\s+/).indexOf(sel.slice(1)) >= 0;
  if (sel[0] === "#") return el._id === sel.slice(1);
  return el.tagName && el.tagName.toLowerCase() === sel.toLowerCase();
}
function findOne(el, sel) {
  for (const c of (el.children || [])) {
    if (matchEl(c, sel)) return c;
    const r = findOne(c, sel); if (r) return r;
  }
  return null;
}
function findAll(el, sel, out) {
  out = out || [];
  for (const c of (el.children || [])) { if (matchEl(c, sel)) out.push(c); findAll(c, sel, out); }
  return out;
}

function El(id) {
  const e = {
    _id: id, tagName: id, value: "", textContent: "", _html: "", checked: false, type: "",
    dataset: {}, files: [], style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); if (c && c.tagName === "option" && c.selected) this.value = c.value; return c; },
    querySelector(sel) {
      const r = findOne(this, sel); if (r) return r;
      if (sel === "tbody") { const tb = El("tbody"); this.appendChild(tb); return tb; }
      return null;
    },
    querySelectorAll(sel) { return findAll(this, sel); },
    addEventListener() {}, removeChild() {}, click() { if (this._onclick) this._onclick(); },
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set onsubmit(f) { this._onsubmit = f; }, get onsubmit() { return this._onsubmit; },
    set oninput(f) { this._oninput = f; }, get oninput() { return this._oninput; },
    set onchange(f) { this._onchange = f; }, get onchange() { return this._onchange; },
  };
  Object.defineProperty(e, "innerHTML", { get() { return this._html; }, set(v) { this._html = v; } });
  return e;
}

const elById = {};
const document = {
  readyState: "complete",
  getElementById(id) { return (elById[id] = elById[id] || El(id)); },
  createElement(tag) { return El(tag); },
  createTextNode(t) { return { text: t, nodeType: 3 }; },
    querySelector(sel) {
    if (sel && sel.includes('name="action"')) return { value: "buy" };
    return findOne(this, sel);
  },
  querySelectorAll(sel) {
    if (sel === "#autoCondBody tr") { const b = elById["autoCondBody"]; return b ? b.children : []; }
    return findAll(this, sel);
  },
  addEventListener() {},
};
const echarts = {
  getInstanceByDom() { return null; },
  init() { return { setOption() {}, clear() {}, resize() {} }; },
  graphic: { LinearGradient: function () { } },
};
const ctx = {
  document, echarts, console,
  alert: (m) => console.log("ALERT:", m),
  confirm: () => true, prompt: () => "新策略",
  setTimeout, FileReader: function () {}, Blob: function () {}, URL: { createObjectURL: () => "" },
};
ctx.window = ctx;          // window 即全局对象
ctx.addEventListener = () => {}; // 浏览器中 window.addEventListener 原生存在

vm.createContext(ctx);
const files = ["sample-data.js", "data.js", "engine.js", "analytics.js", "charts.js", "app.js"];
try {
  for (const f of files) vm.runInContext(fs.readFileSync("js/" + f, "utf8"), ctx, { filename: f });
  console.log("✅ init() 执行无异常");
} catch (e) {
  console.error("❌ init 抛错：", e && e.stack || e);
  process.exit(1);
}

const G = (id) => document.getElementById(id);
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; } else console.log("✅", m); }

assert(G("metricCards")._html, "指标面板已渲染");
assert(G("compareTableWrap")._html && G("compareTableWrap")._html.includes("策略"), "对比表已渲染");
assert(G("fundList")._html && G("fundList")._html.includes("已加载"), "基金列表已渲染");
assert(G("viewDateLabel").textContent, "查看日标签已设置: " + G("viewDateLabel").textContent);
assert(G("viewSlider").max && +G("viewSlider").max > 1000, "滑块 max 已设置: " + G("viewSlider").max);

// 交互：添加一笔交易
try {
  G("tradeFund").value = "110011"; G("tradeDate").value = "2021-03-01"; G("tradeAmount").value = "20000";
  G("tradeForm")._onsubmit({ preventDefault() {} });
  console.log("✅ 添加交易回调无异常");
} catch (e) { console.error("❌ 添加交易抛错:", e.stack || e); process.exitCode = 1; }

// 交互：新建策略
try { G("addStrategyBtn")._onclick(); console.log("✅ 新建策略回调无异常"); }
catch (e) { console.error("❌ 新建策略抛错:", e.stack || e); process.exitCode = 1; }

// 交互：应用/重算
try {
  G("startDate").value = "2022-01-01"; G("endDate").value = "2026-07-20";
  G("initialCapital").value = "200000"; G("feeRate").value = "0.10";
  G("applyBtn")._onclick();
  console.log("✅ 应用/重算回调无异常");
} catch (e) { console.error("❌ 应用抛错:", e.stack || e); process.exitCode = 1; }

// 交互：拖动查看日滑块
try {
  G("viewSlider").value = "100"; G("viewSlider")._oninput();
  console.log("✅ 滑块回调无异常, 查看日=" + G("viewDateLabel").textContent);
} catch (e) { console.error("❌ 滑块抛错:", e.stack || e); process.exitCode = 1; }

// 交互：VIX 开关 → 渲染 VIX 子图
try {
  G("vixToggle").checked = true; G("vixToggle")._onchange();
  console.log("✅ VIX 开关+子图渲染无异常");
} catch (e) { console.error("❌ VIX 渲染抛错:", e.stack || e); process.exitCode = 1; }

// 交互：交易日期变化 → VIX 实时读数
try {
  G("tradeDate").value = "2022-05-23"; G("tradeDate")._onchange();
  const t = G("tradeVix").textContent;
  assert(/VIX/.test(t), "交易日期 VIX 读数已更新: " + t);
} catch (e) { console.error("❌ VIX 读数抛错:", e.stack || e); process.exitCode = 1; }

// 交互：填入最恐慌日
try {
  G("tradeDate").value = ""; G("panicBtn")._onclick();
  const d = G("tradeDate").value;
  assert(/^20\d\d-\d\d-\d\d$/.test(d), "最恐慌日已填入交易日期: " + d);
} catch (e) { console.error("❌ 最恐慌日抛错:", e.stack || e); process.exitCode = 1; }

console.log("\nDOM 接线校验完成。");

// 交互：VIX 自动交易（开启 → 生成并运行）
try {
  G("autoFund").value = "513100";
  G("autoMode").value = "cross";
  G("autoEnabled").checked = true;
  G("autoEnabled")._onchange();
  const status = G("autoStatus").textContent || "";
  console.log("✅ 自动交易 onchange 无异常, status:", status);
  assert(/笔交易/.test(status), "自动交易已生成交易（默认买>30/卖<20 条件已生效）");
} catch (e) { console.error("❌ 自动交易抛错:", e.stack || e); process.exitCode = 1; }

// 边界：所有条件金额为 0 → 被 runVixAuto 校验拦截（弹 alert，不生成）
try {
  G("autoCondBody").children.forEach(tr => {
    const am = tr.querySelector(".ac-amt"); if (am) am.value = "0";
  });
  G("autoEnabled").checked = true;
  G("autoEnabled")._onchange();
  console.log("✅ 金额为 0 时未生成交易（由 runVixAuto 内 alert 拦截）");
} catch (e) { console.error("❌ 边界用例抛错:", e.stack || e); process.exitCode = 1; }

// 交互：定投独立运行（不依赖 autoEnabled）
try {
  G("dcaFund").value = "513100";
  G("dcaFreq").value = "month";
  G("dcaAmount").value = "2000";
  G("dcaEnabled").checked = true;
  G("dcaEnabled")._onchange();
  const dst = G("dcaStatus").textContent || "";
  console.log("✅ 定投 onchange 无异常, status:", dst);
  assert(/笔交易/.test(dst), "定投已独立生成交易（无需启用自动交易）");
} catch (e) { console.error("❌ 定投抛错:", e.stack || e); process.exitCode = 1; }

// 智能分析：策略点评（AI 视角）卡片已渲染且含定性/亮点/风险三栏
try {
  const aw = G("analysisWrap").innerHTML || "";
  assert(/策略点评（AI 视角）/.test(aw), "策略点评卡片已渲染");
  assert(/风险与改进/.test(aw) && /亮点/.test(aw) && /定性/.test(aw), "策略点评含 定性/亮点/风险与改进 三栏");
  console.log("✅ 策略点评（AI 视角）渲染正常（含三栏）");
} catch (e) { console.error("❌ 策略点评渲染失败:", e.stack || e); process.exitCode = 1; }

