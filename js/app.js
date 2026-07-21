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

  // ---------- VIX 自动交易生成 ----------
  // p: {fundCode,start,end,buyThresh,sellThresh,amount,mode,initialCapital,feeRate}
  // 返回 {trades:[{id,fundCode,action,date,amount,clearAll}], log, buys, sells}
  function generateVixTrades(p) {
    const f = D.getFund(p.fundCode);
    if (!f) return { trades: [], log: "基金不存在" };
    const dates = D.unionDates([p.fundCode], p.start, p.end);
    if (!dates.length) return { trades: [], log: "该区间无交易日" };
    const feeRate = p.feeRate || 0;
    let cash = p.initialCapital || 0;     // 仅用于在生成阶段避免「无现金却买入」的失真
    let prevVix = null, holding = false;
    let buys = 0, sells = 0;
    const trades = [];
    for (const d of dates) {
      const v = D.vixOnOrBefore(d);
      const nav = D.navOnOrBefore(f, d);
      if (v == null || nav == null) { prevVix = v; continue; }

      // 卖出：持仓中且 VIX 跌破卖出阈值（突破=下穿当日；持续=只要低于阈值）
      if (holding) {
        const trig = p.mode === "cross"
          ? (prevVix != null && prevVix >= p.sellThresh && v < p.sellThresh)
          : (v < p.sellThresh);
        if (trig) {
          trades.push({ id: uid(), fundCode: p.fundCode, action: "sell", date: d, amount: 0, clearAll: true });
          holding = false; sells++;
          cash += p.amount; // 近似回收现金（清仓后下一笔才能再买）
        }
      }
      // 买入：空仓且 VIX 突破/高于买入阈值
      if (!holding) {
        const trig = p.mode === "cross"
          ? (prevVix != null && prevVix <= p.buyThresh && v > p.buyThresh)
          : (v > p.buyThresh);
        if (trig) {
          if (p.amount > cash) { prevVix = v; continue; } // 现金不足跳过
          trades.push({ id: uid(), fundCode: p.fundCode, action: "buy", date: d, amount: p.amount, clearAll: false });
          holding = true; buys++;
          cash -= p.amount;
        }
      }
      prevVix = v;
    }
    const log = `生成 ${buys} 笔买入、${sells} 笔卖出（区间 ${dates[0]} ~ ${dates[dates.length - 1]}）`;
    return { trades, log, buys, sells };
  }

  function readAutoParams() {
    return {
      fundCode: $("autoFund").value,
      start: $("autoStart").value || state.startDate,
      end: $("autoEnd").value || state.endDate,
      buyThresh: +$("autoBuy").value,
      sellThresh: +$("autoSell").value,
      amount: +$("autoAmount").value || 0,
      mode: $("autoMode").value,
      initialCapital: Math.max(0, +$("initialCapital").value || 0),
      feeRate: Math.max(0, (+$("feeRate").value || 0) / 100),
    };
  }

  // createNew=true：创建/替换一个 VIX 自动策略；false：追加到当前策略
  function runAuto(createNew) {
    const p = readAutoParams();
    if (!p.fundCode) return;
    if (!(p.buyThresh > p.sellThresh)) return alert("买入阈值需大于卖出阈值，才能构成「恐慌买入 / 平静卖出」的振荡。");
    if (p.amount <= 0) return alert("每笔买入金额需大于 0");
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
      updateViewVix();
    }
    renderTabs();
    renderMetrics();
    renderTradeList();
    renderTradeDetail();
    renderHoldings();
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
      const amt = t.action === "sell"
        ? (t.clearAll ? "清仓(全部)" : money(t.amount))
        : money(t.amount);

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
          const net = (+t.amount || 0) * (1 - feeRate); // 扣费后净投入
          const shares = net / t.price;
          const floatPnl = shares * navView - net;
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

  function renderHoldings() {
    const eng = state.activeEngine;
    const tb = $("holdingsTable").querySelector("tbody");
    tb.innerHTML = "";
    const snap = (eng && eng.positionsByDate[state.viewDate]) || {};
    const codes = Object.keys(snap);
    if (!codes.length) { tb.innerHTML = `<tr><td colspan="7" class="hint">查看日(${state.viewDate}) 无持仓</td></tr>`; return; }
    codes.forEach(code => {
      const p = snap[code];
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${p.name}</td><td>${num(p.shares, 2)}</td><td>${num(p.avgCost, 4)}</td>` +
        `<td>${num(p.nav, 4)}</td><td>${money(p.mv)}</td>` +
        `<td class="${cls(p.pnl)}">${money(p.pnl)}</td><td class="${cls(p.pnlPct)}">${pct(p.pnlPct)}</td>`;
      tb.appendChild(tr);
    });
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
          nav: t.price, fundName: t.fundName, amount: t.amount, clearAll: t.clearAll,
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
    // 启用自动交易时，把买卖阈值线传给图表，便于对照条件
    const buyT = $("autoEnabled").checked ? (+$("autoBuy").value || null) : null;
    const sellT = $("autoEnabled").checked ? (+$("autoSell").value || null) : null;
    return { dates, vix, viewDate: state.viewDate, buyThreshold: buyT, sellThreshold: sellT };
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
        // 同步当前全局区间，立即生成一次
        $("autoStart").value = state.startDate;
        $("autoEnd").value = state.endDate;
        runAuto(true);
      }
    };
    $("autoRun").onclick = () => runAuto(true);
    $("autoAdd").onclick = () => runAuto(false);

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
