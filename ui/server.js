// Stage 2: thin HTTP API over the SQLite database built by ingest.js.
// Every /api request first syncs newly appended log lines into the db,
// then answers with plain SELECTs. All log parsing and OCR flakiness
// handling lives in ingest.js; data read from the db is trusted as-is.
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { LOG_DIR, weatherFields, openDb, syncFromLogs, nextDate } = require("./ingest");

const PORT = Number(process.env.PORT || 80);
const PUBLIC_DIR = __dirname;

const db = openDb();

// ---------- presentation helpers ----------

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

// ---------- API queries ----------

function dedupeConsecutive(rows, keyFn) {
  return rows.filter((row, index) => index === 0 || keyFn(row) !== keyFn(rows[index - 1]));
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function availableDays() {
  const rows = db.prepare(`
    SELECT day FROM demand
    UNION SELECT day FROM precise
    UNION SELECT day FROM boost_readings
    UNION SELECT day FROM weather_current
    UNION SELECT date FROM weather_latest
    ORDER BY 1
  `).all();
  return rows.map(({ day }) => ({ date: day, label: dateLabel(day) }));
}

function timelineBounds(date) {
  return { from: `${date} 04:00`, to: `${nextDate(date)} 02:00` };
}

function preciseSeries(from, to) {
  return dedupeConsecutive(
    db.prepare("SELECT ts, level, y_top, confidence FROM precise WHERE ts BETWEEN ? AND ? ORDER BY ts").all(from, to),
    (row) => row.level,
  ).map((row) => ({ time: row.ts.slice(11), level: row.level, y_top: row.y_top, confidence: row.confidence }));
}

function boostIntervalsFor(from, to) {
  return db.prepare("SELECT * FROM boost_intervals WHERE start_ts < ? AND end_ts > ? ORDER BY start_ts").all(to, from).map((row) => ({
    percent: row.percent,
    start: clamp(row.start_ts, from, to).slice(11),
    end: clamp(row.end_ts, from, to).slice(11),
    period: row.period,
  }));
}

function boostAdvertisedFor(date) {
  return db.prepare("SELECT * FROM boost_advertised WHERE day = ? ORDER BY period_start").all(date).map((row) => ({
    percent: row.percent,
    start: row.period_start,
    end: row.period_end,
    period: `${row.period_start}-${row.period_end}`,
    seen_from: row.seen_from,
    seen_to: row.seen_to,
  }));
}

function buildDay(date) {
  const { from, to } = timelineBounds(date);

  const demand = dedupeConsecutive(
    db.prepare("SELECT ts, level FROM demand WHERE ts BETWEEN ? AND ? ORDER BY ts").all(from, to),
    (row) => `${row.ts}|${row.level}`,
  ).map((row) => ({ time: row.ts.slice(11), level: row.level }));

  const precise = preciseSeries(from, to);
  const boost = boostIntervalsFor(from, to);
  const boostAdvertised = boostAdvertisedFor(date);

  const forecastRow = db.prepare("SELECT payload FROM weather_latest WHERE kind = 'forecast' AND date = ?").get(date);
  const forecastPayload = forecastRow ? JSON.parse(forecastRow.payload) : null;
  const sunRow = db.prepare("SELECT payload FROM weather_latest WHERE kind = 'sun' AND date = ?").get(date);
  const sunPayload = sunRow ? JSON.parse(sunRow.payload) : null;
  const actualRows = db.prepare("SELECT tz, payload FROM weather_current WHERE ts BETWEEN ? AND ? ORDER BY ts").all(from, to);

  return {
    date,
    label: dateLabel(date),
    timezone: forecastPayload?.timezone || actualRows[0]?.tz || sunPayload?.tzid || "unknown",
    sun: parseSun(sunPayload),
    demand,
    precise,
    boost,
    boost_advertised: boostAdvertised,
    forecast: parseForecast(forecastPayload, date),
    actual: actualRows.map((row) => JSON.parse(row.payload)),
    sources: {
      demand_glob: "log_ocr_*.log",
      precise_glob: "log_match_*.log",
      boost_glob: "log_boost_*.log",
      current: `log_weather_current_${date}.jsonl`,
      forecast: `log_weather_hourly_forecast_${date}.jsonl`,
      sun: `log_weather_sun_events_${date}.jsonl`,
    },
  };
}

// A compact weather summary for a single day's timeline, preferring the
// hourly forecast (clean per-hour values) and falling back to point samples.
function weatherSummary(date, from, to) {
  const forecastRow = db.prepare("SELECT payload FROM weather_latest WHERE kind = 'forecast' AND date = ?").get(date);
  const forecast = forecastRow ? parseForecast(JSON.parse(forecastRow.payload), date) : [];
  const source = forecast.length
    ? forecast
    : db.prepare("SELECT payload FROM weather_current WHERE ts BETWEEN ? AND ? ORDER BY ts").all(from, to).map((row) => JSON.parse(row.payload));
  if (!source.length) return null;

  const temps = source.map((item) => item.temperature_2m).filter((value) => value !== null && value !== undefined);
  const probs = source.map((item) => item.precipitation_probability).filter((value) => value !== null && value !== undefined);
  const midday = source.find((item) => item.time >= "14:00") || source[Math.floor(source.length / 2)];
  return {
    temp_min: temps.length ? Math.min(...temps) : null,
    temp_max: temps.length ? Math.max(...temps) : null,
    // hourly rain sums meaningfully; point samples would double-count, so omit
    rain: forecast.length ? Number(forecast.reduce((sum, item) => sum + (item.rain ?? 0), 0).toFixed(1)) : null,
    precip_prob_max: probs.length ? Math.max(...probs) : null,
    weather_code: midday?.weather_code ?? null,
  };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday-first (Ljubljana)

function weekdayOf(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

// Groups every available day by weekday so the same weekday can be overlaid
// across weeks. Each weekday lists its dates with the lean lanes the
// /day_in_a_week page overlays: precise, boost, advertised, weather.
function buildWeekdays() {
  const groups = new Map(WEEKDAY_ORDER.map((weekday) => [weekday, []]));
  for (const { date, label } of availableDays()) {
    const { from, to } = timelineBounds(date);
    groups.get(weekdayOf(date)).push({
      date,
      label,
      precise: preciseSeries(from, to).map(({ time, level }) => ({ time, level })),
      boost: boostIntervalsFor(from, to),
      advertised: boostAdvertisedFor(date),
      weather: weatherSummary(date, from, to),
    });
  }
  return WEEKDAY_ORDER.map((weekday) => ({ weekday, name: WEEKDAY_NAMES[weekday], dates: groups.get(weekday) }));
}

// ---------- HTTP ----------

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Extensionless page routes map to their .html file.
const pageRoutes = {
  "/": "index.html",
  "/day_in_a_week": "day_in_a_week.html",
  "/day_in_a_week2": "day_in_a_week2.html",
};

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const filePath = path.join(PUBLIC_DIR, pageRoutes[urlPath] || urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
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
      syncFromLogs(db);
      sendJson(res, 200, availableDays());
      return;
    }
    if (url.pathname === "/api/day") {
      const date = url.searchParams.get("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
        sendJson(res, 400, { error: "date must be YYYY-MM-DD" });
        return;
      }
      syncFromLogs(db);
      sendJson(res, 200, buildDay(date));
      return;
    }
    if (url.pathname === "/api/weekdays") {
      syncFromLogs(db);
      sendJson(res, 200, buildWeekdays());
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
