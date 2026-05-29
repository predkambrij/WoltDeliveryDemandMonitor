const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");

const PORT = Number(process.env.PORT || 80);
const LOG_DIR = process.env.LOG_DIR || "/data";
const PUBLIC_DIR = __dirname;

const weatherFields = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation_probability",
  "precipitation",
  "rain",
  "weather_code",
  "cloud_cover",
  "pressure_msl",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
];

const preciseLevelByYTop = new Map([
  [603, 9],
  [600, 9],
  [628, 8],
  [625, 8],
  [653, 7],
  [650, 7],
  [679, 6],
  [676, 6],
  [704, 5],
  [701, 5],
  [729, 4],
  [726, 4],
  [754, 3],
  [751, 3],
  [779, 2],
  [776, 2],
  [805, 1],
  [802, 1],
  [830, 0],
  [827, 0],
]);

function dateLabel(date) {
  const parsed = new Date(`${date}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function timeOf(value) {
  if (!value) return null;
  const match = String(value).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : String(value).slice(0, 5);
}

function dateOf(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : null;
}

function nextDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function inTimeline(selectedDate, itemDate, itemTime) {
  if (itemDate === selectedDate) return itemTime >= "04:00";
  if (itemDate === nextDate(selectedDate)) return itemTime <= "02:00";
  return false;
}

function secondsToDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

function minutesSinceMidnight(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

async function listRootFiles() {
  return fs.readdir(LOG_DIR);
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function latest(items) {
  return items.length ? items[items.length - 1] : null;
}

function normalizeWeather(item) {
  const out = { time: timeOf(item.time) };
  for (const field of weatherFields) out[field] = item[field] ?? null;
  return out;
}

function parseForecast(payload, selectedDate) {
  if (!payload?.hourly?.time) return [];
  return payload.hourly.time
    .map((time, index) => {
      const item = { time: timeOf(time), date: dateOf(time) };
      for (const field of weatherFields) {
        item[field] = payload.hourly[field]?.[index] ?? null;
      }
      return item;
    })
    .filter((item) => inTimeline(selectedDate, item.date, item.time));
}

function parseSun(payload) {
  const results = payload?.results || {};
  return {
    dawn: timeOf(results.civil_twilight_begin),
    sunrise: timeOf(results.sunrise),
    sunset: timeOf(results.sunset),
    dusk: timeOf(results.civil_twilight_end),
    day_length: typeof results.day_length === "number" ? secondsToDuration(results.day_length) : "n/a",
  };
}

async function parseDemand(date, files) {
  const demandFiles = files.filter((file) => /^log_ocr_\d{4}-\d{2}-\d{2}_.*\.log$/.test(file)).sort();
  const events = [];

  for (const file of demandFiles) {
    const text = await fs.readFile(path.join(LOG_DIR, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const [timestamp, level] = line.trim().split(/\t+/);
      if (!timestamp || !level) continue;
      const itemDate = timestamp.slice(0, 10);
      const itemTime = timestamp.slice(11, 16).replace("-", ":");
      if (!inTimeline(date, itemDate, itemTime)) continue;
      const timelineMinute = itemDate === nextDate(date) ? minutesSinceMidnight(itemTime) + 1440 : minutesSinceMidnight(itemTime);
      events.push({ time: itemTime, level, timelineMinute });
    }
  }

  return events
    .sort((a, b) => a.timelineMinute - b.timelineMinute)
    .filter((event, index, arr) => index === 0 || event.time !== arr[index - 1].time || event.level !== arr[index - 1].level)
    .map(({ time, level }) => ({ time, level }));
}

async function parsePrecise(date, files) {
  const matchFiles = files.filter((file) => /^log_match_\d{4}-\d{2}-\d{2}_.*\.log$/.test(file)).sort();
  const events = [];

  for (const file of matchFiles) {
    const text = await fs.readFile(path.join(LOG_DIR, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-\d{2}\s+y_top=(\d+)\s+confidence=([0-9.]+)/);
      if (!match) continue;
      const [, itemDate, hour, minute, yTopRaw, confidenceRaw] = match;
      const itemTime = `${hour}:${minute}`;
      if (!inTimeline(date, itemDate, itemTime)) continue;
      const y_top = Number(yTopRaw);
      const level = preciseLevelByYTop.get(y_top);
      if (level === undefined) continue;
      const timelineMinute = itemDate === nextDate(date) ? minutesSinceMidnight(itemTime) + 1440 : minutesSinceMidnight(itemTime);
      events.push({
        time: itemTime,
        level,
        y_top,
        confidence: Number(confidenceRaw),
        timelineMinute,
      });
    }
  }

  return events
    .sort((a, b) => a.timelineMinute - b.timelineMinute)
    .filter((event, index, arr) => index === 0 || event.level !== arr[index - 1].level)
    .map(({ time, level, y_top, confidence }) => ({ time, level, y_top, confidence }));
}

async function buildDay(date, files) {
  const forecastPayload = latest(await readJsonLines(path.join(LOG_DIR, `log_weather_hourly_forecast_${date}.jsonl`)));
  const currentPayloads = await readJsonLines(path.join(LOG_DIR, `log_weather_current_${date}.jsonl`));
  const sunPayload = latest(await readJsonLines(path.join(LOG_DIR, `log_weather_sun_events_${date}.jsonl`)));
  const actualByTime = new Map();

  for (const payload of currentPayloads) {
    const current = payload.current;
    if (!current?.time) continue;
    const itemTime = timeOf(current.time);
    if (!inTimeline(date, dateOf(current.time), itemTime)) continue;
    actualByTime.set(itemTime, normalizeWeather(current));
  }

  return {
    date,
    label: dateLabel(date),
    timezone: forecastPayload?.timezone || currentPayloads[0]?.timezone || sunPayload?.tzid || "unknown",
    sun: parseSun(sunPayload),
    demand: await parseDemand(date, files),
    precise: await parsePrecise(date, files),
    forecast: parseForecast(forecastPayload, date),
    actual: [...actualByTime.values()].sort((a, b) => a.time.localeCompare(b.time)),
    sources: {
      demand_glob: "log_ocr_*.log",
      precise_glob: "log_match_*.log",
      current: `log_weather_current_${date}.jsonl`,
      forecast: `log_weather_hourly_forecast_${date}.jsonl`,
      sun: `log_weather_sun_events_${date}.jsonl`,
    },
  };
}

async function availableDays() {
  const files = await listRootFiles();
  const dates = new Set();
  for (const file of files) {
    const match = file.match(/^log_(?:weather_current|weather_hourly_forecast|weather_sun_events)_(\d{4}-\d{2}-\d{2})/);
    if (match) dates.add(match[1]);
  }
  return [...dates].sort().map((date) => ({ date, label: dateLabel(date) }));
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === ".js" ? "text/javascript" : ext === ".html" ? "text/html" : "application/octet-stream";
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") res.writeHead(404).end("Not found");
    else throw error;
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/days") {
      sendJson(res, 200, await availableDays());
      return;
    }
    if (url.pathname === "/api/day") {
      const date = url.searchParams.get("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
        sendJson(res, 400, { error: "date must be YYYY-MM-DD" });
        return;
      }
      sendJson(res, 200, await buildDay(date, await listRootFiles()));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`listening on :${PORT}, reading logs from ${LOG_DIR}`);
});
