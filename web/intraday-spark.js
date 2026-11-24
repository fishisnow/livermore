export function renderIntradaySpark(spark, { width = 112, height = 36 } = {}) {
  if (!spark?.prices?.length || spark.prices.length < 2) return `<span class="spark-empty">—</span>`;
  const prices = spark.prices;
  const vwap = spark.vwap ?? [];
  const values = [...prices, ...vwap.filter((value) => typeof value === "number")];
  if (!values.length) return `<span class="spark-empty">—</span>`;
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = (max - min) * 0.08 || max * 0.005 || 1;
  min -= pad;
  max += pad;
  const span = max - min || 1;
  const toX = (index) => (index / (prices.length - 1)) * width;
  const toY = (value) => height - ((value - min) / span) * height;
  const pricePath = prices.map((value, index) => `${index === 0 ? "M" : "L"}${toX(index).toFixed(2)},${toY(value).toFixed(2)}`).join(" ");
  const vwapPoints = vwap
    .map((value, index) => (typeof value === "number" ? `${toX(index).toFixed(2)},${toY(value).toFixed(2)}` : null))
    .filter(Boolean);
  const vwapPath = vwapPoints.length > 1
    ? `M${vwapPoints.join(" L")}`
    : "";
  const prev = typeof spark.prevClose === "number" ? spark.prevClose : null;
  const prevY = prev == null ? null : toY(prev).toFixed(2);
  return `
    <svg class="intraday-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="当日分时走势">
      ${prevY != null ? `<line class="spark-prev" x1="0" y1="${prevY}" x2="${width}" y2="${prevY}"/>` : ""}
      ${vwapPath ? `<path class="spark-vwap" d="${vwapPath}"/>` : ""}
      <path class="spark-price" d="${pricePath}"/>
    </svg>`;
}