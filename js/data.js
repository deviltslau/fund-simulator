// ============================================================
// 数据层：内置样例 / CSV 导入 / 应用内尽力抓取
// 统一接口挂到 window.FS.Data
// ============================================================
window.FS = window.FS || {};
FS.Data = (function () {
  // code -> { code, name, isBenchmark, navs:[{d,v}], byDate:Map }
  const registry = {};
  // VIX 恐慌指数(参考)：[{d, v}]，非基金，不进基金列表/基准
  let vixArr = [];

  function sortNavs(navs) {
    return navs.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }

  function addFund(name, code, navs, isBenchmark) {
    navs = sortNavs(navs).filter(n => n && n.d && n.v != null && !isNaN(n.v));
    if (!navs.length) return null;
    const byDate = new Map();
    navs.forEach(n => byDate.set(n.d, n.v));
    const fund = { code, name, isBenchmark: !!isBenchmark, navs, byDate };
    registry[code] = fund;
    return fund;
  }

  function loadSample() {
    const s = window.SAMPLE_FUNDS || {};
    for (const code in s) {
      const f = s[code];
      addFund(f.name, code, f.navs, f.isBenchmark);
    }
    vixArr = (window.SAMPLE_VIX || []).slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }

  // VIX 恐慌指数（参考）：传入日期，返回该日或之前最近交易日的 VIX 值
  function getVIX() { return vixArr; }
  function vixOnOrBefore(date) {
    let lo = 0, hi = vixArr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (vixArr[mid].d <= date) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans >= 0 ? vixArr[ans].v : null;
  }

  function listFunds() { return Object.values(registry); }
  function getFund(code) { return registry[code] || null; }
  function getBenchmark() { return Object.values(registry).find(f => f.isBenchmark) || null; }
  function dateRange() {
    let min = null, max = null;
    for (const f of Object.values(registry)) {
      if (!f.navs.length) continue;
      if (!min || f.navs[0].d < min) min = f.navs[0].d;
      if (!max || f.navs[f.navs.length - 1].d > max) max = f.navs[f.navs.length - 1].d;
    }
    return { min, max };
  }

  // 某个日期或之前最近交易日的净值
  function navOnOrBefore(fund, date) {
    if (!fund) return null;
    const a = fund.navs;
    let lo = 0, hi = a.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].d <= date) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans >= 0 ? a[ans].v : null;
  }
  function navExact(fund, date) { return fund ? (fund.byDate.get(date) ?? null) : null; }

  // 合并若干基金 + 基准在 [start,end] 内的交易日（用于统一时间轴）
  function unionDates(codes, start, end, benchmarkCode) {
    const set = new Set();
    const all = new Set(codes);
    if (benchmarkCode) all.add(benchmarkCode);
    for (const code of all) {
      const f = registry[code];
      if (!f) continue;
      for (const n of f.navs) {
        if (n.d >= start && n.d <= end) set.add(n.d);
      }
    }
    return [...set].sort();
  }

  // ---------- CSV 导入 ----------
  // 期望列：日期(date), 净值(nav)；支持表头中文/英文，逗号或制表符分隔
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
    if (!lines.length) return [];
    const sep = lines[0].includes("\t") ? "\t" : ",";
    const header = lines[0].split(sep).map(h => h.trim());
    const di = header.findIndex(h => /date|日期|时间/i.test(h));
    const vi = header.findIndex(h => /nav|净值|单位净值|价值|value/i.test(h));
    const hasHeader = di >= 0 && vi >= 0;
    const rows = hasHeader ? lines.slice(1) : lines;
    const out = [];
    for (const line of rows) {
      const cols = line.split(sep);
      const d = hasHeader ? cols[di] : cols[0];
      const v = hasHeader ? cols[vi] : cols[1];
      if (!d || v == null) continue;
      const dv = parseFloat(String(v).replace(/,/g, ""));
      const ds = String(d).trim();
      if (isNaN(dv)) continue;
      const md = ds.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
      const date = md ? `${md[1]}-${md[2].padStart(2, "0")}-${md[3].padStart(2, "0")}` : ds;
      out.push({ d: date, v: dv });
    }
    return out;
  }

  // ---------- 应用内尽力抓取（东方财富，可能因跨域受限） ----------
  function fetchFundJSONP(code, startDate, endDate) {
    return new Promise((resolve, reject) => {
      const cb = "fsjsonp_" + Math.random().toString(36).slice(2);
      const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
        `&pageIndex=1&pageSize=2000&startDate=${startDate}&endDate=${endDate}&callback=${cb}`;
      const script = document.createElement("script");
      const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 12000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) {
        cleanup();
        try {
          const lst = (data && data.Data && data.Data.LSJZList) || [];
          const navs = lst.map(it => ({ d: it.FSRQ, v: parseFloat(it.DWJZ) }))
            .filter(x => x.d && !isNaN(x.v));
          if (!navs.length) return reject(new Error("空数据"));
          resolve(navs);
        } catch (e) { reject(e); }
      };
      script.onerror = () => { cleanup(); reject(new Error("网络/跨域受限")); };
      script.src = url;
      document.head.appendChild(script);
    });
  }

  return {
    registry, addFund, loadSample, listFunds, getFund, getBenchmark,
    dateRange, navOnOrBefore, navExact, unionDates, parseCSV, fetchFundJSONP,
    getVIX, vixOnOrBefore,
  };
})();
