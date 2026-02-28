#!/bin/bash
set -e

DISPLAY="${DISPLAY:-:99}"
SCREEN_RESOLUTION="${SCREEN_RESOLUTION:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
export DISPLAY

# Fix volume-mounted directory permissions
if [ ! -w "$HOME" ]; then
  sudo chown -R claude:claude /home/claude
fi

# Xvfb (virtual display)
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_RESOLUTION}" -ac +extension GLX +render -noreset &
for i in $(seq 1 10); do
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 0.3
done

# D-Bus (required by Chromium)
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
fi

# Window manager
fluxbox &>/dev/null &

# VNC server
x11vnc -display "${DISPLAY}" -forever -shared -nopw -rfbport "${VNC_PORT}" \
  -xkb -noxrecord -noxfixes -noxdamage &>/dev/null &

# noVNC (websockify)
websockify --web="/usr/share/novnc" "${NOVNC_PORT}" "localhost:${VNC_PORT}" &>/dev/null &

echo "[entrypoint] noVNC ready at http://localhost:${NOVNC_PORT}/vnc.html"

# Run bot or passed command
if [ $# -eq 0 ]; then
  exec node /app/bot.js
else
  exec "$@"
fi
