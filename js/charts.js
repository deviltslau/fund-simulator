// ============================================================
// 图表层（基于本地 ECharts）
//  - 主图：组合/基准/各基金净值均归一化到起点=100，同图对比，并标注买卖点
//  - 对比图：多策略归一化净值叠加
//  - VIX 子图：按区间着色 + 色带 + 阈值线 + 查看日竖线
// ============================================================
window.FS = window.FS || {};
FS.Charts = (function () {
  const FUND_COLORS = ["#4f46e5", "#0d9488", "#d97706", "#e11d48", "#7c3aed", "#db2777", "#65a30d", "#475569"];

  // 统一 tooltip 外观
  const TIP_BOX = {
    backgroundColor: "rgba(255,255,255,0.97)",
    borderColor: "#e2e8f0", borderWidth: 1,
    padding: [9, 12],
    textStyle: { color: "#0f172a", fontSize: 12, lineHeight: 18 },
    extraCssText: "box-shadow:0 8px 24px rgba(15,23,42,.12);border-radius:10px;",
  };

  function baseGrid() {
    return {
      backgroundColor: "transparent",
      animationDuration: 800,
      animationEasing: "cubicOut",
      animationDurationUpdate: 600,
      animationEasingUpdate: "cubicOut",
      tooltip: {
        trigger: "axis", confine: true,
        axisPointer: { type: "line", lineStyle: { color: "#4f46e5", width: 1, type: "dashed" }, z: 0 },
        ...TIP_BOX,
      },
      legend: {
        type: "scroll", top: 6, icon: "roundRect",
        itemWidth: 14, itemHeight: 8, itemGap: 12,
        textStyle: { color: "#475569", fontSize: 12 },
      },
      grid: { left: 62, right: 24, top: 48, bottom: 66 },
      dataZoom: [
        { type: "inside", zoomOnMouseWheel: true },
        {
          type: "slider", height: 18, bottom: 22, borderColor: "#e6e9f0",
          fillerColor: "rgba(99,102,241,.14)",
          handleStyle: { color: "#4f46e5" },
          moveHandleStyle: { color: "#a5b4fc" },
          dataBackground: { lineStyle: { color: "#cbd5e1" }, areaStyle: { color: "#eef1f6" } },
          selectedDataBackground: { lineStyle: { color: "#4f46e5" }, areaStyle: { color: "#e0e7ff" } },
        },
      ],
      xAxis: {
        type: "category", data: [], boundaryGap: false,
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisTick: { show: false },
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
    ps.forEach(p => {
      s += p.marker + p.seriesName + "：" + (p.value == null ? "—" : (+p.value).toFixed(2)) + "<br/>";
    });
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
      name: "我的组合", type: "line", data: cfg.portfolio, showSymbol: false, smooth: true,
      lineStyle: {
        width: 3,
        color: "#4338ca",
      },
      itemStyle: { color: "#4338ca" },
      emphasis: { focus: "series" },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: "rgba(67,56,202,0.22)" },
          { offset: 1, color: "rgba(67,56,202,0.01)" }]),
      },
    });
    if (cfg.benchmark) {
      series.push({
        name: cfg.benchmark.name + "(基准)", type: "line", data: cfg.benchmark.data,
        showSymbol: false, smooth: true, lineStyle: { width: 2, color: "#94a3b8", type: "dashed" },
        itemStyle: { color: "#94a3b8" }, emphasis: { focus: "series" },
      });
    }
    (cfg.funds || []).forEach((f, i) => {
      series.push({
        name: f.name, type: "line", data: f.data, showSymbol: false, smooth: true,
        lineStyle: { width: 1.5, color: FUND_COLORS[i % FUND_COLORS.length], opacity: 0.9 },
        itemStyle: { color: FUND_COLORS[i % FUND_COLORS.length] },
        emphasis: { focus: "series" }, z: 2,
      });
    });

    // 买卖标记（落在组合线上），标签直接标注成交净值，悬停显示明细
    const mp = [];
    (cfg.markers || []).forEach(m => {
      const navTxt = m.nav == null ? "" : (+m.nav).toFixed(3);
      const common = {
        coord: [m.date, m.value], symbolSize: 15,
        itemStyle: { shadowBlur: 10, shadowColor: "rgba(15,23,42,.25)" },
        // 保存原始信息供 tooltip / 点击使用
        nav: m.nav, fundName: m.fundName, mtype: m.type, date: m.date,
      };
      if (m.type === "buy") {
        mp.push(Object.assign({}, common, {
          symbol: "triangle", itemStyle: Object.assign({}, common.itemStyle, { color: "#22c55e" }),
          label: { show: true, position: "bottom", distance: 7, formatter: "买 " + navTxt, color: "#16a34a", fontSize: 10, fontWeight: 600, backgroundColor: "rgba(240,253,244,.9)", padding: [1, 4], borderRadius: 4 },
        }));
      } else {
        mp.push(Object.assign({}, common, {
          symbol: "triangle", symbolRotate: 180, itemStyle: Object.assign({}, common.itemStyle, { color: "#ef4444" }),
          label: { show: true, position: "top", distance: 7, formatter: "卖 " + navTxt, color: "#dc2626", fontSize: 10, fontWeight: 600, backgroundColor: "rgba(254,242,242,.9)", padding: [1, 4], borderRadius: 4 },
        }));
      }
    });
    if (mp.length) {
      series[0].markPoint = {
        symbol: "triangle", symbolSize: 15, data: mp,
        emphasis: { scale: 1.35 },
        tooltip: {
          trigger: "item", confine: true,
          ...TIP_BOX,
          formatter: (p) => {
            const d = p.data || {};
            const tag = d.mtype === "buy" ? "买入" : "卖出";
            const nav = d.nav == null ? "—" : (+d.nav).toFixed(4);
            const amt = d.clearAll ? "清仓" : (d.unit === "layer" ? d.amount + " 层" : "¥" + (+d.amount).toLocaleString("zh-CN"));
            const unit = d.clearAll ? "" : (d.unit === "layer" ? "层数" : "金额");
            return `<b>${d.date}</b><br/>${tag}　${d.fundName || ""}<br/>成交净值：<b>${nav}</b><br/>成交${unit}：<b>${amt}</b><br/><span style="color:#94a3b8;font-size:11px">点击可在「持仓快照」中定位该日</span>`;
          },
        },
      };
    }

    // 回溯查看日期竖线
    if (cfg.viewDate) {
      series[0].markLine = {
        silent: true, symbol: "none",
        lineStyle: { color: "#f59e0b", width: 1.8 },
        data: [{ xAxis: cfg.viewDate }],
        label: { formatter: "查看 " + cfg.viewDate, color: "#b45309", position: "end", fontSize: 11, fontWeight: 600 },
      };
    }

    opt.series = series;
    // 轴向 tooltip：在含买卖点的日期追加成交净值明细 + VIX 读数
    const markerMap = {};
    (cfg.markers || []).forEach(m => { (markerMap[m.date] = markerMap[m.date] || []).push(m); });
    opt.tooltip.formatter = (ps) => {
      let s = tipFmt(ps);
      const dt = ps[0] && ps[0].axisValue;
      if (dt && markerMap[dt]) {
        s += '<hr style="margin:5px 0;border:none;border-top:1px dashed #cbd5e1"/>';
        markerMap[dt].forEach(m => {
          const tag = m.type === "buy" ? "买入" : "卖出";
          const color = m.type === "buy" ? "#16a34a" : "#dc2626";
          const nav = m.nav == null ? "—" : (+m.nav).toFixed(4);
          const amt = m.clearAll ? "清仓" : (m.unit === "layer" ? m.amount + " 层" : "¥" + (+m.amount).toLocaleString("zh-CN"));
          s += `<span style="color:${color}">▲ ${tag} ${m.fundName || ""} · 净值 ${nav} · ${amt}</span><br/>`;
        });
      }
      if (dt && cfg.vixByDate && cfg.vixByDate[dt] != null) {
        const v = cfg.vixByDate[dt];
        const z = vixZone(v);
        const zc = v >= 30 ? "#dc2626" : v >= 25 ? "#ea580c" : v >= 15 ? "#ca8a03" : "#16a34a";
        s += `<span style="color:${zc}">VIX ${v.toFixed(1)} · ${z}</span>`;
      }
      return s;
    };
    chart.setOption(opt, true);

    // 点击买卖点 → 跳转查看日（仅绑定一次）
    if (chart.on && !chart._fsClick) {
      chart._fsClick = true;
      chart.on("click", (p) => {
        if (p && p.data && p.data.date && window.FS && window.FS.setViewDate) {
          window.FS.setViewDate(p.data.date);
        }
      });
    }
    return chart;
  }

  // 多策略对比图
  function renderCompare(dom, cfg) {
    const chart = inst(dom);
    const opt = baseGrid();
    opt.xAxis.data = cfg.dates;
    const series = [];
    (cfg.strategs || []).forEach((st, i) => {
      const isActive = st.name === cfg.activeName;
      const c = FUND_COLORS[i % FUND_COLORS.length];
      series.push({
        name: st.name, type: "line", data: st.data, showSymbol: false, smooth: true,
        z: isActive ? 5 : 2,
        lineStyle: { width: isActive ? 3 : 2, color: isActive ? "#4338ca" : c, opacity: isActive ? 1 : 0.7 },
        itemStyle: { color: isActive ? "#4338ca" : c },
        emphasis: { focus: "series" },
        areaStyle: isActive ? {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(67,56,202,0.16)" }, { offset: 1, color: "rgba(67,56,202,0.005)" }]),
        } : undefined,
      });
    });
    if (cfg.benchmark) {
      series.push({
        name: cfg.benchmark.name + "(基准)", type: "line", data: cfg.benchmark.data,
        showSymbol: false, smooth: true, lineStyle: { width: 2, color: "#94a3b8", type: "dashed" },
        itemStyle: { color: "#94a3b8" }, z: 1,
      });
    }
    opt.series = series;
    opt.tooltip.formatter = tipFmt;
    chart.setOption(opt, true);
    return chart;
  }

  // VIX 恐慌指数子图（独立折线 + 区间着色 + 色带 + 阈值线 + 查看日竖线）
  function renderVIX(dom, cfg) {
    const chart = inst(dom);
    const opt = {
      backgroundColor: "transparent",
      animationDuration: 800, animationEasing: "cubicOut",
      animationDurationUpdate: 600, animationEasingUpdate: "cubicOut",
      tooltip: {
        trigger: "axis", confine: true,
        axisPointer: { type: "line", lineStyle: { color: "#4f46e5", width: 1, type: "dashed" } },
        ...TIP_BOX,
        formatter: (ps) => {
          const p = ps[0];
          const v = p.value == null ? "—" : (+p.value).toFixed(2);
          return `<b>${p.axisValue}</b><br/>VIX ${v}` + (p.value == null ? "" : " · " + vixZone(p.value));
        },
      },
      grid: { left: 46, right: 18, top: 18, bottom: 48 },
      xAxis: {
        type: "category", data: cfg.dates, boundaryGap: false,
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisTick: { show: false },
        axisLabel: { color: "#64748b", fontSize: 10 },
      },
      yAxis: {
        type: "value", min: 0, scale: true, name: "VIX",
        nameTextStyle: { color: "#64748b", fontSize: 11 },
        axisLabel: { color: "#64748b", fontSize: 11 },
        splitLine: { lineStyle: { color: "#eef2f7" } },
      },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 14, borderColor: "#e6e9f0", fillerColor: "rgba(99,102,241,.14)", handleStyle: { color: "#4f46e5" } }],
      visualMap: {
        show: false, dimension: 1, seriesIndex: 0,
        pieces: [
          { lt: 15, color: "#16a34a" },
          { gte: 15, lt: 25, color: "#ca8a03" },
          { gte: 25, lt: 30, color: "#ea580c" },
          { gte: 30, color: "#dc2626" },
        ],
        outOfRange: { color: "#7c3aed" },
      },
      series: [{
        name: "VIX 恐慌指数", type: "line", data: cfg.vix, showSymbol: false, smooth: true,
        lineStyle: { width: 2 }, itemStyle: { color: "#4f46e5" },
        emphasis: { focus: "series" },
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
        // 恐慌阈值线 + 自动交易分级阈值线 + 查看日竖线
        markLine: {
          silent: true, symbol: "none",
          data: [
            ...(cfg.buyThresholds || []).map(t => ({
              yAxis: t, lineStyle: { color: "#ea580c", type: "dashed", width: 1.6 },
              label: { formatter: "买入↑ " + t, color: "#c2410c", position: "insideEndTop", fontSize: 10 } })),
            ...(cfg.sellThresholds || []).map(t => ({
              yAxis: t, lineStyle: { color: "#059669", type: "dashed", width: 1.6 },
              label: { formatter: "卖出↓ " + t, color: "#047857", position: "insideEndBottom", fontSize: 10 } })),
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
