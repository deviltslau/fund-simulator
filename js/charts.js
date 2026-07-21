// ============================================================
// 图表层（基于本地 ECharts）
//  - 主图：组合/基准/各基金净值均归一化到起点=100，同图对比，并标注买卖点
//  - 对比图：多策略归一化净值叠加
// ============================================================
window.FS = window.FS || {};
FS.Charts = (function () {
  const FUND_COLORS = ["#0ea5e9", "#8b5cf6", "#f97316", "#10b981", "#e11d48", "#14b8a6", "#a855f7", "#64748b"];

  function baseGrid() {
    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", confine: true },
      legend: { type: "scroll", top: 4, textStyle: { color: "#374151", fontSize: 12 } },
      grid: { left: 58, right: 22, top: 44, bottom: 64 },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 20 }],
      xAxis: {
        type: "category", data: [], boundaryGap: false,
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisLabel: { color: "#64748b", fontSize: 11 },
      },
      yAxis: {
        type: "value", scale: true,
        axisLabel: { color: "#64748b", fontSize: 11 },
        splitLine: { lineStyle: { color: "#eef2f7" } },
      },
    };
  }

  function tipFmt(ps) {
    let s = (ps[0] && ps[0].axisValue ? ps[0].axisValue : "") + "<br/>";
    ps.forEach(p => { s += p.marker + p.seriesName + "：" + (p.value == null ? "-" : (+p.value).toFixed(2)) + "<br/>"; });
    return s;
  }

  function vixZone(v) {
    if (v == null) return "";
    if (v < 15) return "平静";
    if (v < 25) return "正常";
    if (v < 30) return "偏高";
    return "恐慌";
  }

  function inst(dom) {
    return echarts.getInstanceByDom(dom) || echarts.init(dom);
  }

  // 主图
  function renderMain(dom, cfg) {
    const chart = inst(dom);
    const opt = baseGrid();
    opt.xAxis.data = cfg.dates;
    const series = [];

    series.push({
      name: "我的组合", type: "line", data: cfg.portfolio, showSymbol: false,
      lineStyle: { width: 3, color: "#2563eb" }, itemStyle: { color: "#2563eb" },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: "rgba(37,99,235,0.18)" }, { offset: 1, color: "rgba(37,99,235,0.01)" }]) },
    });
    if (cfg.benchmark) {
      series.push({
        name: cfg.benchmark.name + "(基准)", type: "line", data: cfg.benchmark.data,
        showSymbol: false, lineStyle: { width: 2, color: "#94a3b8", type: "dashed" }, itemStyle: { color: "#94a3b8" },
      });
    }
    (cfg.funds || []).forEach((f, i) => {
      series.push({
        name: f.name, type: "line", data: f.data, showSymbol: false,
        lineStyle: { width: 1.4, color: FUND_COLORS[i % FUND_COLORS.length] }, itemStyle: { color: FUND_COLORS[i % FUND_COLORS.length] },
      });
    });

    // 买卖标记（落在组合线上），标签直接标注成交净值，悬停显示明细
    const mp = [];
    (cfg.markers || []).forEach(m => {
      const navTxt = m.nav == null ? "" : (+m.nav).toFixed(3);
      const common = {
        coord: [m.date, m.value], symbolSize: 13,
        // 保存原始信息供 tooltip 使用
        nav: m.nav, fundName: m.fundName, mtype: m.type, date: m.date,
      };
      if (m.type === "buy") {
        mp.push(Object.assign({}, common, {
          symbol: "triangle", itemStyle: { color: "#22c55e" },
          label: { show: true, position: "bottom", distance: 6, formatter: "买 " + navTxt, color: "#16a34a", fontSize: 10, fontWeight: 600 },
        }));
      } else {
        mp.push(Object.assign({}, common, {
          symbol: "triangle", symbolRotate: 180, itemStyle: { color: "#ef4444" },
          label: { show: true, position: "top", distance: 6, formatter: "卖 " + navTxt, color: "#dc2626", fontSize: 10, fontWeight: 600 },
        }));
      }
    });
    if (mp.length) {
      series[0].markPoint = {
        symbol: "triangle", symbolSize: 13, data: mp,
        tooltip: {
          trigger: "item", confine: true,
          formatter: (p) => {
            const d = p.data || {};
            const tag = d.mtype === "buy" ? "买入" : "卖出";
            const nav = d.nav == null ? "—" : (+d.nav).toFixed(4);
            return `${d.date}<br/>${tag}　${d.fundName || ""}<br/>成交净值：<b>${nav}</b>`;
          },
        },
      };
    }

    // 回溯查看日期竖线
    if (cfg.viewDate) {
      series[0].markLine = {
        silent: true, symbol: "none",
        lineStyle: { color: "#f59e0b", width: 1.5 },
        data: [{ xAxis: cfg.viewDate }],
        label: { formatter: "查看 " + cfg.viewDate, color: "#b45309", position: "end", fontSize: 11 },
      };
    }

    opt.series = series;
    // 轴向 tooltip：在含买卖点的日期追加成交净值明细
    const markerMap = {};
    (cfg.markers || []).forEach(m => { (markerMap[m.date] = markerMap[m.date] || []).push(m); });
    opt.tooltip.formatter = (ps) => {
      let s = tipFmt(ps);
      const dt = ps[0] && ps[0].axisValue;
      if (dt && markerMap[dt]) {
        s += '<hr style="margin:4px 0;border:none;border-top:1px dashed #cbd5e1"/>';
        markerMap[dt].forEach(m => {
          const tag = m.type === "buy" ? "买入" : "卖出";
          const color = m.type === "buy" ? "#16a34a" : "#dc2626";
          const nav = m.nav == null ? "—" : (+m.nav).toFixed(4);
          s += `<span style="color:${color}">▲ ${tag} ${m.fundName || ""} · 净值 ${nav}</span><br/>`;
        });
      }
      return s;
    };
    chart.setOption(opt, true);
    return chart;
  }

  // 多策略对比图
  function renderCompare(dom, cfg) {
    const chart = inst(dom);
    const opt = baseGrid();
    opt.xAxis.data = cfg.dates;
    const series = [];
    (cfg.strategs || []).forEach((st, i) => {
      series.push({
        name: st.name, type: "line", data: st.data, showSymbol: false,
        lineStyle: { width: 2.4, color: FUND_COLORS[i % FUND_COLORS.length] }, itemStyle: { color: FUND_COLORS[i % FUND_COLORS.length] },
      });
    });
    if (cfg.benchmark) {
      series.push({
        name: cfg.benchmark.name + "(基准)", type: "line", data: cfg.benchmark.data,
        showSymbol: false, lineStyle: { width: 2, color: "#94a3b8", type: "dashed" }, itemStyle: { color: "#94a3b8" },
      });
    }
    opt.series = series;
    opt.tooltip.formatter = tipFmt;
    chart.setOption(opt, true);
    return chart;
  }

  // VIX 恐慌指数子图（独立折线 + 恐慌区色带 + 阈值线 + 查看日竖线）
  function renderVIX(dom, cfg) {
    const chart = inst(dom);
    const opt = {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis", confine: true,
        formatter: (ps) => {
          const p = ps[0];
          const v = p.value == null ? "—" : (+p.value).toFixed(2);
          return p.axisValue + "<br/>VIX " + v + (p.value == null ? "" : " · " + vixZone(p.value));
        },
      },
      grid: { left: 46, right: 18, top: 18, bottom: 46 },
      xAxis: {
        type: "category", data: cfg.dates, boundaryGap: false,
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisLabel: { color: "#64748b", fontSize: 10 },
      },
      yAxis: {
        type: "value", min: 0, scale: true, name: "VIX",
        nameTextStyle: { color: "#64748b", fontSize: 11 },
        axisLabel: { color: "#64748b", fontSize: 11 },
        splitLine: { lineStyle: { color: "#eef2f7" } },
      },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 14 }],
      series: [{
        name: "VIX 恐慌指数", type: "line", data: cfg.vix, showSymbol: false,
        lineStyle: { width: 1.8, color: "#7c3aed" }, itemStyle: { color: "#7c3aed" },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: "rgba(124,58,237,0.18)" }, { offset: 1, color: "rgba(124,58,237,0.01)" }]) },
        // 恐慌区色带
        markArea: {
          silent: true,
          data: [
            [{ yAxis: 0, itemStyle: { color: "rgba(34,197,94,0.10)" } }, { yAxis: 15 }],
            [{ yAxis: 15, itemStyle: { color: "rgba(234,179,8,0.10)" } }, { yAxis: 25 }],
            [{ yAxis: 25, itemStyle: { color: "rgba(249,115,22,0.12)" } }, { yAxis: 30 }],
            [{ yAxis: 30, itemStyle: { color: "rgba(239,68,68,0.14)" } }, { yAxis: 200 }],
          ],
        },
        // 恐慌阈值线 + 自动交易阈值线 + 查看日竖线
        markLine: {
          silent: true, symbol: "none",
          data: [
            ...(cfg.buyThreshold != null ? [{
              yAxis: cfg.buyThreshold, lineStyle: { color: "#ea580c", type: "dashed", width: 1.6 },
              label: { formatter: "买入↑ " + cfg.buyThreshold, color: "#c2410c", position: "insideEndTop", fontSize: 10 } }] : []),
            ...(cfg.sellThreshold != null ? [{
              yAxis: cfg.sellThreshold, lineStyle: { color: "#059669", type: "dashed", width: 1.6 },
              label: { formatter: "卖出↓ " + cfg.sellThreshold, color: "#047857", position: "insideEndBottom", fontSize: 10 } }] : []),
            { yAxis: 30, lineStyle: { color: "#ef4444", type: "dashed", width: 1.2 },
              label: { formatter: "恐慌线 30", color: "#ef4444", position: "insideEndTop", fontSize: 10 } },
            ...(cfg.viewDate ? [{ xAxis: cfg.viewDate, lineStyle: { color: "#f59e0b", width: 1.5 },
              label: { formatter: "查看", color: "#b45309", position: "end", fontSize: 10 } }] : []),
          ],
        },
      }],
    };
    chart.setOption(opt, true);
    return chart;
  }

  return { renderMain, renderCompare, renderVIX, FUND_COLORS };
})();
