// "When is demand high, by weekday?" Two complementary views over /api/weekdays:
//
//  1. Heatmap (weekday rows x hour columns): the average matched level per hour,
//     so dark cells = busy hours. This is the at-a-glance answer and is robust
//     even with only 2-3 dates per weekday.
//  2. Smoothed line chart: each individual date as its own lightly-smoothed
//     curve, colored by weekday. Averaging so few days washes out the real
//     peaks, so we keep every day's true shape and let the eye judge
//     consistency; weekday toggles isolate one weekday at a time.

const START_MIN = 4 * 60;
const END_MIN = 26 * 60; // 02:00 next day
const SPAN = END_MIN - START_MIN;
const CHART_W = 1200;
const PAD_L = 34;
const PAD_R = 14;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PRECISE_MAX_LEVEL = 9;
const GRID_MIN = 5; // line resampling resolution
const HOURS = 22; // 04:00 .. 02:00
const LINE_OPACITY = 0.6;

// /api/weekdays is Monday-first; one color per weekday in that order.
const WEEKDAY_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04"];

let weekdays = [];
const enabled = new Set(); // indices into the weekdays array (line chart only)
let smoothWin = 3; // +/- bins for the line moving average (slider-controlled; 3*5 = ±15m)

// ---------- shared helpers ----------

function absMin(time) {
  const [h, m] = time.split(":").map(Number);
  const value = h * 60 + m;
  return value < START_MIN ? value + 1440 : value;
}

function xOfAbs(abs) {
  return PAD_L + ((abs - START_MIN) / SPAN) * PLOT_W;
}

// Step value of a date at minute t, only within its observed change-range.
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

function sortedPoints(day) {
  return day.precise.slice().sort((a, b) => absMin(a.time) - absMin(b.time));
}

// demand color ramp: pale (low) -> deep red (high)
function heatColor(level) {
  const t = Math.min(1, Math.max(0, level / PRECISE_MAX_LEVEL));
  return `hsl(${(40 - 40 * t).toFixed(0)} ${(60 + 35 * t).toFixed(0)}% ${(95 - 55 * t).toFixed(0)}%)`;
}

// ---------- heatmap ----------

// Average level for a weekday during one hour, sampled across its dates.
function hourAverage(dates, hourIndex) {
  const start = START_MIN + hourIndex * 60;
  const perDate = [];
  for (const day of dates) {
    const points = sortedPoints(day);
    if (!points.length) continue;
    const samples = [];
    for (let t = start; t < start + 60; t += 10) {
      const level = heldLevel(points, t);
      if (level !== null) samples.push(level);
    }
    if (samples.length) perDate.push(samples.reduce((s, v) => s + v, 0) / samples.length);
  }
  if (!perDate.length) return null;
  return perDate.reduce((s, v) => s + v, 0) / perDate.length;
}

function renderHeatmap() {
  const cellW = 50;
  const labelW = 96;
  const headers = [`<div style="width:${labelW}px"></div>`];
  for (let h = 0; h < HOURS; h += 1) {
    const hour = (4 + h) % 24;
    headers.push(`<div class="text-center text-[11px] font-black text-muted" style="width:${cellW}px">${String(hour).padStart(2, "0")}</div>`);
  }

  const rows = weekdays.map((group) => {
    const cells = [`<div class="flex items-center text-xs font-black text-ink" style="width:${labelW}px">${group.name}</div>`];
    for (let h = 0; h < HOURS; h += 1) {
      const avg = hourAverage(group.dates, h);
      if (avg === null) {
        cells.push(`<div class="m-px rounded-sm" style="width:${cellW - 2}px; height:30px; background:#f0ece2"></div>`);
      } else {
        const dark = avg / PRECISE_MAX_LEVEL > 0.5;
        cells.push(`<div class="m-px flex items-center justify-center rounded-sm text-[11px] font-black" title="${group.name} ${String((4 + h) % 24).padStart(2, "0")}:00 · avg ${avg.toFixed(1)}" style="width:${cellW - 2}px; height:30px; background:${heatColor(avg)}; color:${dark ? "#fff" : "#6b5a36"}">${avg.toFixed(1)}</div>`);
      }
    }
    return `<div class="flex items-center">${cells.join("")}</div>`;
  });

  document.getElementById("heatmap").innerHTML =
    `<div class="inline-block"><div class="flex items-end pb-1">${headers.join("")}</div>${rows.join("")}</div>`;

  const swatches = [0, 2, 4, 6, 8, 9].map((level) => `<span class="inline-block h-3 w-5 rounded-sm" style="background:${heatColor(level)}"></span>`).join("");
  document.getElementById("heatScale").innerHTML = `low ${swatches} high`;
}

// ---------- smoothed line chart ----------

function gridAndAxis(height, plotTop, plotH) {
  const parts = [];
  for (let hour = 4; hour <= 26; hour += 2) {
    const x = xOfAbs(hour * 60).toFixed(1);
    parts.push(`<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotTop + plotH}" stroke="#ddd6cb" stroke-width="1"/>`);
    parts.push(`<text x="${x}" y="${height - 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#67736d">${String(hour % 24).padStart(2, "0")}:00</text>`);
  }
  for (let level = 0; level <= PRECISE_MAX_LEVEL; level += 1) {
    const y = (plotTop + (1 - level / PRECISE_MAX_LEVEL) * plotH).toFixed(1);
    parts.push(`<line x1="${PAD_L}" y1="${y}" x2="${CHART_W - PAD_R}" y2="${y}" stroke="${level % 3 === 0 ? "#e2dccf" : "#f0ece2"}" stroke-width="1"/>`);
    if (level % 3 === 0) parts.push(`<text x="${PAD_L - 6}" y="${Number(y) + 4}" text-anchor="end" font-size="11" font-weight="700" fill="#9aa39d">${level}</text>`);
  }
  return parts.join("");
}

