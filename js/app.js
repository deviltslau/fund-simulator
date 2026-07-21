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
    seedAutoConds();
    // 自动交易默认区间 = 全局区间
    $("autoStart").value = state.startDate;
    $("autoEnd").value = state.endDate;
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
          trades.push({ id: uid(), fundCode: p.fundCode, action: "sell", date: d, amount: c.amount, unit: c.unit, clearAll: false });
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
          trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: c.amount, unit: c.unit, clearAll: false });
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
              trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: amt, unit: "layer", dca: true, clearAll: false });
              cash -= sp; sharesHeld += sp * (1 - feeRate) / nav; buys++;
            }
          } else {
            if (amt <= cash + 1e-6) {
              trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: amt, unit: "cash", dca: true, clearAll: false });
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

  // createNew=true：创建/替换一个 VIX 自动策略；false：追加到当前策略
  function runAuto(createNew) {
    const p = readAutoParams();
    if (!p.fundCode) return;
    if (!p.conditions.length) return alert("请至少添加一条有效条件（需填写 VIX 阈值与金额）。");
    if (!p.conditions.some(c => c.action === "buy")) return alert("至少需要一条买入条件。");
    const { trades, log } = generateVixTrades(p);
    if (!trades.length) { $("autoStatus").textContent = "未生成任何交易：" + log; return; }
    if (createNew) {
      const f = D.getFund(p.fundCode);
      const name = "VIX自动·" + (f ? f.name : p.fundCode);
      let st = state.strategies.find(s => s.name === name);
      if (!st) {
        st = { id: uid(), name, initialCapital: p.initialCapital, feeRate: p.feeRate, trades: [] };
        state.strategies.push(st);
      } else {
        st.trades = []; st.initialCapital = p.initialCapital; st.feeRate = p.feeRate;
      }
      trades.forEach(t => st.trades.push(t));
      state.activeId = st.id; state._activeKey = null;
    } else {
      const st = state.strategies.find(s => s.id === state.activeId);
      trades.forEach(t => st.trades.push(t));
    }
    recomputeAll(); renderAll();
    $("autoStatus").textContent = (createNew ? "已生成策略：" : "已追加到当前策略：") + log;
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
    if (!a || a.empty) { wrap.innerHTML = "<p class='hint'>暂无数据</p>"; return; }
    const cards = [
      { l: "区间收益率", v: pct(a.intervalReturn), c: cls(a.intervalReturn) },
      { l: "年化收益率", v: pct(a.annualized), c: cls(a.annualized) },
      { l: "最大回撤", v: pct(-a.mdd), c: "neg" },
      { l: "回撤持续", v: a.mddDuration + " 天", c: "" },
      { l: "基准收益(" + (a.benchmark ? a.benchmark.name : "—") + ")", v: pct(a.bmInterval), c: cls(a.bmInterval) },
      { l: "超额收益", v: pct(a.excess), c: cls(a.excess) },
      { l: "期末总资产", v: money(a.endAssets), c: "" },
      { l: "期末现金", v: money(a.endCash), c: "" },
      { l: "已实现盈亏", v: money(a.realizedTotal), c: cls(a.realizedTotal) },
      { l: "区间天数", v: a.days + " 天", c: "" },
    ];
    wrap.innerHTML = cards.map(c =>
      `<div class="metric ${c.c}"><div class="mv">${c.v}</div><div class="ml">${c.l}</div></div>`).join("");
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
    if (!a || a.empty || !a.tradeDetail.length) { tb.innerHTML = `<tr><td colspan="8" class="hint">暂无交易</td></tr>`; return; }
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
      tb.innerHTML = `<tr><td colspan="9" class="hint">查看日(${state.viewDate}) 无持仓</td></tr>`;
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
    if (!eng || !a || a.empty) { wrap.innerHTML = "<p class='hint'>暂无数据</p>"; return; }
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
      `<div class="ac-card"><div class="ac-title">${title}</div>${rows.map(r =>
        `<div class="ac-row"><span>${r[0]}</span><b class="${r[2] || ""}">${r[1]}</b></div>`).join("")}</div>`;

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

    wrap.innerHTML =
      card("持仓诊断", diagnoseRows) +
      card("VIX 环境判读", zoneRows) +
      card("策略表现", perfRows) +
      card("交易复盘", reviewRows) +
      card("风险提示", riskRows);
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
    return { dates, portfolio, benchmark, funds, markers, viewDate: state.viewDate };
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
    if (!compareChart) compareChart = C.renderCompare($("compareChart"), { dates, strategs: strs, benchmark });
    else { compareChart.clear(); C.renderCompare($("compareChart"), { dates, strategs: strs, benchmark }); }

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

    // VIX 自动交易
    $("autoEnabled").onchange = () => {
      const on = $("autoEnabled").checked;
      $("autoBody").style.display = on ? "" : "none";
      if (on) {
        // 同步当前全局区间，确保有默认条件，立即生成一次
        $("autoStart").value = state.startDate;
        $("autoEnd").value = state.endDate;
        seedAutoConds();
        runAuto(true);
      }
    };
    $("autoRun").onclick = () => runAuto(true);
    $("autoAdd").onclick = () => runAuto(false);
    $("autoAddCond").onclick = () => addCondRow();
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
