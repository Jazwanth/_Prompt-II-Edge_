#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
TOOLS_DIR="$ROOT_DIR/.tools"
TOOLS_BIN="$TOOLS_DIR/bin"
NODE_DIR="$TOOLS_DIR/node"
ARDUINO_DIR="$TOOLS_DIR/arduino"
NODE_MAJOR="${NODE_MAJOR:-22}"
PORT="${PORT:-5000}"
HOST="${HOST:-127.0.0.1}"
LOCAL_URL_HOST="${LOCAL_URL_HOST:-localhost}"
OPEN_URL="${OPEN_URL:-1}"
LOCAL_FALLBACK="${LOCAL_FALLBACK:-1}"
SETUP_ESP32="${SETUP_ESP32:-1}"
ESP32_PACKAGE_URL="${ESP32_PACKAGE_URL:-https://espressif.github.io/arduino-esp32/package_esp32_index.json}"
TUNNEL_ATTEMPTS="${TUNNEL_ATTEMPTS:-1}"
TUNNEL_WAIT_SECONDS="${TUNNEL_WAIT_SECONDS:-75}"
TUNNEL_PROTOCOL="${TUNNEL_PROTOCOL:-http2}"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prompt2edge.XXXXXX")"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_BUILD_LOG="$RUN_DIR/frontend-build.log"
BACKEND_INSTALL_LOG="$RUN_DIR/backend-install.log"
FRONTEND_INSTALL_LOG="$RUN_DIR/frontend-install.log"
NODE_INSTALL_LOG="$RUN_DIR/node-install.log"
CLOUDFLARED_INSTALL_LOG="$RUN_DIR/cloudflared-install.log"
ARDUINO_CLI_INSTALL_LOG="$RUN_DIR/arduino-cli-install.log"
ARDUINO_CLI_SETUP_LOG="$RUN_DIR/arduino-cli-setup.log"
TUNNEL_LOG="$RUN_DIR/tunnel.log"
BACKEND_PID=""
TUNNEL_PID=""
NAMED_TUNNEL_TOKEN=""
CONFIGURED_PUBLIC_URL=""
STARTED_BACKEND=0
KEEP_LOGS=0

mkdir -p "$TOOLS_BIN"
export PATH="$TOOLS_BIN:$NODE_DIR/bin:$PATH"
export ARDUINO_CONFIG_FILE="$ARDUINO_DIR/arduino-cli.yaml"
export ARDUINO_DIRECTORIES_DATA="$ARDUINO_DIR/data"
export ARDUINO_DIRECTORIES_DOWNLOADS="$ARDUINO_DIR/downloads"
export ARDUINO_DIRECTORIES_USER="$ARDUINO_DIR/user"
mkdir -p "$ARDUINO_DIRECTORIES_DATA" "$ARDUINO_DIRECTORIES_DOWNLOADS" "$ARDUINO_DIRECTORIES_USER"

cleanup() {
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi

  if [[ "$STARTED_BACKEND" == "1" && -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ "$KEEP_LOGS" != "1" ]]; then
    rm -rf "$RUN_DIR"
  fi
}

fail() {
  KEEP_LOGS=1
  printf 'Failed: %s\n' "$1" >&2
  printf 'Logs: %s\n' "$RUN_DIR" >&2
  exit 1
}

status() {
  printf '%s\n' "$1" >&2
}

trap cleanup EXIT INT TERM

status "Checking required tools..."
command -v curl >/dev/null 2>&1 || fail "curl is not installed or not on PATH"

