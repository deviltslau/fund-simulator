// ============================================================
// 模拟盘引擎：逐日回溯、持仓、买卖、已实现盈亏
// 输入策略 + 全局参数，输出完整回测结果
// ============================================================
window.FS = window.FS || {};
FS.Engine = (function () {
  const D = FS.Data;

  /**
   * @param {Object} strategy { id, name, initialCapital, feeRate, trades:[{id,fundCode,action,date,amount,clearAll}] }
   * @param {Object} ctx { startDate, endDate, benchmarkCode }
   * @returns 回测结果
   */
  function run(strategy, ctx) {
    const start = ctx.startDate, end = ctx.endDate;
    const initialCapital = strategy.initialCapital;
    const feeRate = strategy.feeRate;
    const codesUsed = [...new Set(strategy.trades.map(t => t.fundCode))];
    const dates = D.unionDates(codesUsed, start, end, ctx.benchmarkCode);

    if (!dates.length) {
      return { empty: true, dates: [], equity: [], cash: [], mv: [],
        positionsByDate: {}, realized: [], benchmark: null,
        totalInvested: 0, endCash: initialCapital };
    }

    // 预过滤窗口内交易，按日期分组；同日先卖后买（腾出资金）
    const byDate = {};
    for (const t of strategy.trades) {
      if (t.date < start || t.date > end) continue;
      (byDate[t.date] = byDate[t.date] || []).push(t);
    }
    for (const d in byDate) {
      byDate[d].sort((a, b) => (a.action === "sell" ? -1 : 0) - (b.action === "sell" ? -1 : 0));
    }

    let cash = initialCapital;
    const positions = {}; // code -> { shares, avgCost }
    const equity = [], cashSeries = [], mvSeries = [];
    const positionsByDate = {};
    const realized = []; // 已实现交易明细
    // 时间加权收益指数（基准=100）：仅反映「已持有份额」的价格变动，
    // 不受当日买入/卖出资金进出与闲置现金稀释影响，用于「组合走势」曲线。
    const twrr = [];
    let twIndex = 100;
    let prevNavByCode = {}; // 上一交易日各持仓净值，用于计算当日持有收益

    for (const d of dates) {
      // —— 先按「昨日持仓份额 × (今日净值 / 昨日净值)」累计当日持有收益 ——
      let mvPrev = 0, mvCurr = 0;
      for (const code in positions) {
        const p = positions[code];
        if (!p || p.shares <= 0) continue;
        const navPrev = prevNavByCode[code];
        const f = D.getFund(code);
        const navCurr = f ? D.navOnOrBefore(f, d) : null;
        if (navPrev != null && navCurr != null) {
          mvPrev += p.shares * navPrev;
          mvCurr += p.shares * navCurr;
        }
      }
      if (mvPrev > 1e-9) twIndex *= (mvCurr / mvPrev);

      const dayTrades = byDate[d] || [];
      for (const t of dayTrades) {
        const f = D.getFund(t.fundCode);
        if (!f) continue;
        const nav = D.navOnOrBefore(f, d);
        if (nav == null) continue;

        if (t.action === "buy") {
          const amt = Math.max(0, +t.amount || 0);
          if (amt <= 0) continue;
          const fee = amt * feeRate;
          const sharesBought = (amt - fee) / nav;
          const p = positions[t.fundCode] || { shares: 0, avgCost: 0 };
          const newShares = p.shares + sharesBought;
          const newAvg = (p.shares * p.avgCost + (amt - fee)) / newShares;
          positions[t.fundCode] = { shares: newShares, avgCost: newAvg };
          cash -= amt;
        } else { // sell
          const p = positions[t.fundCode];
          if (!p || p.shares <= 0) continue;
          let sellShares = t.clearAll ? p.shares : (+t.amount || 0) / nav;
          sellShares = Math.min(sellShares, p.shares);
          if (sellShares <= 1e-9) continue;
          const proceeds = sellShares * nav;
          const fee = proceeds * feeRate;
          const realizedPnL = (nav - p.avgCost) * sellShares - fee;
          cash += proceeds - fee;
          p.shares -= sellShares;
          if (p.shares < 1e-9) delete positions[t.fundCode];
          realized.push({
            tradeId: t.id, fundCode: t.fundCode, fundName: f.name,
            date: d, action: "sell", shares: sellShares, price: nav,
            proceeds, fee, costBasis: p.avgCost * sellShares,
            realizedPnL, pnlPct: (nav / p.avgCost - 1),
          });
        }
      }

      // 当日持仓快照
      let mv = 0;
      const snap = {};
      for (const code in positions) {
        const p = positions[code];
        const f = D.getFund(code);
        const nav = D.navOnOrBefore(f, d);
        const m = p.shares * (nav || 0);
        mv += m;
        snap[code] = {
          code, name: f.name, shares: p.shares, avgCost: p.avgCost,
          nav: nav || 0, mv: m, costValue: p.shares * p.avgCost,
          pnl: m - p.shares * p.avgCost, pnlPct: nav ? (nav / p.avgCost - 1) : 0,
        };
      }
      equity.push(cash + mv);
      cashSeries.push(cash);
      mvSeries.push(mv);
      positionsByDate[d] = snap;
      twrr.push(twIndex);

      // 记录今日各持仓净值，供次日计算持有收益
      prevNavByCode = {};
      for (const code in positions) {
        const f = D.getFund(code);
        prevNavByCode[code] = f ? D.navOnOrBefore(f, d) : null;
      }
    }

    // 基准（买入持有）
    const bench = D.getBenchmark();
    let benchmark = null;
    if (bench) {
      const nav0 = D.navOnOrBefore(bench, dates[0]);
      const eq = [];
      for (const d of dates) {
        const n = D.navOnOrBefore(bench, d);
        eq.push(nav0 ? initialCapital * (n / nav0) : initialCapital);
      }
      benchmark = { code: bench.code, name: bench.name, dates, nav: dates.map(d => D.navOnOrBefore(bench, d)), equity: eq };
    }

    let totalBuy = 0, totalSell = 0;
    for (const t of strategy.trades) {
      if (t.date < start || t.date > end) continue;
      if (t.action === "buy") totalBuy += (+t.amount || 0);
      else {
        const f = D.getFund(t.fundCode);
        const nav = f ? D.navOnOrBefore(f, t.date) : null;
        const p = positions[t.fundCode];
        if (nav) totalSell += (t.clearAll ? (p ? p.shares : 0) : (+t.amount || 0) / nav) * nav;
      }
    }

    return {
      empty: false,
      strategy, dates, equity, cash: cashSeries, mv: mvSeries, twrr,
      positionsByDate, realized, benchmark,
      initialCapital, endCash: cash,
      totalBuy, totalSell,
    };
  }

  return { run };
})();
