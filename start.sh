#!/bin/sh
# start.sh — Launch both services inside the Docker container.
# Node session manager starts first (bot.py tries to connect to it on startup).

set -e

echo "[start.sh] Starting Node.js session manager on port ${NODE_PORT:-3001}..."
node session_manager.js &
NODE_PID=$!

# Give Node a moment to bind its port before Python tries to connect
sleep 3

echo "[start.sh] Starting Python Telegram bot..."
python bot.py &
BOT_PID=$!

# If either process dies, kill the other and exit (Render will restart the container)
wait_for_exit() {
  while kill -0 $NODE_PID 2>/dev/null && kill -0 $BOT_PID 2>/dev/null; do
    sleep 5
  done
  echo "[start.sh] A process exited — shutting down container"
  kill $NODE_PID $BOT_PID 2>/dev/null || true
  exit 1
}

wait_for_exit
