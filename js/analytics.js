// ============================================================
// 复盘分析指标
//   区间收益率 / 年化 / 最大回撤及持续 / 每笔交易盈亏 / 基准超额
// ============================================================
window.FS = window.FS || {};
FS.Analytics = (function () {
  const D = FS.Data;

  function dayDiff(a, b) {
    const da = new Date(a + "T00:00:00");
    const db = new Date(b + "T00:00:00");
    return Math.round((db - da) / 86400000);
  }

  function intervalReturn(equity) {
    if (!equity.length) return 0;
    return equity[equity.length - 1] / equity[0] - 1;
  }

  function annualized(ret, days) {
    if (days <= 0) return 0;
    return Math.pow(1 + ret, 365 / days) - 1;
  }

  // 最大回撤：峰到谷的最大跌幅，以及持续时间
  function maxDrawdown(equity, dates) {
    if (!equity.length) return { mdd: 0, peakDate: null, troughDate: null, durationDays: 0 };
    let peak = equity[0], peakIdx = 0, maxDD = 0, pIdx = 0, tIdx = 0;
    for (let i = 0; i < equity.length; i++) {
      if (equity[i] > peak) { peak = equity[i]; peakIdx = i; }
      const dd = (peak - equity[i]) / peak;
      if (dd > maxDD) { maxDD = dd; pIdx = peakIdx; tIdx = i; }
    }
    return {
      mdd: maxDD,
      peakDate: dates[pIdx],
      troughDate: dates[tIdx],
      durationDays: dayDiff(dates[pIdx], dates[tIdx]),
    };
  }

  function computeAll(result, ctx) {
    const { dates, equity, twrr, realized, benchmark, initialCapital, endCash, totalBuy, totalSell, strategy } = result;
    if (result.empty || !dates.length) {
      return { empty: true };
    }
    const start = dates[0], end = dates[dates.length - 1];
    const days = dayDiff(start, end);
    // 收益/年化/回撤基于「时间加权收益指数」，反映投入资金的真实表现，
    // 不被账户闲置现金稀释（与「组合走势」曲线口径一致）。
    const perf = (twrr && twrr.length) ? twrr : equity;
    const intervalRet = intervalReturn(perf);
    const ann = annualized(intervalRet, days);
    const dd = maxDrawdown(perf, dates);

    let bmInterval = 0, bmAnn = 0, excess = 0, excessAnn = 0;
    if (benchmark) {
      bmInterval = intervalReturn(benchmark.equity);
      bmAnn = annualized(bmInterval, days);
      excess = intervalRet - bmInterval;
      excessAnn = annualized(excess, days);
    }

    const endAssets = equity[equity.length - 1];
    const realizedTotal = realized.reduce((s, r) => s + r.realizedPnL, 0);

    // 每笔交易盈亏明细（买入 + 卖出）
    const tradeDetail = strategy.trades
      .filter(t => t.date >= ctx.startDate && t.date <= ctx.endDate)
      .map(t => {
        const f = D.getFund(t.fundCode);
        const nav = f ? D.navOnOrBefore(f, t.date) : null;
        const r = realized.find(x => x.tradeId === t.id);
        return {
          id: t.id, date: t.date,
          fundCode: t.fundCode, fundName: f ? f.name : t.fundCode,
          action: t.action, amount: t.amount, unit: t.unit, dca: !!t.dca, clearAll: !!t.clearAll,
          price: nav, shares: t._shares || 0,
          realized: r ? r.realizedPnL : null,
          pnlPct: r ? r.pnlPct : null,
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // 期末持仓
    const endPositions = result.positionsByDate[end] || {};

    return {
      empty: false,
      start, end, days,
      intervalReturn: intervalRet, annualized: ann,
      mdd: dd.mdd, mddPeak: dd.peakDate, mddTrough: dd.troughDate, mddDuration: dd.durationDays,
      bmInterval, bmAnnualized: bmAnn, excess, excessAnnualized: excessAnn,
      endAssets, endCash, initialCapital,
      totalBuy, totalSell, realizedTotal,
      tradeDetail, endPositions,
      benchmark,
    };
  }

  return { dayDiff, intervalReturn, annualized, maxDrawdown, computeAll };
})();