download_node() {
  local os arch node_arch shasums tarball archive

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os:$arch" in
    Linux:x86_64 | Linux:amd64)
      node_arch="x64"
      ;;
    Linux:aarch64 | Linux:arm64)
      node_arch="arm64"
      ;;
    *)
      fail "Node.js is missing and automatic download only supports Linux x86_64/aarch64"
      ;;
  esac

  shasums="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" 2>>"$NODE_INSTALL_LOG")" ||
    fail "could not find latest Node.js v${NODE_MAJOR}.x"

  tarball="$(printf '%s\n' "$shasums" | awk '{print $2}' | grep "linux-${node_arch}.tar.xz$" | head -n 1 || true)"
  [[ -n "$tarball" ]] || fail "could not find Node.js Linux ${node_arch} build"

  archive="$RUN_DIR/$tarball"
  curl -fL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$tarball" \
    -o "$archive" >>"$NODE_INSTALL_LOG" 2>&1 ||
    fail "could not download Node.js"

  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$archive" -C "$NODE_DIR" --strip-components=1 >>"$NODE_INSTALL_LOG" 2>&1 ||
    fail "could not unpack Node.js"
}

if ! command -v npm >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh"
fi

command -v npm >/dev/null 2>&1 || download_node
command -v npm >/dev/null 2>&1 || fail "npm is not installed or not on PATH"

env_value() {
  local key="$1"
  local file="$2"

  [[ -f "$file" ]] || return 0

  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[ \t"'"'"']+|[ \t"'"'"']+$/, "", value)
      print value
      exit
    }
  ' "$file"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp="$RUN_DIR/env.$key"

  if [[ -f "$file" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      $0 ~ "^" key "=" {
        print key "=" value
        updated = 1
        next
      }
      { print }
      END {
        if (!updated) {
          print key "=" value
        }
      }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi

  mv "$tmp" "$file"
}

ensure_env_file() {
  local env_file="$BACKEND_DIR/.env"
  local key_value model_value

  if [[ ! -f "$env_file" ]]; then
    : >"$env_file"
    chmod 600 "$env_file" 2>/dev/null || true
  fi

  key_value="$(env_value GEMINI_API_KEY "$env_file")"

  if [[ -z "$key_value" && -n "${GEMINI_API_KEY:-}" ]]; then
    key_value="$GEMINI_API_KEY"
  fi

  if [[ -z "$key_value" && -t 0 ]]; then
    printf 'Gemini API key: ' >&2
    stty -echo
    read -r key_value
    stty echo
    printf '\n' >&2
  fi

  [[ -n "$key_value" ]] ||
    fail "GEMINI_API_KEY is missing. Add it to backend/.env or run GEMINI_API_KEY=your_key ./run-public.sh"

  model_value="$(env_value GEMINI_MODEL "$env_file")"
  [[ -n "$model_value" ]] || model_value="${GEMINI_MODEL:-gemini-2.5-flash}"

  set_env_value GEMINI_API_KEY "$key_value" "$env_file"
  set_env_value GEMINI_MODEL "$model_value" "$env_file"

  chmod 600 "$env_file" 2>/dev/null || true
}

load_tunnel_config() {
  local env_file="$BACKEND_DIR/.env"

  NAMED_TUNNEL_TOKEN="${CLOUDFLARED_TUNNEL_TOKEN:-}"
  CONFIGURED_PUBLIC_URL="${PUBLIC_URL:-}"

  [[ -n "$NAMED_TUNNEL_TOKEN" ]] ||
    NAMED_TUNNEL_TOKEN="$(env_value CLOUDFLARED_TUNNEL_TOKEN "$env_file")"

  [[ -n "$CONFIGURED_PUBLIC_URL" ]] ||
    CONFIGURED_PUBLIC_URL="$(env_value PUBLIC_URL "$env_file")"

  CONFIGURED_PUBLIC_URL="${CONFIGURED_PUBLIC_URL%/}"
}

open_public_url() {
  local url="$1"

  [[ "$OPEN_URL" == "0" ]] && return 0

  if command -v xdg-open >/dev/null 2>&1; then
    (xdg-open "$url" >/dev/null 2>&1 &)
  elif command -v gio >/dev/null 2>&1; then
    (gio open "$url" >/dev/null 2>&1 &)
  elif command -v open >/dev/null 2>&1; then
    (open "$url" >/dev/null 2>&1 &)
  elif command -v powershell.exe >/dev/null 2>&1; then
    (powershell.exe -NoProfile -Command "Start-Process '$url'" >/dev/null 2>&1 &)
  fi
}

publish_url() {
  local url="$1"

  open_public_url "$url"
  printf '%s\n' "$url"
  wait "$TUNNEL_PID"
  exit $?
}

publish_local_url() {
  local url="http://$LOCAL_URL_HOST:$PORT"

  status "Could not create a reachable Cloudflare URL. Opening local URL instead..."
  open_public_url "$url"
  printf '%s\n' "$url"

  if [[ "$STARTED_BACKEND" == "1" && -n "$BACKEND_PID" ]]; then
    wait "$BACKEND_PID"
  else
    while true; do
      sleep 3600
    done
  fi
}

download_cloudflared() {
  local os arch asset

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os:$arch" in
    Linux:x86_64 | Linux:amd64)
      asset="cloudflared-linux-amd64"
      ;;
    Linux:aarch64 | Linux:arm64)
      asset="cloudflared-linux-arm64"
      ;;
    *)
      fail "cloudflared is missing and automatic download only supports Linux x86_64/aarch64"
      ;;
  esac

  curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset" \
    -o "$TOOLS_BIN/cloudflared" >"$CLOUDFLARED_INSTALL_LOG" 2>&1 ||
    fail "could not download cloudflared"

  chmod +x "$TOOLS_BIN/cloudflared"
}

