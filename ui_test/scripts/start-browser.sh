#!/usr/bin/env sh
set -eu

if [ "${PUPPETEER_HEADLESS:-true}" = "false" ]; then
  export DISPLAY="${DISPLAY:-:99}"

  rm -f "/tmp/.X${DISPLAY#:}-lock"
  Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN:-1365x900x24}" -nolisten tcp &
  fluxbox >/tmp/fluxbox.log 2>&1 &
  x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 0.0.0.0 -xkb >/tmp/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc/ 0.0.0.0:7900 localhost:5900 >/tmp/novnc.log 2>&1 &

  echo "Visible browser mode enabled."
  echo "Open http://localhost:7900/vnc.html?autoconnect=1 to see the browser."
  sleep "${VISIBLE_STARTUP_SLEEP_SECONDS:-2}"
fi

exec node src/test.js