// Resample one date onto the global grid, then moving-average smooth it.
function smoothedSeries(day) {
  const points = sortedPoints(day);
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
    const points = sortedPoints(day);
    const ds = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      let d = `M ${xOfAbs(absMin(run[0].time)).toFixed(1)} ${yOf(run[0].level).toFixed(1)}`;
      for (let i = 1; i < run.length; i += 1) {
        const x = xOfAbs(absMin(run[i].time)).toFixed(1);
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

function renderChart() {
  const height = 460;
  const plotTop = 12;
  const plotH = height - plotTop - 26;
  const yOf = (level) => plotTop + (1 - level / PRECISE_MAX_LEVEL) * plotH;

  // Each curve is drawn twice: a wide transparent "hit" path (easy to hover)
  // and the visible line. Both carry data-key so hover can highlight one day.
  const lines = [];
  let drawn = 0;
  weekdays.forEach((group, wi) => {
    if (!enabled.has(wi)) return;
    const color = WEEKDAY_COLORS[wi % WEEKDAY_COLORS.length];
    group.dates.forEach((day, di) => {
      const key = `${wi}:${di}`;
      const label = `${group.name} · ${day.label}`;
      for (const d of dayPaths(day, yOf)) {
        drawn += 1;
        lines.push(`<path d="${d}" data-hit data-key="${key}" data-label="${label}" fill="none" stroke="transparent" stroke-width="11" stroke-linejoin="round" stroke-linecap="round" style="pointer-events:stroke"></path>`);
        lines.push(`<path d="${d}" data-vis data-key="${key}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="${LINE_OPACITY}" stroke-linejoin="round" stroke-linecap="round" style="pointer-events:none"></path>`);
      }
    });
  });

  const empty = drawn === 0
    ? `<text x="${CHART_W / 2}" y="${plotTop + plotH / 2}" text-anchor="middle" font-size="13" font-weight="800" fill="#9aa39d">No weekdays selected</text>`
    : "";

  document.getElementById("chart").innerHTML =
    `<svg viewBox="0 0 ${CHART_W} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" class="block">${gridAndAxis(height, plotTop, plotH)}${lines.join("")}${empty}</svg>`;
  attachHover();
}

function highlight(key) {
  document.querySelectorAll("#chart path[data-vis]").forEach((path) => {
    if (key === null) {
      path.style.strokeOpacity = LINE_OPACITY;
      path.style.strokeWidth = "2";
    } else if (path.dataset.key === key) {
      path.style.strokeOpacity = "1";
      path.style.strokeWidth = "3.25";
    } else {
      path.style.strokeOpacity = "0.12";
      path.style.strokeWidth = "2";
    }
  });
}

function attachHover() {
  const wrap = document.getElementById("chartWrap");
  const tip = document.getElementById("tip");
  const moveTip = (event, label) => {
    const rect = wrap.getBoundingClientRect();
    tip.textContent = label;
    tip.style.left = `${event.clientX - rect.left + 14}px`;
    tip.style.top = `${event.clientY - rect.top + 14}px`;
    tip.classList.remove("hidden");
  };
  document.querySelectorAll("#chart path[data-hit]").forEach((path) => {
    path.addEventListener("mousemove", (event) => {
      moveTip(event, path.dataset.label);
      highlight(path.dataset.key);
    });
    path.addEventListener("mouseleave", () => {
      tip.classList.add("hidden");
      highlight(null);
    });
  });
}

// ---------- toggles ----------

function renderToggles() {
  document.getElementById("toggles").innerHTML = weekdays.map((group, index) => {
    const color = WEEKDAY_COLORS[index % WEEKDAY_COLORS.length];
    const on = enabled.has(index);
    return `
      <button data-weekday="${index}" class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-black ${on ? "border-transparent text-white" : "border-line text-muted"}" style="${on ? `background:${color}` : ""}">
        <span class="inline-block h-2.5 w-2.5 rounded-sm" style="background:${on ? "rgba(255,255,255,.85)" : color}"></span>
        ${group.name.slice(0, 3)}
        <span class="opacity-70">${group.dates.length}</span>
      </button>
    `;
  }).join("");
}

async function init() {
  try {
    const response = await fetch("/api/weekdays");
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    weekdays = await response.json();
    weekdays.forEach((_, index) => enabled.add(index)); // all selected by default

    document.getElementById("toggles").addEventListener("click", (event) => {
      const button = event.target.closest("[data-weekday]");
      if (!button) return;
      const index = Number(button.dataset.weekday);
      if (enabled.has(index)) enabled.delete(index);
      else enabled.add(index);
      renderToggles();
      renderChart();
    });
    document.getElementById("selectAll").addEventListener("click", () => {
      weekdays.forEach((_, index) => enabled.add(index));
      renderToggles();
      renderChart();
    });
    document.getElementById("selectNone").addEventListener("click", () => {
      enabled.clear();
      renderToggles();
      renderChart();
    });
    document.getElementById("smooth").addEventListener("input", (event) => {
      smoothWin = Number(event.target.value);
      document.getElementById("smoothVal").textContent = smoothWin === 0 ? "off" : `±${smoothWin * GRID_MIN}m`;
      renderChart();
    });

    renderHeatmap();
    renderToggles();
    renderChart();
  } catch (error) {
    console.error(error);
    document.getElementById("chart").innerHTML = `<div class="px-4 py-6 text-sm font-black text-muted">Failed to load: ${error.message}</div>`;
  }
}

init();