download_arduino_cli() {
  local installer="$RUN_DIR/install-arduino-cli.sh"

  curl -fsSL "https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh" \
    -o "$installer" >"$ARDUINO_CLI_INSTALL_LOG" 2>&1 ||
    fail "could not download arduino-cli installer"

  sh "$installer" -b "$TOOLS_BIN" >>"$ARDUINO_CLI_INSTALL_LOG" 2>&1 ||
    fail "could not install arduino-cli"
}

install_node_deps() {
  local dir="$1"
  local log_file="$2"

  if [[ ! -d "$dir/node_modules" ||
    "$dir/package.json" -nt "$dir/node_modules" ||
    ( -f "$dir/package-lock.json" && "$dir/package-lock.json" -nt "$dir/node_modules" ) ]]; then
    npm --prefix "$dir" install >"$log_file" 2>&1 ||
      fail "npm install failed in $dir"
  fi
}

setup_arduino_cli() {
  arduino-cli config init --overwrite >>"$ARDUINO_CLI_SETUP_LOG" 2>&1 || true
  arduino-cli config add board_manager.additional_urls "$ESP32_PACKAGE_URL" >>"$ARDUINO_CLI_SETUP_LOG" 2>&1 || true
  arduino-cli core update-index >>"$ARDUINO_CLI_SETUP_LOG" 2>&1 || true

  if [[ "$SETUP_ESP32" == "1" ]] &&
    ! arduino-cli core list 2>>"$ARDUINO_CLI_SETUP_LOG" | grep -q '^esp32:esp32[[:space:]]'; then
    arduino-cli core install esp32:esp32 >>"$ARDUINO_CLI_SETUP_LOG" 2>&1 || true
  fi
}

backend_ready() {
  curl -fsS --max-time 2 "http://$HOST:$PORT/serial/status" >/dev/null 2>&1 &&
    curl -fsS --max-time 2 "http://$HOST:$PORT/" | grep -q 'id="root"'
}

public_url_ready() {
  local url="$1"

  curl -fsS --max-time 5 "$url/serial/status" >/dev/null 2>&1 &&
    curl -fsS --max-time 5 "$url/" | grep -q 'id="root"'
}

command -v cloudflared >/dev/null 2>&1 || download_cloudflared
command -v arduino-cli >/dev/null 2>&1 || download_arduino_cli
command -v cloudflared >/dev/null 2>&1 || fail "cloudflared is not available"
command -v arduino-cli >/dev/null 2>&1 || fail "arduino-cli is not available"

status "Checking Gemini backend configuration..."
ensure_env_file

status "Preparing Arduino CLI. First run may download large board support files..."
setup_arduino_cli

