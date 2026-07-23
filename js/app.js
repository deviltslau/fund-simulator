// ============================================================
// 主控制器：状态、示例、渲染、交互
// ============================================================
(function () {
  const D = FS.Data, E = FS.Engine, A = FS.Analytics, C = FS.Charts;
  const $ = id => document.getElementById(id);

  // ---------- 工具 ----------
  const pct = x => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
  const money = x => "¥" + (x == null ? 0 : x).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const num = (x, d = 2) => (x == null ? 0 : x).toLocaleString("zh-CN", { maximumFractionDigits: d });
  const cls = x => (x >= 0 ? "pos" : "neg");
  const vixZone = v => (v == null ? "" : v < 15 ? "calm" : v < 25 ? "norm" : v < 30 ? "high" : "panic");
  const uid = () => "t" + Math.random().toString(36).slice(2, 9);

  // 指标数字滚动动画（无 requestAnimationFrame / 测试桩时直接定值）
  function countUp(el) {
    const raw = el.textContent;
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof window === "undefined" || !window.requestAnimationFrame) return;
    const m = raw.match(/([\d.,]+)/);
    if (!m) return;
    const prefix = raw.slice(0, m.index);
    const numStr = m[1].replace(/,/g, "");
    const suffix = raw.slice(m.index + m[1].length);
    const target = parseFloat(numStr);
    if (isNaN(target)) return;
    const dur = 650, t0 = Date.now();
    (function step() {
      const k = Math.min(1, (Date.now() - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = prefix + (target * e).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + suffix;
      if (k < 1) window.requestAnimationFrame(step);
      else el.textContent = raw;
    })();
  }

  // 内联 sparkline（资产曲线），纯 SVG，无额外 canvas / 依赖
  function sparkSVG(series, opts) {
    opts = opts || {};
    const w = opts.w || 260, h = opts.h || 60, pad = 4;
    if (!series || !series.length) return "";
    const vals = series.filter(v => typeof v === "number" && Number.isFinite(v));
    if (vals.length < 2) return "";
    const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    const span = (max - min) || 1, n = vals.length;
    const X = i => pad + (i / (n - 1)) * (w - pad * 2);
    const Y = v => pad + (1 - (v - min) / span) * (h - pad * 2);
    let d = "";
    vals.forEach((v, i) => { d += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1) + " "; });
    const area = d + "L" + X(n - 1).toFixed(1) + " " + (h - pad).toFixed(1) + " L" + X(0).toFixed(1) + " " + (h - pad).toFixed(1) + " Z";
    const up = vals[n - 1] >= vals[0];
    const col = up ? "var(--pos)" : "var(--neg)";
    const gid = "spk" + uid();
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + col + '" stop-opacity=".22"/>' +
      '<stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(vals[n - 1]).toFixed(1) + '" r="2.4" fill="' + col + '"/></svg>';
  }

  // ---------- 状态 ----------
  const state = {
    startDate: "", endDate: "", benchmarkCode: "",
    strategies: [], activeId: null,
    viewDate: "", showFunds: new Set(),
    _activeKey: null,
    results: {},          // id -> {engine, analytics}
    activeEngine: null, activeAnalytics: null,
  };
  let mainChart = null, compareChart = null, vixChart = null;

  // ---------- 示例数据 ----------
  function seedStrategies() {
    const mk = (name, trades) => ({
      id: uid(), name,
      initialCapital: 100000, feeRate: 0.0015,
      trades: trades.map(t => ({ id: uid(), ...t })),
    });
    state.strategies = [
      mk("稳健配置", [
        { fundCode: "110003", action: "buy", date: "2021-01-04", amount: 50000 },
        { fundCode: "005827", action: "buy", date: "2022-01-04", amount: 50000 },
        { fundCode: "005827", action: "sell", date: "2024-06-03", amount: 0, clearAll: true },
      ]),
      mk("成长进攻", [
        { fundCode: "519674", action: "buy", date: "2021-03-01", amount: 50000 },
        { fundCode: "161725", action: "buy", date: "2021-09-01", amount: 50000 },
        { fundCode: "003096", action: "buy", date: "2022-03-01", amount: 40000 },
        { fundCode: "161725", action: "sell", date: "2023-08-01", amount: 0, clearAll: true },
      ]),
      mk("VIX恐慌买入", [
        { fundCode: "513100", action: "buy", date: "2022-04-14", amount: 50000 },
        { fundCode: "513100", action: "buy", date: "2022-10-13", amount: 50000 },
        { fundCode: "513100", action: "sell", date: "2024-06-03", amount: 0, clearAll: true },
      ]),
    ];
    state.activeId = state.strategies[0].id;
  }

  function tradedFunds(st) {
    return [...new Set(st.trades.map(t => t.fundCode))];
  }

  // ---------- 初始化 ----------
  function init() {
    D.loadSample();
    const meta = window.SAMPLE_META || {};
    const range = D.dateRange();
    state.startDate = "2021-01-01";
    state.endDate = range.max || "2026-07-20";
    state.benchmarkCode = (D.getBenchmark() || {}).code || "";

    // 基准下拉
    const bs = $("benchmarkSelect");
    bs.innerHTML = "";
    D.listFunds().forEach(f => {
      const o = document.createElement("option");
      o.value = f.code; o.textContent = f.name + (f.isBenchmark ? " (基准)" : "");
      if (f.isBenchmark) o.selected = true;
      bs.appendChild(o);
    });

    // 交易基金下拉
    refreshFundSelect();
    refreshFundList();
    populateAutoFund();
    populateDcaFund();
    seedAutoConds();
    // 自动交易 / 定投 默认区间 = 全局区间
    $("autoStart").value = state.startDate;
    $("autoEnd").value = state.endDate;
    $("dcaStart").value = state.startDate;
    $("dcaEnd").value = state.endDate;
    seedStrategies();

    // 全局控件初值
    $("startDate").value = state.startDate;
    $("endDate").value = state.endDate;
    const act = state.strategies[0];
    $("initialCapital").value = act.initialCapital;
    $("feeRate").value = (act.feeRate * 100).toFixed(2);
    bs.value = state.benchmarkCode;
    $("tradeDate").value = state.endDate;
    updateTradeVix();

    bindEvents();
    $("dataNote").textContent = meta.synthetic
      ? "⚠ 内置样例为统计模拟数据（已锚定真实最新净值），仅供演示；实盘请导入真实 CSV。"
      : "已加载净值数据。";

    recomputeAll();
    renderTabs();
    renderAll();
  }

  function refreshFundSelect() {
    const sel = $("tradeFund");
    sel.innerHTML = "";
    D.listFunds().forEach(f => {
      const o = document.createElement("option");
      o.value = f.code; o.textContent = `${f.code} ${f.name}`;
      sel.appendChild(o);
    });
  }

  function refreshFundList() {
    const wrap = $("fundList");
    wrap.innerHTML = "已加载基金：" + D.listFunds().map(f =>
      `<span class="chip${f.isBenchmark ? " bench" : ""}">${f.code} ${f.name}</span>`).join("");
  }
  function populateAutoFund() {
    const sel = $("autoFund");
    sel.innerHTML = "";
    D.listFunds().forEach(f => {
      const o = document.createElement("option");
      o.value = f.code; o.textContent = `${f.code} ${f.name}`;
      sel.appendChild(o);
    });
    // 默认优先纳指 ETF（VIX 是美股恐慌指数，最常用于纳指择时）
    const pref = D.getFund("513100") ? "513100"
      : (D.listFunds().find(f => !f.isBenchmark) || {}).code;
    if (pref) sel.value = pref;
  }
  function populateDcaFund() {
    const sel = $("dcaFund");
    sel.innerHTML = "";
    D.listFunds().forEach(f => {
      const o = document.createElement("option");
      o.value = f.code; o.textContent = `${f.code} ${f.name}`;
      sel.appendChild(o);
    });
    const pref = D.getFund("513100") ? "513100"
      : (D.listFunds().find(f => !f.isBenchmark) || {}).code;
    if (pref) sel.value = pref;
  }

  // 自动交易：添加一条分级条件行
  function addCondRow(init) {
    const tr = document.createElement("tr");
    const sel = (cls, def, items) => {
      const s = document.createElement("select");
      s.className = cls;
      items.forEach(([val, txt]) => { const o = document.createElement("option"); o.value = val; o.textContent = txt; if (val === def) o.selected = true; s.appendChild(o); });
      return s;
    };
    const cell = n => { const td = document.createElement("td"); td.appendChild(n); return td; };
    tr.appendChild(cell(sel("ac-action", (init && init.action) || "buy", [["buy", "买入"], ["sell", "卖出"]])));
    tr.appendChild(cell(sel("ac-op", (init && init.op) || ">", [[">", "> 高于"], ["<", "< 低于"]])));
    const vi = document.createElement("input"); vi.type = "number"; vi.className = "ac-vix"; vi.value = (init && init.vix != null) ? init.vix : 30; vi.step = "1"; vi.min = "0"; tr.appendChild(cell(vi));
    const am = document.createElement("input"); am.type = "number"; am.className = "ac-amt"; am.value = (init && init.amount) ? init.amount : 20000; am.step = "1000"; am.min = "0"; tr.appendChild(cell(am));
    tr.appendChild(cell(sel("ac-unit", (init && init.unit) || "cash", [["cash", "元"], ["layer", "层仓"]])));
    const del = document.createElement("button"); del.type = "button"; del.className = "btn tiny ac-del"; del.textContent = "✕"; del.onclick = () => tr.remove();
    tr.appendChild(cell(del));
    $("autoCondBody").appendChild(tr);
  }
  // 首次进入自动交易面板时，预置两条默认条件（买 VIX>30 / 卖 VIX<20，各 20000 元）
  function seedAutoConds() {
    const body = $("autoCondBody");
    if (body.children.length) return;
    addCondRow({ action: "buy", op: ">", vix: 30, amount: 20000, unit: "cash" });
    addCondRow({ action: "sell", op: "<", vix: 20, amount: 20000, unit: "cash" });
  }

  // ---------- VIX 自动交易生成（分级条件）----------
  // p: {fundCode,start,end,mode,initialCapital,feeRate,
  //     conditions:[{action:'buy'|'sell',op:'>'|'<',vix:Number,amount:Number,unit:'cash'|'layer'}]}
  // 每天先卖后买；同方向多条命中只取一条：买入取 VIX 阈值最高的，卖出取最低的。
  // 突破模式：仅在 VIX 穿越阈值的「当日」触发一次；持续模式：每个满足条件的交易日都触发（对称）。
  // 返回 {trades:[{id,fundCode,action,date,amount,unit,clearAll:false}], log, buys, sells}
  function generateVixTrades(p) {
    const f = D.getFund(p.fundCode);
    if (!f) return { trades: [], log: "基金不存在" };
    const dates = D.unionDates([p.fundCode], p.start, p.end);
    if (!dates.length) return { trades: [], log: "该区间无交易日" };
    const feeRate = p.feeRate || 0;
    let cash = p.initialCapital || 0;   // 仅用于在生成阶段避免「无现金却买入」的失真
    let sharesHeld = 0;                // 模拟持仓份额（持续模式卖出判定用）
    let prevVix = null;
    let dcaIdx = 0;                    // 定投「每N交易日」计数器
    let buys = 0, sells = 0;
    const trades = [];
    const hits = (c, v, prev, mode) => {
      const hit = c.op === ">" ? v > c.vix : v < c.vix;
      if (!hit) return false;
      if (mode !== "cross") return true;                 // 持续：满足条件即触发
      return c.op === ">"                                      // 突破：仅在穿越阈值当日
        ? (prev != null && prev <= c.vix && v > c.vix)
        : (prev != null && prev >= c.vix && v < c.vix);
    };
    for (const d of dates) {
      const v = D.vixOnOrBefore(d);
      const nav = D.navOnOrBefore(f, d);
      if (v == null || nav == null) { prevVix = v; continue; }

      // —— 先卖后买（腾出资金）——
      // 卖出：取所有命中卖条件中 VIX 阈值最低的一条（只要仍持股）
      const sellHits = p.conditions.filter(c => c.action === "sell" && hits(c, v, prevVix, p.mode));
      if (sharesHeld > 1e-9 && sellHits.length) {
        const c = sellHits.reduce((a, b) => (b.vix < a.vix ? b : a));
        const isLayer = c.unit === "layer";
        const sellShares = isLayer
          ? Math.min(c.amount * 0.1 * sharesHeld, sharesHeld)
          : Math.min((c.amount || 0) / nav, sharesHeld);
        if (sellShares > 1e-9) {
          trades.push({ id: uid(), fundCode: p.fundCode, action: "sell", date: d, amount: c.amount, unit: c.unit, clearAll: false, src: "vix" });
          cash += sellShares * nav * (1 - feeRate);
          sharesHeld -= sellShares;
          sells++;
        }
      }
      // 买入：取所有命中买条件中 VIX 阈值最高的一条
      const buyHits = p.conditions.filter(c => c.action === "buy" && hits(c, v, prevVix, p.mode));
      if (buyHits.length) {
        const c = buyHits.reduce((a, b) => (b.vix > a.vix ? b : a));
        const isLayer = c.unit === "layer";
        let buyShares = 0, spend = 0, need = 0, okBuy = true;
        if (isLayer) {
          // 层仓：N 层 = N×10% 的当前现金（10 层≈全仓）
          spend = Math.min(c.amount * 0.1 * cash, cash);
          if (spend <= 1e-6) okBuy = false;
          else { need = spend; buyShares = spend * (1 - feeRate) / nav; }
        } else {
          need = c.amount;
          buyShares = (c.amount * (1 - feeRate)) / nav;
        }
        if (okBuy && need <= cash + 1e-6) {
          trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: c.amount, unit: c.unit, clearAll: false, src: "vix" });
          if (isLayer) { cash -= spend; sharesHeld += buyShares; }
          else { cash -= c.amount; sharesHeld += buyShares; }
          buys++;
        }
      }

      // 定投（与 VIX 条件并行，仅买入）
      if (p.dca && p.dca.enabled) {
        let hit = false;
        if (p.dca.freq === "month") hit = (d.slice(8, 10) === "01");           // 每月 1 日
        else if (p.dca.freq === "week") hit = (new Date(d + "T00:00:00").getDay() === 1); // 每周一
        else if (p.dca.freq === "ndays") { dcaIdx++; hit = (dcaIdx % p.dca.n === 0); } // 每 N 交易日
        if (hit) {
          const u = p.dca.unit, amt = p.dca.amount;
          if (u === "layer") {
            const sp = Math.min(amt * 0.1 * cash, cash);
            if (sp > 1e-6 && sp <= cash + 1e-6) {
              trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: amt, unit: "layer", dca: true, src: "dca", clearAll: false });
              cash -= sp; sharesHeld += sp * (1 - feeRate) / nav; buys++;
            }
          } else {
            if (amt <= cash + 1e-6) {
              trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: amt, unit: "cash", dca: true, src: "dca", clearAll: false });
              cash -= amt; sharesHeld += (amt * (1 - feeRate)) / nav; buys++;
            }
          }
        }
      }
      prevVix = v;
    }
    const log = `生成 ${buys} 笔买入、${sells} 笔卖出（区间 ${dates[0]} ~ ${dates[dates.length - 1]}）`;
    return { trades, log, buys, sells };
  }

  function readAutoParams() {
    const conditions = [];
    document.querySelectorAll("#autoCondBody tr").forEach(tr => {
      const action = tr.querySelector(".ac-action").value;
      const op = tr.querySelector(".ac-op").value;
      const vix = +tr.querySelector(".ac-vix").value;
      const amount = +tr.querySelector(".ac-amt").value || 0;
      const unit = tr.querySelector(".ac-unit").value;
      if (!action || !op || !(vix >= 0) || amount <= 0) return; // 跳过未填完的行
      conditions.push({ action, op, vix, amount, unit });
    });
    // 定投（定时定额，仅买入）
    const dcaEl = $("dcaEnabled");
    const dca = (dcaEl && dcaEl.checked) ? (() => {
      const freq = $("dcaFreq").value;
      const n = +$("dcaN").value || 0;
      const amount = +$("dcaAmount").value || 0;
      const unit = $("dcaUnit").value;
      if (!(amount > 0)) return null;
      if (freq === "ndays" && !(n > 0)) return null;
      return { enabled: true, freq, n, amount, unit };
    })() : null;
    return {
      fundCode: $("autoFund").value,
      start: $("autoStart").value || state.startDate,
      end: $("autoEnd").value || state.endDate,
      mode: $("autoMode").value,
      initialCapital: Math.max(0, +$("initialCapital").value || 0),
      feeRate: Math.max(0, (+$("feeRate").value || 0) / 100),
      conditions, dca,
    };
  }

  // 通用：把自动生成的交易落地到策略（按 src 区分，VIX/定投互不覆盖）
  function applyAutoTrades(trades, name, statusId, createNew, src, p) {
    if (createNew) {
      let st = state.strategies.find(s => s.name === name);
      if (!st) {
        st = { id: uid(), name, initialCapital: p.initialCapital, feeRate: p.feeRate, trades: [] };
        state.strategies.push(st);
      } else {
        // 只替换本来源(src)的交易，保留手动或其它来源
        st.trades = st.trades.filter(t => t.src !== src);
        st.initialCapital = p.initialCapital; st.feeRate = p.feeRate;
      }
      trades.forEach(t => st.trades.push(t));
      state.activeId = st.id; state._activeKey = null;
    } else {
      const st = state.strategies.find(s => s.id === state.activeId);
      trades.forEach(t => st.trades.push(t));
    }
    recomputeAll(); renderAll();
    $(statusId).textContent = (createNew ? "已生成策略：" : "已追加到当前策略：") + `生成 ${trades.length} 笔交易`;
  }

  // VIX 自动交易（依赖「启用自动交易」开关）
  function runVixAuto(createNew) {
    if (!$("autoEnabled").checked) return alert("请先勾选「启用自动交易」。");
    const p = readAutoParams();
    p.dca = null; // VIX 运行时不带定投
    if (!p.fundCode) return;
    if (!p.conditions.length) return alert("请至少添加一条有效条件（需填写 VIX 阈值与金额）。");
    if (!p.conditions.some(c => c.action === "buy")) return alert("至少需要一条买入条件。");
    const f = D.getFund(p.fundCode);
    const { trades, log } = generateVixTrades(p);
    if (!trades.length) { $("autoStatus").textContent = "未生成任何交易：" + log; return; }
    applyAutoTrades(trades, "VIX自动·" + (f ? f.name : p.fundCode), "autoStatus", createNew, "vix", p);
  }

  // 定投（独立功能，依赖「启用定投」开关，仅买入）
  function readDcaParams() {
    const fundCode = $("dcaFund").value;
    const freq = $("dcaFreq").value;
    const n = +$("dcaN").value || 0;
    const amount = +$("dcaAmount").value || 0;
    const unit = $("dcaUnit").value;
    if (!(amount > 0)) return null;
    if (freq === "ndays" && !(n > 0)) return null;
    return {
      fundCode,
      start: $("dcaStart").value || state.startDate,
      end: $("dcaEnd").value || state.endDate,
      mode: "cross",
      initialCapital: Math.max(0, +$("initialCapital").value || 0),
      feeRate: Math.max(0, (+$("feeRate").value || 0) / 100),
      conditions: [],
      dca: { enabled: true, freq, n, amount, unit },
    };
  }
  function runDca(createNew) {
    if (!$("dcaEnabled").checked) return alert("请先勾选「启用定投」。");
    const p = readDcaParams();
    if (!p) return alert("请填写定投的每期金额（>0）。");
    const f = D.getFund(p.fundCode);
    const { trades, log } = generateVixTrades(p);
    if (!trades.length) { $("dcaStatus").textContent = "未生成任何定投交易：" + log; return; }
    applyAutoTrades(trades, "定投·" + (f ? f.name : p.fundCode), "dcaStatus", createNew, "dca", p);
  }

  // ---------- 重算 ----------
  function recomputeAll() {
    state.results = {};
    for (const st of state.strategies) {
      const ctx = { startDate: state.startDate, endDate: state.endDate, benchmarkCode: state.benchmarkCode };
      const engine = E.run(st, ctx);
      const analytics = A.computeAll(engine, ctx);
      state.results[st.id] = { engine, analytics };
    }
    state.activeEngine = state.results[state.activeId].engine;
    state.activeAnalytics = state.results[state.activeId].analytics;

    // 切换策略时重置基金显示开关
    if (state._activeKey !== state.activeId) {
      state._activeKey = state.activeId;
      state.showFunds = new Set(tradedFunds(state.strategies.find(s => s.id === state.activeId)));
    }
  }

  // ---------- 渲染 ----------
  function renderAll() {
    // 同步回溯查看日滑块
    const eng = state.activeEngine;
    if (eng && eng.dates.length) {
      const slider = $("viewSlider");
      slider.min = 0; slider.max = eng.dates.length - 1;
      if (!state.viewDate || eng.dates.indexOf(state.viewDate) < 0) {
        state.viewDate = eng.dates[eng.dates.length - 1];
      }
      slider.value = eng.dates.indexOf(state.viewDate);
      $("viewDateLabel").textContent = state.viewDate;
      $("holdDate").value = state.viewDate;
      updateViewVix();
    }
    renderTabs();
    renderMetrics();
    renderTradeList();
    renderTradeDetail();
    renderHoldings();
    renderAnalysis();
    renderMain();
    renderVIX();
    renderCompare();
    renderFundToggles();
    $("activeTag").textContent = state.strategies.find(s => s.id === state.activeId).name;
    // 同步全局输入框到当前策略
    const act = state.strategies.find(s => s.id === state.activeId);
    $("initialCapital").value = act.initialCapital;
    $("feeRate").value = (act.feeRate * 100).toFixed(2);
    $("benchmarkSelect").value = state.benchmarkCode;
  }

  function renderTabs() {
    const wrap = $("strategyTabs");
    wrap.innerHTML = "";
    state.strategies.forEach(st => {
      const tab = document.createElement("div");
      tab.className = "tab" + (st.id === state.activeId ? " active" : "");
      const name = document.createElement("span");
      name.textContent = st.name;
      name.onclick = () => { state.activeId = st.id; recomputeAll(); renderAll(); };
      tab.appendChild(name);
      const ren = document.createElement("button");
      ren.className = "tab-x"; ren.title = "重命名"; ren.textContent = "✎";
      ren.onclick = (e) => { e.stopPropagation(); const n = prompt("策略名称", st.name); if (n) { st.name = n; renderAll(); } };
      tab.appendChild(ren);
      if (state.strategies.length > 1) {
        const del = document.createElement("button");
        del.className = "tab-x"; del.title = "删除"; del.textContent = "✕";
        del.onclick = (e) => { e.stopPropagation(); if (confirm("删除策略「" + st.name + "」？")) { state.strategies = state.strategies.filter(s => s.id !== st.id); state.activeId = state.strategies[0].id; recomputeAll(); renderAll(); } };
        tab.appendChild(del);
      }
      wrap.appendChild(tab);
    });
  }

  function renderMetrics() {
    const a = state.activeAnalytics;
    const wrap = $("metricCards");
    if (!a || a.empty) { wrap.innerHTML = `<div class="empty">暂无数据，添加交易或运行自动策略后查看</div>`; return; }
    const eng = state.activeEngine;
    const hero = o =>
      `<div class="m-hero${o.primary ? " m-primary" : ""}">
         <div class="m-label">${o.label}</div>
         <div class="m-value ${o.cls || ""}"><span class="m-arrow">${o.dir >= 0 ? "▲" : "▼"}</span><span class="mv">${o.value}</span></div>
         ${o.sub ? `<div class="m-sub">${o.sub}</div>` : ""}
       </div>`;
    const spark = (eng && eng.equity) ? sparkSVG(eng.equity, { w: 260, h: 60 }) : "";
    const heroes =
      hero({ label: "区间收益率", value: pct(a.intervalReturn), dir: a.intervalReturn, primary: true, sub: `年化 <b class="mv">${pct(a.annualized)}</b>` }) +
      hero({ label: "最大回撤", value: pct(-a.mdd), cls: "neg", dir: -1 }) +
      hero({ label: "超额收益", value: pct(a.excess), cls: cls(a.excess), dir: a.excess });
    const top = `<div class="m-top"><div class="m-heroes">${heroes}</div>` +
      (spark ? `<div class="m-spark">${spark}<div class="m-spark-cap">资产曲线 · 期末 ¥${num(a.endAssets)}</div></div>` : "") + `</div>`;
    const chips = [
      { l: "基准收益(" + (a.benchmark ? a.benchmark.name : "—") + ")", v: pct(a.bmInterval), c: cls(a.bmInterval) },
      { l: "期末总资产", v: money(a.endAssets), c: "" },
      { l: "期末现金", v: money(a.endCash), c: "" },
      { l: "已实现盈亏", v: money(a.realizedTotal), c: cls(a.realizedTotal) },
      { l: "回撤持续", v: a.mddDuration + " 天", c: "" },
      { l: "区间天数", v: a.days + " 天", c: "" },
    ];
    wrap.innerHTML = top + `<div class="metric-grid">` +
      chips.map(c => `<div class="m-chip${c.c ? " " + c.c : ""}"><div class="m-chip-v mv">${c.v}</div><div class="m-chip-l">${c.l}</div></div>`).join("") +
      `</div>`;
    wrap.querySelectorAll(".mv").forEach(el => countUp(el));
  }

  function renderTradeList() {
    const st = state.strategies.find(s => s.id === state.activeId);
    const tb = $("tradeList").querySelector("tbody");
    tb.innerHTML = "";
    const sorted = st.trades.slice().sort((x, y) => x.date < y.date ? -1 : 1);
    if (!sorted.length) { tb.innerHTML = `<tr><td colspan="6" class="hint">尚无交易，请在上方添加</td></tr>`; return; }
    sorted.forEach(t => {
      const f = D.getFund(t.fundCode);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${t.date}</td><td>${f ? f.name : t.fundCode}</td>` +
        `<td class="${t.action === 'buy' ? 'pos' : 'neg'}">${t.action === 'buy' ? '买入' : '卖出'}</td>` +
        `<td>${t.action === 'sell' && t.clearAll ? '清仓' : money(t.amount)}</td>` +
        `<td>${t.clearAll ? '是' : '—'}</td>` +
        `<td><button class="btn tiny" data-del="${t.id}">删除</button></td>`;
      tb.appendChild(tr);
    });
    tb.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
      st.trades = st.trades.filter(x => x.id !== b.dataset.del);
      recomputeAll(); renderAll();
    });
  }

  function renderTradeDetail() {
    const a = state.activeAnalytics;
    const st = state.strategies.find(s => s.id === state.activeId);
    const feeRate = st ? st.feeRate : 0;
    const tb = $("tradeDetailTable").querySelector("tbody");
    tb.innerHTML = "";
    if (!a || a.empty || !a.tradeDetail.length) { tb.innerHTML = `<tr><td colspan="8" class="empty">暂无交易，请在「交易录入」添加或运行自动策略</td></tr>`; return; }
    a.tradeDetail.forEach(t => {
      const tr = document.createElement("tr");
      const amtRaw = (t.action === "sell" && t.clearAll)
        ? "清仓(全部)"
        : (t.unit === "layer" ? num(t.amount, 0) + " 层" : money(t.amount));
      const amt = (t.dca && t.action === "buy") ? "定投·" + amtRaw : amtRaw;

      // 盈亏与收益率：
      //  - 卖出：已实现盈亏（来自引擎）
      //  - 买入：以「查看日」净值估算持有期浮动盈亏（未实现），随查看日滑块变化
      let rp = "—", pp = "—", rpCls = "";
      if (t.realized != null) {
        rp = money(t.realized); rpCls = cls(t.realized);
        pp = t.pnlPct == null ? "—" : pct(t.pnlPct);
      } else if (t.action === "buy" && t.price) {
        const f = D.getFund(t.fundCode);
        const navView = f && state.viewDate >= t.date ? D.navOnOrBefore(f, state.viewDate) : null;
        if (navView != null) {
          // 已成交份额由引擎解出（t.shares），与单位（元/层仓）无关
          const shares = t.shares || 0;
          const floatPnl = shares * navView - shares * t.price;
          const floatPct = navView / t.price - 1;
          rpCls = cls(floatPnl);
          rp = `${money(floatPnl)} <span class="tag-float">浮</span>`;
          pp = pct(floatPct);
        }
      }

      const vv = D.vixOnOrBefore(t.date);
      const vcell = vv == null ? "—" : `<span class="vix-cell ${vixZone(vv)}">${vv.toFixed(1)}</span>`;
      tr.innerHTML = `<td>${t.date}</td><td>${t.fundName}</td>` +
        `<td class="${t.action === 'buy' ? 'pos' : 'neg'}">${t.action === 'buy' ? '买入' : '卖出'}</td>` +
        `<td>${amt}</td><td>${t.price == null ? '—' : num(t.price, 4)}</td>` +
        `<td class="${rpCls}">${rp}</td><td class="${rpCls}">${pp}</td>` +
        `<td>${vcell}</td>`;
      tb.appendChild(tr);
    });
  }

  // 日期加减（YYYY-MM-DD ± n 天）
  function addDays(dstr, n) {
    const d = new Date(dstr + "T00:00:00");
    d.setDate(d.getDate() + n);
    const pad = x => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function renderHoldings() {
    const eng = state.activeEngine;
    const tb = $("holdingsTable").querySelector("tbody");
    tb.innerHTML = "";
    const foot = $("holdTotalRow");
    const snap = (eng && eng.positionsByDate[state.viewDate]) || {};
    const codes = Object.keys(snap);
    if (!codes.length) {
      tb.innerHTML = `<tr><td colspan="9" class="empty">查看日（${state.viewDate}）无持仓</td></tr>`;
      foot.innerHTML = ""; $("holdSummary").innerHTML = "";
      return;
    }
    const prevDate = addDays(state.viewDate, -1); // 前一交易日（连续轴下即昨日，周末兜底到上周五）
    let totMv = 0, totPnl = 0, totCost = 0, totDay = 0;
    const rows = codes.map(code => {
      const p = snap[code];
      const f = D.getFund(code);
      const navPrev = f ? D.navOnOrBefore(f, prevDate) : null;
      const dayPnl = (navPrev != null) ? p.shares * (p.nav - navPrev) : 0; // 当日盈亏：净值变动 × 份额
      totMv += p.mv; totPnl += p.pnl; totCost += p.costValue; totDay += dayPnl;
      return { p, dayPnl };
    }).sort((a, b) => b.p.mv - a.p.mv); // 市值大者在前

    rows.forEach(({ p, dayPnl }) => {
      const ratio = totMv > 1e-9 ? (p.mv / totMv * 100) : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${p.name}</td><td>${num(p.shares, 2)}</td><td>${num(p.avgCost, 4)}</td>` +
        `<td>${num(p.nav, 4)}</td>` +
        `<td class="${cls(dayPnl)}">${money(dayPnl)}</td>` +
        `<td>${money(p.mv)}</td>` +
        `<td><div class="bar"><span style="width:${ratio.toFixed(1)}%"></span></div><small>${ratio.toFixed(1)}%</small></td>` +
        `<td class="${cls(p.pnl)}">${money(p.pnl)}</td>` +
        `<td class="${cls(p.pnlPct)}">${pct(p.pnlPct)}</td>`;
      tb.appendChild(tr);
    });

    // 汇总行
    const totPct = totCost > 1e-9 ? totPnl / totCost : 0;
    foot.innerHTML =
      `<td colspan="4"><b>合计（${codes.length} 只）</b></td>` +
      `<td class="${cls(totDay)}"><b>${money(totDay)}</b></td>` +
      `<td><b>${money(totMv)}</b></td><td></td>` +
      `<td class="${cls(totPnl)}"><b>${money(totPnl)}</b></td>` +
      `<td class="${cls(totPct)}"><b>${pct(totPct)}</b></td>`;

    // 查看日盈亏概览卡片
    $("holdSummary").innerHTML =
      `<div class="hsum"><span class="hl">查看日总市值</span><b>${money(totMv)}</b></div>` +
      `<div class="hsum"><span class="hl">当日盈亏</span><b class="${cls(totDay)}">${money(totDay)}</b></div>` +
      `<div class="hsum"><span class="hl">累计浮动盈亏</span><b class="${cls(totPnl)}">${money(totPnl)}</b></div>` +
      `<div class="hsum"><span class="hl">总收益率</span><b class="${cls(totPct)}">${pct(totPct)}</b></div>`;
  }

  // 某组交易的「平均 VIX」（用于交易复盘：低买高卖）
  function meanVix(list) {
    let s = 0, n = 0;
    list.forEach(t => { const v = D.vixOnOrBefore(t.date); if (v != null) { s += v; n++; } });
    return n ? s / n : null;
  }

  // 智能分析板块（基于当前查看日）
  function renderAnalysis() {
    const eng = state.activeEngine, a = state.activeAnalytics;
    const wrap = $("analysisWrap");
    if (!eng || !a || a.empty) { wrap.innerHTML = `<div class="empty">暂无数据，添加交易或运行自动策略后查看</div>`; return; }
    $("analysisDate").textContent = state.viewDate;
    const idx = eng.dates.indexOf(state.viewDate);
    const snap = (eng.positionsByDate[state.viewDate]) || {};
    const codes = Object.keys(snap);
    let totMv = 0, totPnl = 0, totCost = 0;
    codes.forEach(code => { const p = snap[code]; totMv += p.mv; totPnl += p.pnl; totCost += p.costValue; });
    const cash = eng.cash[idx] || 0;
    const totalAssets = cash + totMv;
    const cashRatio = totalAssets > 1e-9 ? cash / totalAssets : 0;
    let maxWeight = 0;
    codes.forEach(code => { const p = snap[code]; const w = totMv > 1e-9 ? p.mv / totMv : 0; if (w > maxWeight) maxWeight = w; });
    const tw = (eng.twrr && eng.twrr[idx] != null) ? eng.twrr[idx] / 100 - 1 : 0;

    // VIX 环境判读
    const v = D.vixOnOrBefore(state.viewDate);
    let zone = "—", zoneCls = "", advice = "无 VIX 数据";
    if (v != null) {
      if (v >= 40) { zone = "极度恐慌"; zoneCls = "panic"; advice = "历史极端区，若现金充裕可分批加仓，但需控仓位、防继续下杀。"; }
      else if (v >= 30) { zone = "恐慌"; zoneCls = "high"; advice = "恐慌区，权益资产性价比高，可逢低布局，避免一把梭。"; }
      else if (v >= 20) { zone = "正常"; zoneCls = "norm"; advice = "市场平稳，按既定策略持有 / 定投即可。"; }
      else { zone = "平静"; zoneCls = "calm"; advice = "低波动环境，可适度获利了结或再平衡，警惕拥挤交易。"; }
    }

    // 策略表现
    const buys = a.tradeDetail.filter(t => t.action === "buy").length;
    const sells = a.tradeDetail.filter(t => t.action === "sell").length;
    const closed = a.tradeDetail.filter(t => t.action === "sell" && t.realized != null);
    const win = closed.filter(t => t.realized > 0).length;
    const winRate = closed.length ? win / closed.length : 0;

    // 交易复盘
    const vixBuy = meanVix(a.tradeDetail.filter(t => t.action === "buy"));
    const vixSell = meanVix(a.tradeDetail.filter(t => t.action === "sell"));
    const lowBuyHighSell = (vixBuy != null && vixSell != null && vixBuy > vixSell);

    const card = (title, rows) =>
      `<div class="ac-card"><div class="ac-title">${title}</div><div class="ac-rows">` +
      rows.map(r => `<div class="ac-row"><span class="ac-k">${r[0]}</span><b class="ac-v ${r[2] || ""}">${r[1]}</b></div>`).join("") +
      `</div></div>`;

    const diagnoseRows = [
      ["查看日总资产", money(totalAssets), ""],
      ["持仓市值", money(totMv), ""],
      ["现金", money(cash), ""],
      ["现金占比", pct(cashRatio), cashRatio > 0.5 ? "neg" : ""],
      ["累计浮动盈亏", money(totPnl), cls(totPnl)],
      ["组合收益率(TWRR)", pct(tw), cls(tw)],
      ["最大单一持仓", (maxWeight * 100).toFixed(1) + "%", maxWeight > 0.5 ? "neg" : (maxWeight > 0.3 ? "" : "")],
    ];
    const zoneRows = [
      ["查看日 VIX", v == null ? "—" : v.toFixed(1), "vix-" + zoneCls],
      ["环境判定", zone, "vix-" + zoneCls],
      ["配置建议", advice, ""],
    ];
    const perfRows = [
      ["区间收益", pct(a.intervalReturn), cls(a.intervalReturn)],
      ["年化", pct(a.annualized), cls(a.annualized)],
      ["最大回撤", pct(-a.mdd), "neg"],
      ["买卖笔数", buys + " 买 / " + sells + " 卖", ""],
      ["近似胜率", closed.length ? pct(winRate) : "—", cls(winRate)],
    ];
    const reviewRows = [
      ["买点平均 VIX", vixBuy == null ? "—" : vixBuy.toFixed(1), "vix-" + vixZone(vixBuy)],
      ["卖点平均 VIX", vixSell == null ? "—" : vixSell.toFixed(1), "vix-" + vixZone(vixSell)],
      ["低买高卖?", lowBuyHighSell ? "是 ✓" : (vixBuy != null && vixSell != null ? "否 ✗" : "—"), lowBuyHighSell ? "pos" : ""],
    ];
    const riskRows = [
      ["集中度(最大持仓)", (maxWeight * 100).toFixed(1) + "%", maxWeight > 0.5 ? "neg" : ""],
      ["现金闲置率", pct(cashRatio), cashRatio > 0.5 ? "neg" : ""],
      ["期末现金", money(a.endCash), ""],
    ];

    // 投资建议（综合 VIX 环境 / 现金 / 集中度 / 择时有效性，给出可操作建议）
    const advList = [];
    if (v != null) {
      if (v >= 40) advList.push(["极端恐慌区，若现金充裕建议<strong>分批小额定投 / 加仓</strong>，但务必控仓位、防继续下杀。", "warn"]);
      else if (v >= 30) advList.push(["处于恐慌区，权益资产性价比高，建议<strong>逢低布局 / 执行定投</strong>，避免一次性重仓。", "good"]);
      else if (v >= 20) advList.push(["市场平稳，建议<strong>按既定策略持有与定投</strong>即可，不追涨杀跌。", ""]);
      else advList.push(["低波动平静期，警惕拥挤交易，可适当<strong>获利了结 / 再平衡</strong>。", "warn"]);
    }
    if (cashRatio > 0.5) advList.push(["现金占比偏高（" + (cashRatio * 100).toFixed(0) + "%），资金效率偏低，建议<strong>加大投入（定投或择机加仓）</strong>。", "warn"]);
    else if (cashRatio < 0.05 && codes.length) advList.push(["几乎满仓（现金占比 " + (cashRatio * 100).toFixed(0) + "%），需<strong>留足现金</strong>应对波动与补仓机会。", "warn"]);
    if (maxWeight > 0.5) advList.push(["单一持仓集中度过高（" + (maxWeight * 100).toFixed(0) + "%），建议<strong>分散或再平衡</strong>以降低风险。", "warn"]);
    if (lowBuyHighSell) advList.push(["当前策略「低 VIX 买、高 VIX 卖」特征成立，说明<strong>恐慌买入、平静止盈</strong>的纪律有效，建议坚持。", "good"]);
    else if (vixBuy != null && vixSell != null) advList.push(["当前策略暂未呈现「低买高卖」特征，建议复盘买卖时点，避免<strong>追高杀低</strong>。", "warn"]);
    if (!advList.length) advList.push(["暂无显著信号，建议保持现有仓位与定投节奏。", ""]);
    const adviceCard = `<div class="ac-card ac-advice"><div class="ac-title">投资建议</div><ul class="advice-list">` +
      advList.map(([txt, c]) => `<li class="${c || ""}">${txt}</li>`).join("") + `</ul></div>`;

    // 策略点评（AI 视角）：基于当前策略的实际成交 + 回测，给出定性判断与改进建议
    const stx = state.strategies.find(s => s.id === state.activeId);
    const rawT = stx ? stx.trades : [];
    const vixBuys = rawT.filter(t => t.action === "buy" && t.src === "vix");
    const dcaBuys = rawT.filter(t => t.action === "buy" && t.dca);
    const vixSells = rawT.filter(t => t.action === "sell" && t.src === "vix");
    const hasVix = vixBuys.length > 0 || vixSells.length > 0;
    const hasDca = dcaBuys.length > 0;
    const fmtSize = t => t.unit === "layer" ? (t.amount + " 层") : ("¥" + (+t.amount).toLocaleString("zh-CN"));
    const vAt = d => { const x = D.vixOnOrBefore(d); return x == null ? null : x; };
    const meanA = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
    const vBuy = meanA(vixBuys.map(t => vAt(t.date)).filter(x => x != null));
    const vSell = meanA(vixSells.map(t => vAt(t.date)).filter(x => x != null));
    const typeLabel = (hasVix && hasDca) ? "VIX 恐慌择时 + 纪律定投（混合）"
      : hasVix ? "VIX 恐慌择时策略"
      : hasDca ? "定期定额（定投）策略" : "手动交易策略";

    let lead;
    if (hasVix && hasDca) lead = "我怎么看：这是一套「恐慌抄底 + 纪律定投」的组合——平时靠定投平滑成本，市场恐慌（VIX 高）时分批加仓、情绪平复（VIX 低）时减仓。本质是<strong>逆势布局 + 机械定投</strong>的低位吸筹思路。";
    else if (hasVix) lead = "我怎么看：这是一套纯 VIX 恐慌择时策略——只在市场恐慌（VIX 高于阈值）时买入、平静（VIX 低于阈值）时卖出，靠情绪周期赚估值修复的钱。";
    else if (hasDca) lead = "我怎么看：这是一套纯定投策略——不预测市场，按固定节奏分批买入，用时间平滑成本、规避择时错误，适合没时间盯盘的人。";
    else lead = "我怎么看：当前策略以手动交易为主，没有自动 VIX / 定投规则，下面给整体表现与风险提示。";

    const qual = [`类型：<strong>${typeLabel}</strong>`];
    if (vBuy != null) qual.push(`买点平均 VIX <b class="vix-${vixZone(vBuy)}">${vBuy.toFixed(1)}</b>`);
    if (vSell != null) qual.push(`卖点平均 VIX <b class="vix-${vixZone(vSell)}">${vSell.toFixed(1)}</b>`);
    if (vixBuys[0]) qual.push(`VIX 抄底单次：${fmtSize(vixBuys[0])}${vixBuys.length > 1 ? ` ×${vixBuys.length}笔` : ""}`);
    if (dcaBuys[0]) qual.push(`定投每期：${fmtSize(dcaBuys[0])}${dcaBuys.length > 1 ? ` ×${dcaBuys.length}期` : ""}`);

    const pros = [];
    if (hasVix) pros.push("逆势布局，利用恐慌情绪低买——历史上恐慌区买入的胜率与赔率通常优于追涨。");
    if (hasDca) pros.push("定投提供机械纪律，克服「追涨杀跌」的人性弱点，成本被市场波动自然摊平。");
    if (lowBuyHighSell) pros.push("回测呈现「低 VIX 买、高 VIX 卖」特征，说明择时纪律有效，确实买得相对便宜、卖得相对贵。");
    if (a.excess != null && a.excess > 0) pros.push(`区间超额收益 <strong>${pct(a.excess)}</strong>，跑赢基准 ${a.benchmark ? a.benchmark.name : "—"}，这套节奏在该样本里是赚钱的。`);
    else if (a.excess != null && a.excess < 0) pros.push(`区间超额收益 ${pct(a.excess)}，落后基准——这个样本里择时没占到便宜，警惕<strong>过拟合</strong>。`);

    const risks = [];
    if (vBuy != null && vBuy < 25) risks.push(`买点平均 VIX 仅 <b>${vBuy.toFixed(1)}</b>，阈值可能偏低——容易在「假恐慌」里频繁买入、磨损手续费。建议买阈值 ≥ 25~30，只在真正恐慌时出手。`);
    if (vSell != null && vSell < 20) risks.push(`卖点平均 VIX <b>${vSell.toFixed(1)}</b>，若牛市延长可能过早清仓踏空。可考虑提高卖阈值，或改为「只减仓不空仓」。`);
    if (maxWeight > 0.5) risks.push(`单一标的集中度 <b>${(maxWeight * 100).toFixed(0)}%</b> 偏高，黑天鹅下回撤会被放大。建议单标的 ≤ 60%，多配 1~2 只分散。`);
    if (cashRatio > 0.5) risks.push(`期末现金占比 <b>${(cashRatio * 100).toFixed(0)}%</b> 偏高，资金利用效率低——定投 / 加仓节奏可以更快。`);
    else if (cashRatio < 0.05 && codes.length) risks.push(`几乎满仓，缺少应对极端下杀的「子弹」，建议常留 ≥ 20% 现金。`);
    if (a.mdd > 0.3) risks.push(`最大回撤 <b>${pct(-a.mdd)}</b> 较深，下行保护不足。可叠加 VIX 高位减仓，或设定回撤止损线。`);
    if (hasDca && !hasVix) risks.push(`定投虽稳，但单边下跌市会「越跌越买」放大浮亏。建议定投为主，VIX 抄底作小幅加速器，而非重仓赌恐慌。`);
    if (!risks.length) risks.push("未见明显风险点，保持现有节奏与再平衡即可。");

    const reviewCard = `<div class="ac-card ac-strategy"><div class="ac-title">策略点评（AI 视角）</div>` +
      `<p class="ac-lead">${lead}</p>` +
      `<div class="ac-cols">` +
        `<div class="ac-col"><div class="ac-sub">定性</div><ul class="ac-bul">${qual.map(x => `<li>${x}</li>`).join("")}</ul></div>` +
        `<div class="ac-col"><div class="ac-sub pos">亮点</div><ul class="ac-bul pos">${pros.length ? pros.map(x => `<li>${x}</li>`).join("") : "<li>—</li>"}</ul></div>` +
        `<div class="ac-col"><div class="ac-sub neg">风险与改进</div><ul class="ac-bul neg">${risks.map(x => `<li>${x}</li>`).join("")}</ul></div>` +
      `</div></div>`;

    const envBand = `<div class="ac-env vix-${zoneCls}">
      <div class="ac-env-main">
        <div class="ac-env-zone"><span class="ac-env-label">查看日 VIX 环境</span><span class="ac-env-val">${v == null ? "无数据" : v.toFixed(1) + " · " + zone}</span></div>
        <div class="ac-env-advice">${advice}</div>
      </div>
      <div class="ac-env-vix">${v == null ? "—" : v.toFixed(1)}</div>
    </div>`;
    wrap.innerHTML =
      envBand +
      card("持仓诊断", diagnoseRows) +
      card("策略表现", perfRows) +
      card("交易复盘", reviewRows) +
      card("风险提示", riskRows) +
      reviewCard +
      adviceCard;
  }

  function renderFundToggles() {
    const wrap = $("fundToggles");
    const funds = tradedFunds(state.strategies.find(s => s.id === state.activeId));
    wrap.innerHTML = "";
    funds.forEach(code => {
      const f = D.getFund(code); if (!f) return;
      const lab = document.createElement("label");
      lab.className = "chk";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = state.showFunds.has(code);
      cb.onchange = () => { cb.checked ? state.showFunds.add(code) : state.showFunds.delete(code); renderMain(); };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" " + f.name));
      wrap.appendChild(lab);
    });
  }

  function nearestIdx(dates, date) {
    let lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  // 交易日期对应的 VIX 读数（用于择时参考）
  function updateTradeVix() {
    const v = D.vixOnOrBefore($("tradeDate").value);
    const el = $("tradeVix");
    if (v == null) { el.textContent = "VIX —"; el.className = "vix-readout"; return; }
    const z = vixZone(v);
    const zlabel = z === "calm" ? "平静" : z === "norm" ? "正常" : z === "high" ? "偏高" : "恐慌";
    el.textContent = `VIX ${v.toFixed(1)} · ${zlabel}`;
    el.className = "vix-readout " + z;
  }

  // 回溯查看日 VIX 实时读数（跟随滑块）
  function updateViewVix() {
    const el = $("viewVix");
    if (!el) return;
    const v = D.vixOnOrBefore(state.viewDate);
    if (v == null) { el.textContent = "VIX —"; el.className = "vix-readout"; return; }
    const z = vixZone(v);
    const zlabel = z === "calm" ? "平静" : z === "norm" ? "正常" : z === "high" ? "偏高" : "恐慌";
    el.textContent = `查看日 VIX ${v.toFixed(1)} · ${zlabel}`;
    el.className = "vix-readout " + z;
  }

  // 在窗口内找出 VIX 最高的「最恐慌日」填入交易日期
  function fillPanicDate() {
    const arr = D.getVIX();
    if (!arr || !arr.length) return;
    let best = null, bestV = -1;
    for (const x of arr) {
      if (x.d < state.startDate || x.d > state.endDate) continue;
      if (x.v > bestV) { bestV = x.v; best = x.d; }
    }
    if (best) { $("tradeDate").value = best; updateTradeVix(); }
  }

  // 点击主图买卖点 → 跳转到该交易日的查看视图（联动持仓/明细/主图/VIX）
  window.FS.setViewDate = function (d) {
    if (!d) return;
    const eng = state.activeEngine;
    if (!eng || !eng.dates.length) return;
    if (d < state.startDate) d = state.startDate;
    if (d > state.endDate) d = state.endDate;
    state.viewDate = d;
    const idx = eng.dates.indexOf(d);
    if (idx < 0) return;
    const slider = $("viewSlider");
    if (slider) slider.value = idx;
    $("viewDateLabel").textContent = d;
    $("holdDate").value = d;
    renderHoldings(); renderTradeDetail(); renderMain(); renderVIX(); updateViewVix();
  };

  function buildMainData() {
    const eng = state.activeEngine, a = state.activeAnalytics;
    const dates = eng.dates;
    // 组合走势采用「时间加权收益指数」（基准100），只反映投入资金的表现，
    // 不再被账户里的闲置现金稀释而恒等于 100。
    const portfolio = (eng.twrr && eng.twrr.length)
      ? eng.twrr.slice()
      : eng.equity.map(v => v / (eng.equity[0] || 1) * 100);
    let benchmark = null;
    if (eng.benchmark) {
      benchmark = { name: eng.benchmark.name, data: eng.benchmark.equity.map(v => v / (eng.benchmark.equity[0] || 1) * 100) };
    }
    const funds = [...state.showFunds].map(code => {
      const f = D.getFund(code); if (!f) return null;
      const n0 = D.navOnOrBefore(f, dates[0]) || 1;
      return { name: f.name, data: dates.map(d => { const n = D.navOnOrBefore(f, d); return n ? n / n0 * 100 : null; }) };
    }).filter(Boolean);

    const markers = [];
    if (a && a.tradeDetail) {
      a.tradeDetail.forEach(t => {
        const idx = nearestIdx(dates, t.date); // 落在最近交易日，避免周末交易丢失标记
        if (idx < 0) return;
        markers.push({
          date: dates[idx], value: portfolio[idx], type: t.action,
          nav: t.price, fundName: t.fundName, amount: t.amount, unit: t.unit, clearAll: t.clearAll,
        });
      });
    }
    const vixByDate = {};
    dates.forEach(d => { const v = D.vixOnOrBefore(d); if (v != null) vixByDate[d] = v; });
    return { dates, portfolio, benchmark, funds, markers, viewDate: state.viewDate, vixByDate };
  }

  function renderMain() {
    const cfg = buildMainData();
    if (!mainChart) mainChart = C.renderMain($("mainChart"), cfg);
    else { mainChart.clear(); C.renderMain($("mainChart"), cfg); }
  }

  // VIX 恐慌指数子图
  function buildVIXData() {
    const eng = state.activeEngine;
    const dates = eng.dates;
    const vix = dates.map(d => D.vixOnOrBefore(d));
    // 启用自动交易时，把各条件的 VIX 阈值线传给图表，便于对照
    let buyThresholds = [], sellThresholds = [];
    if ($("autoEnabled").checked) {
      document.querySelectorAll("#autoCondBody tr").forEach(tr => {
        const action = tr.querySelector(".ac-action").value;
        const v = +tr.querySelector(".ac-vix").value;
        if (!(v > 0)) return;
        if (action === "buy") buyThresholds.push(v);
        else if (action === "sell") sellThresholds.push(v);
      });
    }
    return { dates, vix, viewDate: state.viewDate, buyThresholds, sellThresholds };
  }
  function renderVIX() {
    if (!$("vixToggle").checked || !state.activeEngine || !state.activeEngine.dates.length) return;
    const cfg = buildVIXData();
    if (!vixChart) vixChart = C.renderVIX($("vixChart"), cfg);
    else { vixChart.clear(); C.renderVIX($("vixChart"), cfg); }
  }

  function renderCompare() {
    const dates = state.activeEngine.dates;
    const strs = state.strategies.map(st => {
      const eng = state.results[st.id].engine;
      const data = (eng.twrr && eng.twrr.length)
        ? eng.twrr.slice()
        : eng.equity.map(v => v / (eng.equity[0] || 1) * 100);
      return { name: st.name, data };
    });
    let benchmark = null;
    const beng = state.activeEngine.benchmark;
    if (beng) benchmark = { name: beng.name, data: beng.equity.map(v => v / beng.equity[0] * 100) };
    const activeName = state.strategies.find(s => s.id === state.activeId).name;
    if (!compareChart) compareChart = C.renderCompare($("compareChart"), { dates, strategs: strs, benchmark, activeName });
    else { compareChart.clear(); C.renderCompare($("compareChart"), { dates, strategs: strs, benchmark, activeName }); }

    // 对比表
    const cols = [
      { k: "name", l: "策略" },
      { k: "intervalReturn", l: "区间收益", f: pct, c: cls },
      { k: "annualized", l: "年化", f: pct, c: cls },
      { k: "mdd", l: "最大回撤", f: x => pct(-x), c: () => "neg" },
      { k: "bmInterval", l: "基准收益", f: pct, c: cls },
      { k: "excess", l: "超额收益", f: pct, c: cls },
      { k: "endAssets", l: "期末资产", f: money, c: () => "" },
    ];
    let html = "<table class='tbl'><thead><tr>" + cols.map(c => `<th>${c.l}</th>`).join("") + "</tr></thead><tbody>";
    state.strategies.forEach(st => {
      const a = state.results[st.id].analytics;
      html += "<tr>" + cols.map(c => {
        if (c.k === "name") return `<td><b>${st.id === state.activeId ? "▶ " : ""}${st.name}</b></td>`;
        const v = a[c.k]; const txt = c.f ? c.f(v) : v;
        return `<td class="${c.c(v)}">${txt}</td>`;
      }).join("") + "</tr>";
    });
    html += "</tbody></table>";
    $("compareTableWrap").innerHTML = html;
  }

  // ---------- 事件 ----------
  function bindEvents() {
    $("applyBtn").onclick = () => {
      state.startDate = $("startDate").value;
      state.endDate = $("endDate").value;
      state.benchmarkCode = $("benchmarkSelect").value;
      const act = state.strategies.find(s => s.id === state.activeId);
      act.initialCapital = Math.max(0, +$("initialCapital").value || 0);
      act.feeRate = Math.max(0, (+$("feeRate").value || 0) / 100);
      if (state.viewDate < state.startDate || state.viewDate > state.endDate) state.viewDate = state.endDate;
      recomputeAll(); renderAll();
    };
    $("resetBtn").onclick = () => {
      D.registry && Object.keys(D.registry).forEach(k => delete D.registry[k]);
      D.loadSample(); refreshFundSelect(); refreshFundList();
      const range = D.dateRange();
      state.startDate = "2021-01-01"; state.endDate = range.max;
      state.benchmarkCode = (D.getBenchmark() || {}).code || "";
      $("startDate").value = state.startDate; $("endDate").value = state.endDate;
      $("benchmarkSelect").value = state.benchmarkCode;
      seedStrategies(); state._activeKey = null;
      recomputeAll(); renderAll();
    };

    $("addStrategyBtn").onclick = () => {
      const n = state.strategies.length + 1;
      const st = { id: uid(), name: "策略" + n, initialCapital: 100000, feeRate: 0.0015, trades: [] };
      state.strategies.push(st); state.activeId = st.id; state._activeKey = null;
      recomputeAll(); renderAll();
    };

    $("tradeForm").onsubmit = (e) => {
      e.preventDefault();
      const fundCode = $("tradeFund").value;
      const action = document.querySelector('input[name="action"]:checked').value;
      const date = $("tradeDate").value;
      const amount = +$("tradeAmount").value || 0;
      const clearAll = $("tradeClearAll").checked;
      if (!date) return alert("请选择交易日期");
      if (action === "buy" && amount <= 0) return alert("买入金额需大于0");
      const st = state.strategies.find(s => s.id === state.activeId);
      st.trades.push({ id: uid(), fundCode, action, date, amount, clearAll });
      $("tradeAmount").value = "";
      $("tradeClearAll").checked = false;
      recomputeAll(); renderAll();
    };

    // 查看日滑块
    const slider = $("viewSlider");
    slider.oninput = () => {
      const eng = state.activeEngine;
      const idx = +slider.value;
      state.viewDate = eng.dates[idx];
      $("viewDateLabel").textContent = state.viewDate;
      $("holdDate").value = state.viewDate;
      renderHoldings();
      renderTradeDetail();
      renderMain();
      renderVIX();
      updateViewVix();
    };

    // 独立日期选择器（与滑块双向联动，可直选任意一天，含周末）
    $("holdDate").onchange = () => {
      const v = $("holdDate").value;
      if (!v) return;
      const clamped = v < state.startDate ? state.startDate : (v > state.endDate ? state.endDate : v);
      state.viewDate = clamped;
      const eng = state.activeEngine;
      let idx = eng.dates.indexOf(clamped);
      if (idx < 0) idx = nearestIdx(eng.dates, clamped); // 兜底（连续日历日下不会触发）
      $("viewSlider").value = idx >= 0 ? idx : 0;
      $("viewDateLabel").textContent = state.viewDate;
      renderHoldings();
      renderTradeDetail();
      renderMain();
      renderVIX();
      updateViewVix();
    };

    // 交易日期变化 → 实时 VIX 读数（择时参考）
    $("tradeDate").onchange = updateTradeVix;
    $("tradeDate").oninput = updateTradeVix;
    $("panicBtn").onclick = fillPanicDate;
    $("vixToggle").onchange = () => {
      $("vixWrap").style.display = $("vixToggle").checked ? "" : "none";
      renderVIX();
    };

    // VIX 自动交易（独立开关）
    $("autoEnabled").onchange = () => {
      const on = $("autoEnabled").checked;
      $("autoBody").style.display = on ? "" : "none";
      if (on) {
        $("autoStart").value = state.startDate;
        $("autoEnd").value = state.endDate;
        seedAutoConds();
        runVixAuto(true);
      }
    };
    $("autoRun").onclick = () => runVixAuto(true);
    $("autoAdd").onclick = () => runVixAuto(false);
    $("autoAddCond").onclick = () => addCondRow();
    // 定投（独立开关，不依赖自动交易）
    $("dcaEnabled").onchange = () => {
      const on = $("dcaEnabled").checked;
      $("dcaBody").style.display = on ? "" : "none";
      if (on) {
        $("dcaStart").value = state.startDate;
        $("dcaEnd").value = state.endDate;
        runDca(true);
      }
    };
    $("dcaRun").onclick = () => runDca(true);
    $("dcaAdd").onclick = () => runDca(false);
    // 定投频率切换：仅「每N交易日」需要填间隔
    $("dcaFreq").onchange = () => { $("dcaNWrap").style.display = $("dcaFreq").value === "ndays" ? "" : "none"; };

    // CSV 导入
    $("impBtn").onclick = () => {
      const file = $("impFile").files[0]; if (!file) return alert("请选择 CSV 文件");
      const reader = new FileReader();
      reader.onload = () => {
        const navs = D.parseCSV(reader.result);
        if (!navs.length) return ($("impStatus").textContent = "解析失败：未识别到 日期,净值 两列");
        const name = $("impName").value || file.name;
        const code = $("impCode").value || ("IMP" + Date.now());
        D.addFund(name, code, navs, $("impBench").checked);
        refreshFundSelect(); refreshFundList();
        $("benchmarkSelect").innerHTML = "";
        D.listFunds().forEach(f => { const o = document.createElement("option"); o.value = f.code; o.textContent = f.name + (f.isBenchmark ? " (基准)" : ""); if (f.isBenchmark) { o.selected = true; state.benchmarkCode = f.code; } $("benchmarkSelect").appendChild(o); });
        $("impStatus").textContent = `已导入 ${name}（${navs.length} 条）`;
        recomputeAll(); renderAll();
      };
      reader.readAsText(file, "utf-8");
    };

    // 在线抓取
    $("fetchBtn").onclick = async () => {
      const code = $("fetchCode").value.trim(); if (!code) return alert("请输入基金代码");
      const s = $("fetchStart").value || state.startDate;
      const e = $("fetchEnd").value || state.endDate;
      $("fetchStatus").textContent = "抓取中…";
      try {
        const navs = await D.fetchFundJSONP(code, s, e);
        const name = (D.getFund(code) || {}).name || ("基金" + code);
        D.addFund(name, code, navs, false);
        refreshFundSelect(); refreshFundList(); recomputeAll(); renderAll();
        $("fetchStatus").textContent = `成功 ${navs.length} 条`;
      } catch (err) {
        $("fetchStatus").textContent = "失败：" + err.message + "（请改用 CSV 导入）";
      }
    };

    // 导出/导入策略
    $("exportBtn").onclick = () => {
      const st = state.strategies.find(s => s.id === state.activeId);
      const payload = { name: st.name, initialCapital: st.initialCapital, feeRate: st.feeRate, startDate: state.startDate, endDate: state.endDate, benchmarkCode: state.benchmarkCode, trades: st.trades };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = st.name + ".json"; a.click();
    };
    $("importStrategyFile").onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const p = JSON.parse(reader.result);
          const st = { id: uid(), name: p.name || "导入策略", initialCapital: p.initialCapital || 100000, feeRate: p.feeRate || 0.0015, trades: (p.trades || []).map(t => ({ id: uid(), ...t })) };
          state.strategies.push(st); state.activeId = st.id; state._activeKey = null;
          if (p.startDate) { state.startDate = p.startDate; $("startDate").value = p.startDate; }
          if (p.endDate) { state.endDate = p.endDate; $("endDate").value = p.endDate; }
          if (p.benchmarkCode) { state.benchmarkCode = p.benchmarkCode; $("benchmarkSelect").value = p.benchmarkCode; }
          recomputeAll(); renderAll();
        } catch (err) { alert("导入失败：" + err.message); }
      };
      reader.readAsText(file);
    };

    window.addEventListener("resize", () => { if (mainChart) mainChart.resize(); if (compareChart) compareChart.resize(); });
  }

  // ---------- 启动 ----------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
