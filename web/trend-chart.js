let chart = null;

const BANDS = {
  shortUp: "#2896FF",
  shortDown: "#0000FF",
  shortFlat: "#87CEEB",
  longUp: "#E3C46A",
  longDown: "#D4A85A",
  longFlat: "#D8C27A",
};

export function renderTrendChart(container, model, options) {
  if (!window.echarts) throw new Error("图表组件没有加载。");
  if (!chart || chart.getDom() !== container) {
    chart?.dispose();
    chart = window.echarts.init(container);
  }
  chart.setOption(chartOption(model, options), true);
  fitPriceScale(chart, model);
  chart.off("datazoom");
  chart.on("datazoom", () => fitPriceScale(chart, model));
  return chart;
}

export function resizeTrendChart() {
  chart?.resize();
}

export function disposeTrendChart() {
  chart?.dispose();
  chart = null;
}

export function trendActivity(model, turnoverOnly = false) {
  if (!turnoverOnly && model.volumes.some((value) => value > 0)) {
    return { label: "成交量", values: model.volumes, unit: "" };
  }
  if (model.turnovers?.some((value) => value > 0)) {
    const unit = model.futuCode?.startsWith("HK.") ? "港元" : "元";
    return { label: "成交额", values: model.turnovers, unit };
  }
  return null;
}

function chartOption(model, options) {
  const colors = palette(options);
  const activity = trendActivity(model, options.turnoverOnly);
  const showActivity = options.showVolume && activity;
  const zoomStart = model.dates.length > 80 ? 70 : 0;
  const series = [
    {
      type: "candlestick",
      name: "K线",
      data: model.candles,
      itemStyle: {
        color: "transparent",
        color0: colors.down,
        borderColor: colors.up,
        borderColor0: colors.down,
      },
      barMaxWidth: 14,
      z: 4,
    },
  ];
  if (options.showBands) {
    series.push(
      line("短期上轨", model.shortA, colors.shortFlat, 2),
      line("短期下轨", model.shortB, colors.shortFlat, 2),
      line("", model.shortAUp, colors.shortUp, 3),
      line("", model.shortADown, colors.shortDown, 3),
      line("", model.shortBUp, colors.shortUp, 3),
      line("", model.shortBDown, colors.shortDown, 3),
      line("长期上轨", model.longA, colors.longFlat, 2),
      line("长期下轨", model.longB, colors.longFlat, 2),
      line("", model.longAUp, colors.longUp, 3),
      line("", model.longADown, colors.longDown, 3),
      line("", model.longBUp, colors.longUp, 3),
      line("", model.longBDown, colors.longDown, 3),
      stick("短期上升", model.shortStickUp, colors.shortUp),
      stick("短期下降", model.shortStickDown, colors.shortDown),
      stick("短期震荡", model.shortStickFlat, colors.shortFlat),
      stick("长期上升", model.longStickUp, colors.longUp),
      stick("长期下降", model.longStickDown, colors.longDown),
      stick("长期震荡", model.longStickFlat, colors.longFlat),
    );
  }
  if (options.showMA) {
    series.push(
      line("MA5", model.ma5, colors.ma5, 5),
      line("MA10", model.ma10, colors.ma10, 5),
      line("MA20", model.ma20, colors.ma20, 5),
    );
  }
  if (showActivity) {
    series.push({
      type: "bar",
      name: activity.label,
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: activity.values.map((value, index) => {
        const candle = model.candles[index];
        const rising = candle ? candle[1] >= candle[0] : true;
        return { value, itemStyle: { color: rising ? colors.up : colors.down, opacity: 0.45 } };
      }),
      barMaxWidth: 14,
    });
  }
  return {
    animation: false,
    legend: { show: false },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: colors.tooltip,
      borderColor: colors.line,
      textStyle: { color: colors.ink, fontSize: 12 },
      formatter: (params) => tooltip(params, model, colors, activity),
    },
    grid: showActivity
      ? [
          { left: 12, right: 58, top: 16, bottom: 168 },
          { left: 12, right: 58, height: 96, bottom: 36 },
        ]
      : [{ left: 12, right: 58, top: 16, bottom: 36 }],
    xAxis: showActivity
      ? [categoryAxis(model.dates, colors, false), categoryAxis(model.dates, colors, true, 1)]
      : [categoryAxis(model.dates, colors, true)],
    yAxis: showActivity
      ? [priceAxis(colors), { gridIndex: 1, scale: true, axisLabel: { show: false }, splitLine: { show: false } }]
      : [priceAxis(colors)],
    dataZoom: [{
      type: "inside",
      xAxisIndex: showActivity ? [0, 1] : [0],
      start: zoomStart,
      end: 100,
    }],
    series,
  };
}