status "Installing backend/frontend dependencies if needed..."
install_node_deps "$BACKEND_DIR" "$BACKEND_INSTALL_LOG"
install_node_deps "$FRONTEND_DIR" "$FRONTEND_INSTALL_LOG"

status "Building frontend..."
npm --prefix "$FRONTEND_DIR" run build >"$FRONTEND_BUILD_LOG" 2>&1 || fail "frontend build failed"

status "Starting backend..."
if curl -fsS --max-time 2 "http://$HOST:$PORT/serial/status" >/dev/null 2>&1; then
  backend_ready ||
    fail "port $PORT is already in use by a server that is not serving this project"
else
  (
    cd "$BACKEND_DIR"
    HOST="$HOST" PORT="$PORT" npm start
  ) >"$BACKEND_LOG" 2>&1 &

  BACKEND_PID="$!"
  STARTED_BACKEND=1

  for _ in {1..60}; do
    if curl -fsS --max-time 2 "http://$HOST:$PORT/serial/status" >/dev/null 2>&1; then
      break
    fi

    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      fail "backend stopped while starting"
    fi

    sleep 1
  done
fi

backend_ready ||
  fail "backend did not start on http://$HOST:$PORT"

load_tunnel_config

if [[ -n "$NAMED_TUNNEL_TOKEN" ]]; then
  [[ -n "$CONFIGURED_PUBLIC_URL" ]] ||
    fail "CLOUDFLARED_TUNNEL_TOKEN is set, but PUBLIC_URL is missing in backend/.env"

  status "Starting configured Cloudflare Tunnel..."
  : >"$TUNNEL_LOG"
  cloudflared tunnel --protocol "$TUNNEL_PROTOCOL" --no-autoupdate run --token "$NAMED_TUNNEL_TOKEN" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID="$!"

  status "Waiting for configured Cloudflare hostname..."
  for second in $(seq 1 "$TUNNEL_WAIT_SECONDS"); do
    if public_url_ready "$CONFIGURED_PUBLIC_URL"; then
      publish_url "$CONFIGURED_PUBLIC_URL"
    fi

    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      fail "configured Cloudflare Tunnel stopped while starting"
    fi

    if (( second % 30 == 0 )); then
      status "Still waiting for configured Cloudflare hostname..."
    fi

    sleep 1
  done

  status "Configured Cloudflare hostname was not reachable."
  if [[ "$LOCAL_FALLBACK" == "1" ]]; then
    publish_local_url
  fi

  fail "could not reach configured Cloudflare hostname"
fi

status "Creating public Cloudflare URL..."
PUBLIC_URL=""

for attempt in $(seq 1 "$TUNNEL_ATTEMPTS"); do
  reported_url=""
  : >"$TUNNEL_LOG"
  cloudflared tunnel --protocol "$TUNNEL_PROTOCOL" --url "http://$HOST:$PORT" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID="$!"

  for second in $(seq 1 "$TUNNEL_WAIT_SECONDS"); do
    PUBLIC_URL="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)"

    if [[ -n "$PUBLIC_URL" ]]; then
      if [[ "$reported_url" != "$PUBLIC_URL" ]]; then
        status "Cloudflare created $PUBLIC_URL. Waiting for DNS to become reachable..."
        reported_url="$PUBLIC_URL"
      elif (( second % 30 == 0 )); then
        status "Still waiting for Cloudflare DNS..."
      fi

      if public_url_ready "$PUBLIC_URL"; then
        publish_url "$PUBLIC_URL"
      fi
    fi

    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      break
    fi

    sleep 1
  done

  if kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi

  TUNNEL_PID=""

  if (( attempt < TUNNEL_ATTEMPTS )); then
    status "Cloudflare URL was not reachable. Retrying tunnel ($attempt/$TUNNEL_ATTEMPTS)..."
    sleep 2
  else
    status "Cloudflare URL was not reachable."
  fi
done

if [[ "$LOCAL_FALLBACK" == "1" ]]; then
  publish_local_url
fi

fail "could not get a reachable Cloudflare tunnel URL"
