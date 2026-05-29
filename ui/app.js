const LABEL_WIDTH = 174;
const HOUR_WIDTH = 176;
const START_TIME = "04:00";
const END_HOUR_ABS = 26;
const DAY_END_LABEL = "02:00";
const PRECISE_MAX_LEVEL = 9;
const WEATHER_ROW_HEIGHT = 340;

const fields = [
  ["temperature_2m", "Temp", "C"],
  ["apparent_temperature", "Feels", "C"],
  ["relative_humidity_2m", "Hum", "%"],
  ["precipitation_probability", "Precip prob", "%"],
  ["precipitation", "Precip", "mm"],
  ["rain", "Rain", "mm"],
  ["weather_code", "Code", ""],
  ["cloud_cover", "Cloud", "%"],
  ["pressure_msl", "Pressure", "hPa"],
  ["wind_speed_10m", "Wind", "km/h"],
  ["wind_direction_10m", "Dir", "deg"],
  ["wind_gusts_10m", "Gust", "km/h"],
];

let startTime = START_TIME;
let totalWidth = 0;
let days = [];

function nextDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function absoluteMinutes(time) {
  const value = minutes(time);
  const start = minutes(startTime);
  return value < start ? value + 1440 : value;
}

function xFor(time) {
  return ((absoluteMinutes(time) - minutes(startTime)) / 60) * HOUR_WIDTH;
}

