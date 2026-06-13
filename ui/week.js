// Overlay view: for each weekday, every date of that weekday is drawn on a
// shared 04:00–02:00 timeline, one color per date. Precise renders as step
// curves (level held until the next change); boost renders as translucent
// observed blocks with dashed advertised outlines; weather is a per-date
// summary strip that doubles as the color legend.

const START_MIN = 4 * 60;
const END_MIN = 26 * 60; // 02:00 next day
const SPAN = END_MIN - START_MIN;
const CHART_W = 1100;
const PAD_L = 30;
const PAD_R = 12;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PRECISE_MAX_LEVEL = 9;
const GRID_MIN = 5; // precise resampling resolution

let smoothWin = 3; // +/- bins for the precise moving average (slider-controlled; 3*5 = ±15m)

// distinct, readable hues for the dates within one weekday
const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04"];

const WX = {
  0: ["Clear", "☀️"], 1: ["Mainly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Rime fog", "🌫️"], 51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"],
  55: ["Dense drizzle", "🌧️"], 61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  80: ["Rain showers", "🌦️"], 95: ["Thunderstorm", "⛈️"],
};

function absMin(time) {
  const [h, m] = time.split(":").map(Number);
  const value = h * 60 + m;
  return value < START_MIN ? value + 1440 : value;
}

function xOf(time) {
  return PAD_L + ((absMin(time) - START_MIN) / SPAN) * PLOT_W;
}

function xOfAbs(abs) {
  return PAD_L + ((abs - START_MIN) / SPAN) * PLOT_W;
}

function gridAndAxis(height, plotTop, plotH, yTicks, yLabel) {
  const parts = [];
  for (let hour = 4; hour <= 26; hour += 2) {
    const x = xOfAbs(hour * 60).toFixed(1);
    parts.push(`<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotTop + plotH}" stroke="#ddd6cb" stroke-width="1"/>`);
    parts.push(`<text x="${x}" y="${height - 3}" text-anchor="middle" font-size="11" font-weight="700" fill="#67736d">${String(hour % 24).padStart(2, "0")}</text>`);
  }
  for (const [value, label] of yTicks) {
    const y = (plotTop + (1 - value) * plotH).toFixed(1);
    parts.push(`<line x1="${PAD_L}" y1="${y}" x2="${CHART_W - PAD_R}" y2="${y}" stroke="#ece7dd" stroke-width="1"/>`);
    parts.push(`<text x="${PAD_L - 5}" y="${Number(y) + 4}" text-anchor="end" font-size="10" font-weight="700" fill="#9aa39d">${label}</text>`);
  }
  if (yLabel) parts.push(`<text x="${PAD_L - 5}" y="${plotTop - 4}" text-anchor="end" font-size="9" font-weight="800" fill="#9aa39d">${yLabel}</text>`);
  return parts.join("");
}

function svg(height, inner) {
  return `<svg viewBox="0 0 ${CHART_W} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" class="block">${inner}</svg>`;
}

// Step value of a date at minute t, only within its observed change-range.
// A null reading (blackout gap) yields null so the curve breaks across it.
function heldLevel(points, t) {
  const first = absMin(points[0].time);
  const last = absMin(points[points.length - 1].time);
  if (t < first || t > last) return null;
  let level = points[0].level;
  for (const point of points) {
    if (absMin(point.time) <= t) level = point.level;
    else break;
  }
  return level;
}

// Resample one date onto the global grid, then moving-average smooth it.
function smoothedSeries(day) {
  const points = day.precise.slice().sort((a, b) => absMin(a.time) - absMin(b.time));
  if (!points.length) return [];
  const raw = [];
  for (let t = START_MIN; t <= END_MIN; t += GRID_MIN) raw.push({ t, v: heldLevel(points, t) });
  return raw.map((point, i) => {
    if (point.v === null) return { t: point.t, v: null };
    let sum = 0;
    let n = 0;
    for (let k = i - smoothWin; k <= i + smoothWin; k += 1) {
      if (raw[k] && raw[k].v !== null) { sum += raw[k].v; n += 1; }
    }
    return { t: point.t, v: sum / n };
  });
}

function contiguousRuns(series) {
  const runs = [];
  let current = null;
  for (const point of series) {
    if (point.v !== null) {
      if (!current) { current = []; runs.push(current); }
      current.push(point);
    } else {
      current = null;
    }
  }
  return runs;
}

function smoothLine(pts) {
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

// SVG path "d" strings for one date's precise curve, breaking on blackout gaps.
// smoothWin 0 = the true step line from raw readings; otherwise a smoothed curve.
function dayPaths(day, yOf) {
  if (smoothWin === 0) {
    const points = day.precise.slice().sort((a, b) => absMin(a.time) - absMin(b.time));
    const ds = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      let d = `M ${xOf(run[0].time).toFixed(1)} ${yOf(run[0].level).toFixed(1)}`;
      for (let i = 1; i < run.length; i += 1) {
        const x = xOf(run[i].time).toFixed(1);
        d += ` L ${x} ${yOf(run[i - 1].level).toFixed(1)} L ${x} ${yOf(run[i].level).toFixed(1)}`;
      }
      ds.push(d);
      run = [];
    };
    for (const point of points) {
      if (point.level === null || point.level === undefined) flush();
      else run.push(point);
    }
    flush();
    return ds;
  }
  return contiguousRuns(smoothedSeries(day)).map((run) => smoothLine(run.map((p) => ({ x: xOfAbs(p.t), y: yOf(p.v) }))));
}

