// Stage 1: ingest log files into SQLite and clean up OCR flakiness.
// The database lives in memory, so every app restart rebuilds it from
// scratch; while running, syncFromLogs() picks up only newly appended
// lines (per-file byte bookmarks in the `files` table). Everything
// downstream (server.js) can assume the data in here is correct.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LOG_DIR = process.env.LOG_DIR || "/data";

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
  [600+3, 9],
  [600, 9],
  [600-111, 9],
  [625+3, 8],
  [625, 8],
  [625-135, 8],
  [650+3, 7],
  [650, 7],
  [650-142, 7],
  [676+3, 6],
  [676, 6],
  [676-142, 6],
  [701+3, 5],
  [701, 5],
  [701-142, 5],
  [726+3, 4],
  [726, 4],
  [726-142, 4],
  [751+3, 3],
  [751, 3],
  [751-142, 3],
  [776+3, 2],
  [776, 2],
  [776-142, 2],
  [802+3, 1],
  [802, 1],
  [802-142, 1],
  [827+3, 0],
  [827, 0],
  [827-142, 0],
]);

// ---------- time helpers ----------

function absMin(date, time) {
  return Date.parse(`${date}T${time}:00`) / 60000;
}

function tsOfAbs(abs) {
  const parsed = new Date(abs * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function nextDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function prevDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

// A timestamp before 02:00 still belongs to the previous day's timeline.
function timelineDayOf(date, time) {
  return time <= "02:00" ? prevDate(date) : date;
}

// Known data-collection faults: precise readings in these windows are bogus and
// dropped, so the affected span reads as "no data" (a gap) rather than real
// demand. 2026-06-02 had an on-screen overlay during the outage that locked the
// template match to a constant ~level 7 from 07:16 until real readings resumed
// at 15:19. A null-level marker is inserted at each window start (see openDb) so
// consumers break the line across the gap instead of holding the prior value.
const PRECISE_BLACKOUTS = [
  { from: "2026-06-02 07:16", to: "2026-06-02 15:19" },
  { from: "2026-06-06 16:15", to: "2026-06-06 22:15" },
];

function inBlackout(date, time) {
  const ts = `${date} ${time}`;
  return PRECISE_BLACKOUTS.some((window) => ts >= window.from && ts < window.to);
}

// ---------- database ----------

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL);

    CREATE TABLE demand (ts TEXT NOT NULL, day TEXT NOT NULL, level TEXT NOT NULL);
    CREATE INDEX demand_ts ON demand (ts);

    CREATE TABLE precise (ts TEXT NOT NULL, day TEXT NOT NULL, level INTEGER, y_top INTEGER NOT NULL, confidence REAL NOT NULL);
    CREATE INDEX precise_ts ON precise (ts);

    CREATE TABLE boost_readings (ts TEXT NOT NULL, day TEXT NOT NULL, percent INTEGER, period_start TEXT, period_end TEXT);
    CREATE INDEX boost_readings_ts ON boost_readings (ts);

    -- derived from boost_readings by rebuildBoost(): clean, flicker-free
    CREATE TABLE boost_intervals (start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, percent INTEGER NOT NULL, period TEXT);
    CREATE TABLE boost_advertised (day TEXT NOT NULL, percent INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, seen_from TEXT NOT NULL, seen_to TEXT NOT NULL);

    CREATE TABLE weather_current (ts TEXT PRIMARY KEY, day TEXT NOT NULL, tz TEXT, payload TEXT NOT NULL);
    CREATE TABLE weather_latest (kind TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, date));
  `);

  // A null-level gap marker at each blackout start; readings inside the window
  // are dropped during ingest, so this marker is the held value across the gap.
  const insertMarker = db.prepare("INSERT INTO precise (ts, day, level, y_top, confidence) VALUES (?, ?, NULL, 0, 0)");
  for (const window of PRECISE_BLACKOUTS) {
    const date = window.from.slice(0, 10);
    const time = window.from.slice(11);
    insertMarker.run(window.from, timelineDayOf(date, time));
  }
  return db;
}

function statements(db) {
  if (!db._stmts) {
    db._stmts = {
      fileBytes: db.prepare("SELECT bytes FROM files WHERE name = ?"),
      setFileBytes: db.prepare("INSERT INTO files (name, bytes) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes"),
      demand: db.prepare("INSERT INTO demand (ts, day, level) VALUES (?, ?, ?)"),
      precise: db.prepare("INSERT INTO precise (ts, day, level, y_top, confidence) VALUES (?, ?, ?, ?, ?)"),
      boostReading: db.prepare("INSERT INTO boost_readings (ts, day, percent, period_start, period_end) VALUES (?, ?, ?, ?, ?)"),
      weatherCurrent: db.prepare("INSERT OR REPLACE INTO weather_current (ts, day, tz, payload) VALUES (?, ?, ?, ?)"),
      weatherLatest: db.prepare("INSERT OR REPLACE INTO weather_latest (kind, date, payload) VALUES (?, ?, ?)"),
      allBoostReadings: db.prepare("SELECT ts, percent, period_start, period_end FROM boost_readings ORDER BY ts"),
      boostInterval: db.prepare("INSERT INTO boost_intervals (start_ts, end_ts, percent, period) VALUES (?, ?, ?, ?)"),
      boostAdvertised: db.prepare("INSERT INTO boost_advertised (day, percent, period_start, period_end, seen_from, seen_to) VALUES (?, ?, ?, ?, ?, ?)"),
    };
  }
  return db._stmts;
}

// ---------- line parsers ----------

// All .log files start lines with "YYYY-MM-DD_HH-MM-SS<TAB>rest".
function parseEventLine(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-\d{2}\t+(.*)$/);
  if (!match) return null;
  return { date: match[1], time: `${match[2]}:${match[3]}`, rest: match[4].trim() };
}

function ingestDemandLine(stmts, line) {
  const event = parseEventLine(line);
  if (!event || !event.rest) return;
  stmts.demand.run(`${event.date} ${event.time}`, timelineDayOf(event.date, event.time), event.rest);
}

function ingestMatchLine(stmts, line) {
  const event = parseEventLine(line);
  if (!event) return;
  const match = event.rest.match(/^y_top=(\d+)\t+confidence=([0-9.]+)/);
  if (!match) return;
  const level = preciseLevelByYTop.get(Number(match[1]));
  if (level === undefined) return;
  if (inBlackout(event.date, event.time)) return; // outage; the gap marker represents it
  stmts.precise.run(`${event.date} ${event.time}`, timelineDayOf(event.date, event.time), level, Number(match[1]), Number(match[2]));
}

// "None", "30%" or "30% 14:00-17:00"; percent === null means no boost showing.
function ingestBoostLine(stmts, line) {
  const event = parseEventLine(line);
  if (!event) return;
  let percent = null;
  let periodStart = null;
  let periodEnd = null;
  if (event.rest !== "None") {
    const match = event.rest.match(/^(\d{2,3})%(?:\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2}))?$/);
    if (!match) return;
    percent = Number(match[1]);
    periodStart = match[2] ?? null;
    periodEnd = match[3] ?? null;
  }
  stmts.boostReading.run(`${event.date} ${event.time}`, timelineDayOf(event.date, event.time), percent, periodStart, periodEnd);
}

function ingestWeatherCurrentLine(stmts, line) {
  const payload = JSON.parse(line);
  const current = payload.current;
  if (!current?.time) return;
  const date = String(current.time).slice(0, 10);
  const time = String(current.time).slice(11, 16);
  const normalized = { time };
  for (const field of weatherFields) normalized[field] = current[field] ?? null;
  stmts.weatherCurrent.run(`${date} ${time}`, timelineDayOf(date, time), payload.timezone ?? null, JSON.stringify(normalized));
}

// Only the newest forecast/sun payload per day matters; later lines replace earlier ones.
function ingestForecastLine(stmts, line, fileDate) {
  JSON.parse(line); // reject corrupt lines
  stmts.weatherLatest.run("forecast", fileDate, line);
}

function ingestSunLine(stmts, line, fileDate) {
  JSON.parse(line);
  stmts.weatherLatest.run("sun", fileDate, line);
}

const fileKinds = [
  [/^log_ocr_\d{4}-\d{2}-\d{2}_.*\.log$/, ingestDemandLine],
  [/^log_match_\d{4}-\d{2}-\d{2}_.*\.log$/, ingestMatchLine],
  [/^log_boost_\d{4}-\d{2}-\d{2}_.*\.log$/, ingestBoostLine],
  [/^log_weather_current_\d{4}-\d{2}-\d{2}\.jsonl$/, ingestWeatherCurrentLine],
  [/^log_weather_hourly_forecast_\d{4}-\d{2}-\d{2}\.jsonl$/, ingestForecastLine],
  [/^log_weather_sun_events_\d{4}-\d{2}-\d{2}\.jsonl$/, ingestSunLine],
];

// ---------- incremental sync ----------

function syncFromLogs(db) {
  const stmts = statements(db);
  let boostChanged = false;

  for (const name of fs.readdirSync(LOG_DIR).sort()) {
    const kind = fileKinds.find(([pattern]) => pattern.test(name));
    if (!kind) continue;
    const ingestLine = kind[1];

    const done = stmts.fileBytes.get(name)?.bytes ?? 0;
    let buf;
    try {
      buf = fs.readFileSync(path.join(LOG_DIR, name));
    } catch {
      continue; // file vanished between readdir and read
    }
    const upto = buf.lastIndexOf(10) + 1; // ignore a partially written last line
    if (upto <= done) continue;

    const fileDate = (name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    for (const line of buf.subarray(done, upto).toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        ingestLine(stmts, trimmed, fileDate);
      } catch {
        // one bad line must not kill ingestion
      }
    }
    stmts.setFileBytes.run(name, upto);
    if (name.startsWith("log_boost_")) boostChanged = true;
  }

  if (boostChanged) rebuildBoost(db);
}

// ---------- boost cleaning ----------
// We trust the card: whenever it says "Now" with a percent, the boost is
// active — even when the timestamp lies outside the advertised period (the
// app keeps showing boosts past their window, with the period label pointing
// elsewhere). Observed intervals and advertised periods are therefore kept
// as two independent outputs. The only flakiness handled here is the false
// "None" flicker when OCR misses the word "Now", plus lone one-minute blips.

const BOOST_EPS = 5; // minutes of tolerance for snapping to advertised period bounds
const BOOST_DEBOUNCE = 15; // a None must persist this long to really close a boost
const BOOST_BRIDGE = 60; // None gap bridged when the same percent+period reappears (sparse overnight sampling)

function buildBoostTimeline(readings) {
  const intervals = [];
  const advertisedByKey = new Map();
  let open = null;

  // candidate is the time of the contradicting reading that closed the
  // interval, or null when the stream ended with the boost still showing.
  function finalize(candidate) {
    if (!open) return;
    let end = candidate ?? open.lastSample;
    const inPeriod = candidate !== null && open.periodEndAbs !== null
      && candidate >= open.periodStartAbs - BOOST_EPS && candidate <= open.periodEndAbs + BOOST_EPS;
    if (inPeriod) {
      if (Math.abs(candidate - open.periodEndAbs) <= BOOST_EPS) end = open.periodEndAbs;
    } else if (candidate !== null) {
      // outside the advertised period nothing vouches for persistence, so
      // don't extend far past the last actual sighting
      end = Math.min(candidate, open.lastSample + BOOST_DEBOUNCE);
    }
    // a lone reading immediately contradicted is an OCR blip
    const blip = open.samples === 1 && candidate !== null && end - open.start < BOOST_EPS;
    if (!blip && end > open.start) {
      intervals.push({ percent: open.percent, startAbs: open.start, endAbs: end, period: open.periodLabel });
    }
    open = null;
  }

  for (const reading of readings) {
    if (reading.percent === null) {
      if (open && open.closeCandidate === null) open.closeCandidate = reading.abs;
      continue;
    }

    // anchor the advertised period to a calendar day and record it
    let periodStartAbs = null;
    let periodEndAbs = null;
    if (reading.periodStart) {
      let day = reading.date;
      periodStartAbs = absMin(day, reading.periodStart);
      periodEndAbs = absMin(day, reading.periodEnd);
      if (periodEndAbs <= periodStartAbs) periodEndAbs += 1440;
      if (reading.abs > periodEndAbs + BOOST_EPS) {
        // that period is already over today, so the card advertises tomorrow
        day = nextDate(reading.date);
        periodStartAbs += 1440;
        periodEndAbs += 1440;
      }
      const key = `${day}|${reading.percent}|${reading.periodStart}-${reading.periodEnd}`;
      const known = advertisedByKey.get(key);
      if (known) {
        known.lastSeenAbs = reading.abs;
      } else {
        advertisedByKey.set(key, {
          date: day,
          percent: reading.percent,
          periodStart: reading.periodStart,
          periodEnd: reading.periodEnd,
          firstSeenAbs: reading.abs,
          lastSeenAbs: reading.abs,
        });
      }
    }

    if (open) {
      const samePeriod = reading.periodStart && `${reading.periodStart}-${reading.periodEnd}` === open.periodLabel;
      const reconfirmWindow = samePeriod ? BOOST_BRIDGE : BOOST_DEBOUNCE;
      const reconfirms = reading.percent === open.percent
        && (open.closeCandidate === null || reading.abs - open.closeCandidate <= reconfirmWindow);
      if (reconfirms) {
        open.closeCandidate = null;
        open.samples += 1;
        open.lastSample = reading.abs;
        if (reading.periodStart) {
          // the app shortens/extends advertised periods; trust the latest
          open.periodStartAbs = periodStartAbs;
          open.periodEndAbs = periodEndAbs;
          open.periodLabel = `${reading.periodStart}-${reading.periodEnd}`;
        }
        continue;
      }
      finalize(open.closeCandidate ?? reading.abs);
    }

    const snapToStart = periodStartAbs !== null && Math.abs(reading.abs - periodStartAbs) <= BOOST_EPS;
    open = {
      percent: reading.percent,
      periodStartAbs,
      periodEndAbs,
      periodLabel: reading.periodStart ? `${reading.periodStart}-${reading.periodEnd}` : null,
      start: snapToStart ? periodStartAbs : reading.abs,
      lastSample: reading.abs,
      samples: 1,
      closeCandidate: null,
    };
  }
  finalize(open?.closeCandidate ?? null);

  return { intervals, advertised: [...advertisedByKey.values()] };
}

function rebuildBoost(db) {
  const stmts = statements(db);
  const readings = stmts.allBoostReadings.all().map((row) => ({
    abs: absMin(row.ts.slice(0, 10), row.ts.slice(11)),
    date: row.ts.slice(0, 10),
    percent: row.percent,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  }));

  const { intervals, advertised } = buildBoostTimeline(readings);

  db.exec("DELETE FROM boost_intervals; DELETE FROM boost_advertised;");
  for (const item of intervals) {
    stmts.boostInterval.run(tsOfAbs(item.startAbs), tsOfAbs(item.endAbs), item.percent, item.period);
  }
  for (const item of advertised) {
    stmts.boostAdvertised.run(item.date, item.percent, item.periodStart, item.periodEnd, tsOfAbs(item.firstSeenAbs), tsOfAbs(item.lastSeenAbs));
  }
}

module.exports = { LOG_DIR, weatherFields, openDb, syncFromLogs, nextDate };
