// 无头校验：在 vm 中加载数据层/引擎/指标，跑一个示例策略验证逻辑
const fs = require("fs");
const vm = require("vm");
const ctx = { console };
ctx.window = ctx; // window 即全局对象，使 window.FS / 裸 FS 等价
ctx.document = { createElement: () => ({}), getElementById: () => null, addEventListener: () => {} };
vm.createContext(ctx);

for (const f of ["sample-data.js", "data.js", "engine.js", "analytics.js"]) {
  vm.runInContext(fs.readFileSync("js/" + f, "utf8"), ctx, { filename: f });
}
const FS = ctx.FS;
FS.Data.loadSample();
console.log("基金数:", FS.Data.listFunds().length, " 基准:", (FS.Data.getBenchmark() || {}).name);
console.log("日期范围:", JSON.stringify(FS.Data.dateRange()));

const st = {
  id: "s1", name: "test", initialCapital: 100000, feeRate: 0.0015,
  trades: [
    { id: "1", fundCode: "110003", action: "buy", date: "2021-01-04", amount: 50000 },
    { id: "2", fundCode: "005827", action: "buy", date: "2022-01-04", amount: 50000 },
    { id: "3", fundCode: "005827", action: "sell", date: "2024-06-03", amount: 0, clearAll: true },
  ],
};
const ctx2 = { startDate: "2021-01-01", endDate: "2026-07-20", benchmarkCode: "510300" };
const eng = FS.Engine.run(st, ctx2);
const an = FS.Analytics.computeAll(eng, ctx2);

console.log("交易日数:", eng.dates.length, " 首:", eng.dates[0], " 末:", eng.dates[eng.dates.length - 1]);
console.log("末日持仓(代码):", Object.keys(eng.positionsByDate[eng.dates[eng.dates.length - 1]]));
console.log("已实现交易数:", eng.realized.length, " 已实现盈亏合计:", eng.realized.reduce((s, r) => s + r.realizedPnL, 0).toFixed(2));
console.log("期末总资产:", an.endAssets.toFixed(2), " 期末现金:", an.endCash.toFixed(2));

const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === "number" ? +v.toFixed(4) : v));
console.log("指标:\n" + JSON.stringify({
  区间收益率: an.intervalReturn, 年化: an.annualized,
  最大回撤: an.mdd, 回撤峰: an.mddPeak, 回撤谷: an.mddTrough, 持续天: an.mddDuration,
  基准收益: an.bmInterval, 超额: an.excess, 区间天数: an.days,
  已实现合计: an.realizedTotal, 交易明细条数: an.tradeDetail.length,
}, null, 2));

// 断言
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; } else console.log("✅", m); }
assert(eng.dates.length > 1000, "时间轴包含完整交易日");
assert(an.intervalReturn > -1 && an.intervalReturn < 5, "区间收益率在合理范围");
assert(an.mdd >= 0 && an.mdd <= 1, "最大回撤∈[0,1]");
assert(an.mddDuration >= 0, "回撤持续天数>=0");
assert(an.bmInterval > -1 && an.bmInterval < 5, "基准收益合理");
assert(Math.abs(an.realizedTotal - eng.realized.reduce((s, r) => s + r.realizedPnL, 0)) < 1e-6, "已实现合计一致");

// —— #13 组合走势(TWRR)非常数 ——
const tw = eng.twrr;
const distinct = new Set(tw.map(v => +v.toFixed(3)));
console.log("\nTWRR 指数: 长度", tw.length, " 起点", tw[0], " 末值", tw[tw.length - 1].toFixed(3), " 不同取值数", distinct.size,
  " 最小", Math.min(...tw).toFixed(3), " 最大", Math.max(...tw).toFixed(3));
assert(tw.length === eng.dates.length, "TWRR 与日期等长");
assert(Math.abs(tw[0] - 100) < 1e-6, "TWRR 起点=100");
assert(distinct.size > 50, "TWRR 组合走势非常数（不再恒等于100）");

// —— #15 买入行浮动盈亏（模拟查看日=末日） ——
const viewDate = eng.dates[eng.dates.length - 1];
const buyRow = an.tradeDetail.find(t => t.action === "buy");
const f = FS.Data.getFund(buyRow.fundCode);
const navView = FS.Data.navOnOrBefore(f, viewDate);
const net = buyRow.amount * (1 - st.feeRate);
const floatPnl = (net / buyRow.price) * navView - net;
console.log("浮动盈亏示例:", buyRow.date, buyRow.fundName, "买入价", buyRow.price, "查看日净值", navView, "浮动盈亏", floatPnl.toFixed(2));
assert(buyRow.realized == null, "买入行 realized 为空（明细表按查看日算浮动）");
assert(isFinite(floatPnl), "浮动盈亏可计算");

console.log("\n校验完成。");