function preciseChart(dates) {
  const height = 132;
  const plotTop = 8;
  const plotH = 100;
  const yOf = (level) => plotTop + (1 - level / PRECISE_MAX_LEVEL) * plotH;
  const yTicks = [[0, "0"], [1 / 3, "3"], [2 / 3, "6"], [1, "9"]];

  const lines = dates.map((day, index) => {
    const color = PALETTE[index % PALETTE.length];
    return dayPaths(day, yOf)
      .map((d) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.8" stroke-linejoin="round" stroke-linecap="round"/>`)
      .join("");
  }).join("");

  return svg(height, gridAndAxis(height, plotTop, plotH, yTicks, "level") + lines);
}

function boostChart(dates) {
  const height = 116;
  const plotTop = 8;
  const plotH = 80;
  const baseY = plotTop + plotH;
  const maxPct = Math.max(80, ...dates.flatMap((day) => day.boost.map((b) => b.percent)));
  const yOf = (pct) => plotTop + (1 - pct / maxPct) * plotH;
  const yTicks = [[0, "0"], [0.5, `${Math.round(maxPct / 2)}`], [1, `${maxPct}%`]];

  const blocks = dates.map((day, index) => {
    const color = PALETTE[index % PALETTE.length];
    const advertised = day.advertised.map((item) => {
      const x = xOf(item.start);
      const w = Math.max(1, xOf(item.end) - x);
      const y = yOf(item.percent);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(baseY - y).toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3" stroke-opacity="0.55"><title>${day.date} advertised +${item.percent}% ${item.period}</title></rect>`;
    }).join("");
    const observed = day.boost.map((item) => {
      const x = xOf(item.start);
      const w = Math.max(1, xOf(item.end) - x);
      const y = yOf(item.percent);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(baseY - y).toFixed(1)}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="1.5" stroke-opacity="0.85"><title>${day.date} +${item.percent}% ${item.start}–${item.end}</title></rect>`;
    }).join("");
    return advertised + observed;
  }).join("");

  return svg(height, gridAndAxis(height, plotTop, plotH, yTicks, "boost") + blocks);
}

function legendRow(day, index) {
  const color = PALETTE[index % PALETTE.length];
  const w = day.weather;
  const wx = w && w.weather_code != null ? WX[w.weather_code] : null;
  const bits = [];
  if (w) {
    if (w.temp_min != null) bits.push(`${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C`);
    if (w.rain != null && w.rain > 0) bits.push(`🌧 ${w.rain}mm`);
    if (w.precip_prob_max != null) bits.push(`☂ ${w.precip_prob_max}%`);
    if (wx) bits.push(`${wx[1]} ${wx[0]}`);
  }
  return `
    <div class="flex items-center gap-2 text-xs font-bold">
      <span class="inline-block h-3 w-3 rounded-sm" style="background:${color}"></span>
      <span class="font-black text-ink">${day.label}</span>
      <span class="text-muted">${bits.join(" · ") || "no weather"}</span>
    </div>
  `;
}

function weekdaySection(group) {
  const hasData = group.dates.length > 0;
  const body = hasData
    ? `
      <div class="flex flex-wrap gap-x-5 gap-y-1 px-4 py-3">${group.dates.map(legendRow).join("")}</div>
      <div class="border-t border-line px-2 pt-1">
        <div class="px-2 text-[11px] font-black uppercase tracking-wider text-muted">Precise · matched level</div>
        ${preciseChart(group.dates)}
      </div>
      <div class="border-t border-line px-2 pt-1 pb-1">
        <div class="px-2 text-[11px] font-black uppercase tracking-wider text-muted">Boost · solid observed, dashed advertised</div>
        ${boostChart(group.dates)}
      </div>
    `
    : `<div class="px-4 py-6 text-xs font-black text-muted">No data for this weekday yet</div>`;

  return `
    <section class="overflow-hidden rounded-lg border border-line bg-paper shadow-sm">
      <div class="flex items-center justify-between border-b border-line bg-paper px-4 py-3">
        <strong class="text-base font-black">${group.name}</strong>
        <span class="text-xs font-black uppercase text-muted">${group.dates.length} ${group.dates.length === 1 ? "date" : "dates"}</span>
      </div>
      ${body}
    </section>
  `;
}

async function init() {
  const container = document.getElementById("weekdays");
  try {
    const response = await fetch("/api/weekdays");
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const weekdays = await response.json();
    const renderAll = () => { container.innerHTML = weekdays.map(weekdaySection).join(""); };

    document.getElementById("smooth").addEventListener("input", (event) => {
      smoothWin = Number(event.target.value);
      document.getElementById("smoothVal").textContent = smoothWin === 0 ? "off" : `±${smoothWin * GRID_MIN}m`;
      renderAll();
    });

    renderAll();
  } catch (error) {
    console.error(error);
    container.innerHTML = `<div class="rounded-lg border border-line bg-paper px-4 py-6 text-sm font-black text-muted">Failed to load: ${error.message}</div>`;
  }
}

init();