function line(name, data, color, z) {
  return {
    type: "line",
    name,
    data,
    smooth: true,
    showSymbol: false,
    connectNulls: false,
    silent: !name,
    lineStyle: { width: 1.5, color },
    emphasis: { disabled: true },
    z,
  };
}

function stick(name, data, color) {
  return {
    type: "custom",
    name,
    data,
    silent: true,
    renderItem: (_params, api) => {
      const top = api.coord([api.value(0), api.value(1)]);
      const bottom = api.coord([api.value(0), api.value(2)]);
      return {
        type: "line",
        shape: { x1: top[0], y1: top[1], x2: bottom[0], y2: bottom[1] },
        style: { stroke: color, lineWidth: 2, opacity: 0.8 },
      };
    },
    z: 1,
  };
}

function categoryAxis(dates, colors, showLabel, gridIndex) {
  return {
    type: "category",
    data: dates,
    ...(gridIndex === undefined ? {} : { gridIndex }),
    boundaryGap: true,
    axisLine: { lineStyle: { color: colors.line } },
    axisLabel: { show: showLabel, color: colors.muted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
  };
}

function priceAxis(colors) {
  return {
    scale: true,
    position: "right",
    axisLabel: { color: colors.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: colors.line, opacity: 0.45 } },
  };
}

function fitPriceScale(chart, model) {
  const zoom = chart.getOption().dataZoom?.[0] ?? {};
  const from = Math.max(0, Math.floor(model.dates.length * (zoom.start ?? 0) / 100));
  const to = Math.min(model.dates.length, Math.ceil(model.dates.length * (zoom.end ?? 100) / 100));
  let min = Infinity;
  let max = -Infinity;
  for (let index = from; index < to; index += 1) {
    const candle = model.candles[index];
    if (candle) {
      min = Math.min(min, candle[2]);
      max = Math.max(max, candle[3]);
    }
    for (const key of ["shortA", "shortB", "longA", "longB"]) {
      const value = model[key]?.[index];
      if (typeof value === "number") {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return;
  const pad = (max - min) * 0.08;
  chart.setOption({ yAxis: [{ min: min - pad, max: max + pad }] });
}

function tooltip(params, model, colors, activity) {
  const row = Array.isArray(params) ? params[0] : params;
  if (!row) return "";
  const candle = model.candles[row.dataIndex];
  if (!candle) return "";
  const [open, close, low, high] = candle;
  const previous = row.dataIndex > 0 ? model.candles[row.dataIndex - 1]?.[1] : open;
  const change = previous ? ((close - previous) / previous) * 100 : 0;
  const tone = close >= previous ? colors.up : colors.down;
  const amount = activity?.values[row.dataIndex];
  return [
    `<div style="min-width:180px">`,
    `<strong>${model.dates[row.dataIndex]}</strong>`,
    rowText("开盘", formatPrice(open), colors.ink),
    rowText("最高", formatPrice(high), colors.up),
    rowText("最低", formatPrice(low), colors.down),
    rowText("收盘", formatPrice(close), tone),
    rowText("涨跌幅", `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, tone),
    activity && amount != null ? rowText(activity.label, formatActivity(amount) + activity.unit, colors.ink) : "",
    `</div>`,
  ].join("");
}

function rowText(label, value, color) {
  return `<div style="display:flex;justify-content:space-between;gap:16px"><span style="opacity:.7">${label}</span><span style="color:${color}">${value}</span></div>`;
}

function formatPrice(value) {
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function formatActivity(value) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return formatPrice(value);
}

function palette(options) {
  const style = getComputedStyle(document.documentElement);
  const ink = style.getPropertyValue("--ink").trim() || "#161616";
  const muted = style.getPropertyValue("--muted").trim() || "#8f8f8f";
  const line = style.getPropertyValue("--line").trim() || "#e7e7e4";
  const canvas = style.getPropertyValue("--canvas").trim() || "#fff";
  if (options.moyu) {
    const dark = options.dark;
    const up = dark ? "#f4f4f1" : "#161616";
    const down = dark ? "#3f3f3f" : "#d4d4d4";
    return {
      ink, muted, line, tooltip: canvas, up, down,
      shortUp: up, shortDown: down, shortFlat: muted,
      longUp: ink, longDown: muted, longFlat: line,
      ma5: ink, ma10: muted, ma20: down,
    };
  }
  return {
    ink, muted, line, tooltip: canvas,
    up: "#e54545",
    down: "#12a56a",
    ...BANDS,
    ma5: "#6366f1",
    ma10: "#0ea5e9",
    ma20: "#a855f7",
  };
}
