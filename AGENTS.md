# Repository Notes

## Project Overview

Wolt courier demand monitoring system for Ljubljana. Captures screenshots from a Wolt device via ADB every minute, runs OCR + template matching to determine demand level (Low/Medium/High), and collects weather data from Open-Meteo. The **ui** dashboard visualizes demand timelines alongside weather conditions.

## Starting the UI

```sh
docker compose -f ui/docker-compose.yml up -t=0 -d --build
```

Available at `http://localhost:8083`.

## UI visual feedback loop

- The UI app lives in `ui/` and is normally served by `ui/docker-compose.yml` on `http://localhost:8083`.
- The Puppeteer visual smoke test lives in `ui_test/`.
- After changing Puppeteer test code, run:

```sh
docker compose -f ui_test/docker-compose.yml run --build --rm puppeteer
```

- Test artifacts are written to `ui_test/out/`:
  - `desktop.png`, `wide.png`, `mobile.png`
  - `*-scrolled-end.png`
  - `*-report.json`
- The current visual checks assert that Forecast and Actual weather cards do not overlap, Demand blocks have no rounded corners, and continuous Demand intervals have no visual gaps.