function zonedNow(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function currentTimelineEndX(day) {
  const now = zonedNow(day.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const nowMinutes = minutes(now.time);
  const startMinutes = minutes(START_TIME);
  const endMinutes = minutes(DAY_END_LABEL);
  let absoluteNow = null;

  if (now.date === day.date && nowMinutes >= startMinutes) {
    absoluteNow = nowMinutes;
  } else if (now.date === nextDate(day.date) && nowMinutes <= endMinutes) {
    absoluteNow = nowMinutes + 1440;
  }

  if (absoluteNow === null) return totalWidth;
  const x = ((absoluteNow - startMinutes) / 60) * HOUR_WIDTH;
  return Math.min(totalWidth, Math.max(0, x));
}

function valueText(value, unit) {
  if (value === null || value === undefined) return "n/a";
  const display = Number.isInteger(value) ? value : value.toFixed(1);
  return unit ? `${display} ${unit}` : String(display);
}

function weatherLabel(code) {
  const labels = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    80: "Rain showers",
    95: "Thunderstorm",
  };
  return labels[code] || `Code ${code}`;
}

function tempBg(temp) {
  if (temp === null || temp === undefined) return "#ece7dd";
  const heat = Math.min(1, Math.max(0, (temp - 4) / 28));
  const hue = 205 - heat * 185;
  return `hsl(${hue} 72% 76%)`;
}

function renderAxis() {
  const cells = [
    `<div class="sticky left-0 z-40 border-r border-line bg-paper px-4 py-3 text-xs font-black uppercase text-muted" style="width:${LABEL_WIDTH}px">Time</div>`,
  ];
  for (let hour = 4; hour <= END_HOUR_ABS; hour += 1) {
    const x = ((hour * 60 - minutes(startTime)) / 60) * HOUR_WIDTH;
    const label = String(hour % 24).padStart(2, "0");
    cells.push(`<div class="absolute top-0 h-full border-l border-line/80 px-2 py-3 text-xs font-black text-muted" style="left:${x}px">${label}:00</div>`);
  }
  const axis = document.getElementById("axis");
  axis.style.gridTemplateColumns = `${LABEL_WIDTH}px ${totalWidth}px`;
  axis.style.height = "42px";
  axis.innerHTML = `${cells[0]}<div class="relative">${cells.slice(1).join("")}</div>`;
}

function gridLines() {
  const lines = [];
  for (let hour = 4; hour <= END_HOUR_ABS; hour += 1) {
    const x = ((hour * 60 - minutes(startTime)) / 60) * HOUR_WIDTH;
    lines.push(`<i class="pointer-events-none absolute top-0 bottom-0 border-l border-line/80" style="left:${x}px"></i>`);
  }
  return lines.join("");
}

function rowShell(title, subtitle, content, height, visual = "") {
  return `
    <section class="grid border-b border-line last:border-b-0" style="grid-template-columns:${LABEL_WIDTH}px ${totalWidth}px; min-height:${height}px">
      <div class="sticky left-0 z-20 grid content-center gap-1 border-r border-line bg-paper px-4">
        <strong class="text-sm font-black">${title}</strong>
        <span class="text-xs font-bold leading-4 text-muted">${subtitle}</span>
        ${visual ? `<div class="mt-1.5">${visual}</div>` : ""}
      </div>
      <div class="relative" style="min-height:${height}px">
        ${gridLines()}
        ${content}
      </div>
    </section>
  `;
}

function emptyState(text) {
  return `<div class="absolute left-4 top-6 rounded-lg bg-stone-100 px-3 py-2 text-xs font-black text-muted">${text}</div>`;
}

function renderSunRow(day) {
  const events = [
    ["Dawn", day.sun?.dawn],
    ["Sunrise", day.sun?.sunrise],
    ["Sunset", day.sun?.sunset],
    ["Dusk", day.sun?.dusk],
  ].filter(([, time]) => time);

  const pins = events.map(([label, time]) => {
    const x = xFor(time);
    const edge = x < 70 ? "items-start" : "items-center -translate-x-1/2";
    return `
      <div class="absolute top-4 flex flex-col ${edge} gap-1" style="left:${x}px">
        <span class="h-10 w-1 rounded-full bg-amber-400"></span>
        <span class="whitespace-nowrap rounded-full bg-amber-100 px-2 py-1 text-[11px] font-black text-amber-950 shadow-sm">${label}</span>
        <span class="text-[11px] font-black text-muted">${time}</span>
      </div>
    `;
  }).join("");

  return rowShell("Sun", `Day length ${day.sun?.day_length || "n/a"}`, pins || emptyState("No sun log for this date"), 104, `<span class="inline-block h-4 w-1 rounded-full bg-amber-400"></span>`);
}

function renderDemandRow(day, endX) {
  const demandVisual = `<span class="inline-flex gap-0.5"><span class="inline-block h-2 w-4 bg-slate-500"></span><span class="inline-block h-2 w-4 bg-emerald-700"></span><span class="inline-block h-2 w-4 bg-red-600"></span></span>`;
  if (!day.demand?.length) return rowShell("Demand", "OCR changed values", emptyState("No demand log for this date"), 96, demandVisual);

  const blocks = day.demand.map((item, index) => {
    const next = day.demand[index + 1];
    const start = xFor(item.time);
    const end = next ? xFor(next.time) : endX;
    const rawWidth = Math.max(1, end - start);
    const color = item.level === "High" ? "bg-red-600" : item.level === "Medium" ? "bg-emerald-700" : "bg-slate-500";
    const compact = rawWidth < 72;
    return `
      <article class="absolute top-6 h-14 overflow-hidden px-2 py-2 text-white ${color}" data-demand-block style="left:${start}px; width:${rawWidth}px">
        <strong class="block truncate text-xs font-black uppercase">${compact ? item.level[0] : item.level}</strong>
        <span class="block truncate text-[11px] font-bold opacity-90">${compact ? "" : item.time}</span>
      </article>
    `;
  }).join("");

  return rowShell("Demand", "OCR changed values", blocks, 96, demandVisual);
}

function renderPreciseRow(day, endX) {
  const preciseVisual = `<span class="inline-flex h-2 gap-px overflow-hidden rounded-sm"><span class="w-3" style="background:hsl(205 72% 55%)"></span><span class="w-3" style="background:hsl(120 72% 55%)"></span><span class="w-3" style="background:hsl(60 72% 55%)"></span><span class="w-3" style="background:hsl(15 72% 55%)"></span></span>`;
  if (!day.precise?.length) return rowShell("Precise", "Matched y_top level", emptyState("No match log for this date"), 152, preciseVisual);

  const chartHeight = 112;
  const bottomPad = 28;

  const blocks = day.precise.map((item, index) => {
    const next = day.precise[index + 1];
    const start = xFor(item.time);
    const end = next ? xFor(next.time) : endX;
    const rawWidth = Math.max(2, end - start);
    const barHeight = Math.max(22, ((item.level + 1) / (PRECISE_MAX_LEVEL + 1)) * chartHeight);
    const top = chartHeight - barHeight + 10;
    const heat = Math.min(1, Math.max(0, item.level / PRECISE_MAX_LEVEL));
    const hue = 205 - heat * 190;
    return `
      <article
        class="absolute"
        data-level="${item.level}"
        data-precise-block
        title="${item.time} · level ${item.level} · y_top=${item.y_top} · confidence=${item.confidence.toFixed(3)}"
        style="left:${start}px; width:${rawWidth}px; top:0; height:${chartHeight + bottomPad}px"
      >
        <div class="absolute shadow-sm" style="left:0; right:0; top:${top}px; height:${barHeight}px; background:hsl(${hue} 72% 55%)"></div>
        <span class="absolute bottom-1 left-0 right-0 text-center text-[11px] font-black text-ink">${item.level}</span>
      </article>
    `;
  }).join("");

  const chart = `
    <div class="absolute inset-x-0 top-0 overflow-hidden" style="height:${chartHeight + bottomPad}px">
      ${blocks}
    </div>
  `;

  return rowShell("Precise", "Matched y_top level", chart, 152, preciseVisual);
}

function weatherCard(item, kind, top = 16) {
  const isForecast = kind === "forecast";
  const left = xFor(item.time) + 4;
  const width = HOUR_WIDTH - 8;
  const chips = fields.map(([key, label, unit]) => {
    const value = item[key];
    const muted = value === null || value === undefined;
    return `<span class="rounded-md ${muted ? "bg-stone-100 text-stone-400" : "bg-white/75 text-stone-800"} px-1.5 py-1 text-[10px] font-black">${label}: ${valueText(value, unit)}</span>`;
  }).join("");

  return `
    <article class="absolute rounded-lg border border-white/70 p-2 shadow-sm ${isForecast ? "" : "ring-2 ring-stone-900/60"}" data-weather-card="${kind}" style="top:${top}px; left:${left}px; width:${width}px; background:${tempBg(item.temperature_2m)}">
      <div class="mb-2 flex items-start justify-between gap-2">
        <div>
          <strong class="block text-sm font-black">${item.time}</strong>
          <span class="block text-[11px] font-black text-stone-700">${weatherLabel(item.weather_code)}</span>
        </div>
        <strong class="text-lg font-black">${valueText(item.temperature_2m, "C")}</strong>
      </div>
      <div class="grid grid-cols-2 gap-1">${chips}</div>
    </article>
  `;
}

function visibleWeather(items) {
  return (items || []).filter((item) => {
    const x = xFor(item.time);
    return x >= 0 && x <= totalWidth;
  });
}

function renderForecastRow(day) {
  const items = visibleWeather(day.forecast);
  return rowShell(
    "Forecast",
    "Hourly forecast fields",
    items.length ? items.map((item) => weatherCard(item, "forecast")).join("") : emptyState("No forecast log for this date"),
    WEATHER_ROW_HEIGHT,
    `<span class="inline-block h-4 w-5 rounded-md" style="background:hsl(140 72% 76%)"></span>`,
  );
}

function groupActualByHour(items) {
  const groups = new Map();
  for (const item of items) {
    const hourKey = item.time.slice(0, 2); // "20", "21", ...
    if (!groups.has(hourKey)) groups.set(hourKey, []);
    groups.get(hourKey).push(item);
  }
  return groups;
}

function renderActualHourGroup(hourKey, items) {
  items.sort((a, b) => a.time.localeCompare(b.time));
  const hourTime = `${hourKey}:00`;
  const left = xFor(hourTime) + 4;
  const width = HOUR_WIDTH - 8;
  const minuteSet = new Set(items.map((item) => item.time.slice(3, 5)));
  const defaultMinute = items[0].time.slice(3, 5);
  const allMinutes = ["00", "15", "30", "45"];

  const tabs = allMinutes.map((mm) => {
    if (!minuteSet.has(mm)) {
      return `<span class="text-[10px] font-black text-stone-300 cursor-default select-none">${mm}</span>`;
    }
    const isDefault = mm === defaultMinute;
    return `<span data-actual-tab="${mm}" class="text-[10px] font-black cursor-pointer select-none px-0.5 rounded ${isDefault ? "text-stone-800 underline" : "text-stone-500 hover:text-stone-800"}">${mm}</span>`;
  });
  const tabHtml = tabs.join(`<span class="text-stone-300 text-[10px] select-none"> | </span>`);

  const cardsHtml = items.map((item) => {
    const mm = item.time.slice(3, 5);
    const chips = fields.map(([key, label, unit]) => {
      const value = item[key];
      const muted = value === null || value === undefined;
      return `<span class="rounded-md ${muted ? "bg-stone-100 text-stone-400" : "bg-white/75 text-stone-800"} px-1.5 py-1 text-[10px] font-black">${label}: ${valueText(value, unit)}</span>`;
    }).join("");
    return `
      <div data-actual-card="${mm}" style="display:${mm === defaultMinute ? "block" : "none"}">
        <article class="rounded-lg border border-white/70 p-2 shadow-sm ring-2 ring-stone-900/60" data-weather-card="actual" style="background:${tempBg(item.temperature_2m)}">
          <div class="mb-2 flex items-start justify-between gap-2">
            <div>
              <strong class="block text-sm font-black">${item.time}</strong>
              <span class="block text-[11px] font-black text-stone-700">${weatherLabel(item.weather_code)}</span>
            </div>
            <strong class="text-lg font-black">${valueText(item.temperature_2m, "C")}</strong>
          </div>
          <div class="grid grid-cols-2 gap-1">${chips}</div>
        </article>
      </div>
    `;
  }).join("");

  return `
    <div class="absolute" data-actual-group data-actual-default="${defaultMinute}" style="top:8px; left:${left}px; width:${width}px">
      <div class="mb-1 flex items-center justify-center gap-0.5" data-actual-tabs>
        ${tabHtml}
      </div>
      ${cardsHtml}
    </div>
  `;
}

function renderActualRow(day) {
  const items = visibleWeather(day.actual);
  if (!items.length) {
    return rowShell("Actual", "Fetched current weather", emptyState("No current weather log for this date"), WEATHER_ROW_HEIGHT, `<span class="inline-block h-4 w-5 rounded-md ring-2 ring-stone-900/60" style="background:hsl(140 72% 76%)"></span>`);
  }
  const groups = groupActualByHour(items);
  const content = Array.from(groups.entries()).map(([hourKey, hourItems]) => renderActualHourGroup(hourKey, hourItems)).join("");
  return rowShell("Actual", "Fetched current weather", content, WEATHER_ROW_HEIGHT, `<span class="inline-block h-4 w-5 rounded-md ring-2 ring-stone-900/60" style="background:hsl(140 72% 76%)"></span>`);
}

function attachActualTabListeners() {
  document.querySelectorAll("[data-actual-group]").forEach((group) => {
    const defaultMinute = group.dataset.actualDefault;
    const tabsContainer = group.querySelector("[data-actual-tabs]");

    group.querySelectorAll("[data-actual-tab]").forEach((tab) => {
      tab.addEventListener("mouseenter", () => {
        const mm = tab.dataset.actualTab;
        group.querySelectorAll("[data-actual-card]").forEach((c) => (c.style.display = "none"));
        const card = group.querySelector(`[data-actual-card="${mm}"]`);
        if (card) card.style.display = "block";
      });
    });

    tabsContainer.addEventListener("mouseleave", () => {
      group.querySelectorAll("[data-actual-card]").forEach((c) => (c.style.display = "none"));
      const def = group.querySelector(`[data-actual-card="${defaultMinute}"]`);
      if (def) def.style.display = "block";
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function renderDay(date) {
  const day = await fetchJson(`/api/day?date=${encodeURIComponent(date)}`);
  startTime = START_TIME;
  totalWidth = (END_HOUR_ABS * 60 - minutes(startTime)) / 60 * HOUR_WIDTH;
  const endX = currentTimelineEndX(day);

  const timeline = document.getElementById("timeline");
  timeline.style.width = `${LABEL_WIDTH + totalWidth}px`;
  timeline.dataset.timelineEndX = String(endX);
  document.getElementById("dateTitle").textContent = `${day.label} · ${day.date} · ${day.timezone}`;

  renderAxis();
  document.getElementById("lanes").innerHTML = [
    renderSunRow(day),
    renderDemandRow(day, endX),
    renderPreciseRow(day, endX),
    renderForecastRow(day),
    renderActualRow(day),
  ].join("");
  attachActualTabListeners();
}

async function init() {
  const daySelect = document.getElementById("daySelect");
  days = await fetchJson("/api/days");
  if (!days.length) {
    daySelect.innerHTML = `<option>No logs found</option>`;
    document.getElementById("lanes").innerHTML = "";
    document.getElementById("dateTitle").textContent = "No logs found";
    return;
  }

  daySelect.innerHTML = days.map((item) => `<option value="${item.date}">${item.label}</option>`).join("");
  daySelect.addEventListener("change", (event) => renderDay(event.target.value));
  await renderDay(days[days.length - 1].date);
  daySelect.value = days[days.length - 1].date;
}

init().catch((error) => {
  console.error(error);
  document.getElementById("dateTitle").textContent = `Failed to load data: ${error.message}`;
});
