#!/usr/bin/env sh
set -eu

BROWSER="all"
SKIP_OPEN=0
HOST_NAME="com.audio_check.weixin_monitor"
EXTENSION_ID="eonlhegegglcnbkkpnaodelidpiocbmh"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --browser)
      BROWSER="${2:-}"
      shift 2
      ;;
    --browser=*)
      BROWSER="${1#*=}"
      shift
      ;;
    --skip-open)
      SKIP_OPEN=1
      shift
      ;;
    -h|--help)
      echo "Usage: ./install.sh [--browser chrome|edge|all] [--skip-open]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

case "$BROWSER" in
  chrome|edge|all) ;;
  Chrome) BROWSER="chrome" ;;
  Edge) BROWSER="edge" ;;
  All) BROWSER="all" ;;
  *)
    echo "Invalid browser: $BROWSER" >&2
    exit 1
    ;;
esac

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EXTENSION_DIR="$ROOT_DIR/extension"
NATIVE_DIR="$ROOT_DIR/native-host"

platform_name() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

arch_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported CPU architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

find_packaged_host() {
  platform=$(platform_name)
  arch=$(arch_name)
  candidate="$NATIVE_DIR/dist/$platform-$arch/chaoxing-weixin-native-host"
  if [ -f "$candidate" ]; then
    echo "$candidate"
    return
  fi
  candidate="$NATIVE_DIR/dist/chaoxing-weixin-native-host"
  if [ -f "$candidate" ]; then
    echo "$candidate"
    return
  fi
  echo ""
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 was not found. $2" >&2
    exit 1
  fi
}

check_node_version() {
  require_tool node "Install Node.js 22 or newer, then run ./install.sh again: https://nodejs.org/"
  version=$(node --version)
  major=$(printf '%s' "$version" | sed -E 's/^v?([0-9]+).*/\1/')
  if [ "$major" -lt 22 ] 2>/dev/null; then
    echo "Node.js $version is too old. Install Node.js 22 or newer, then run ./install.sh again." >&2
    exit 1
  fi
}

browser_manifest_dir() {
  target="$1"
  platform=$(platform_name)
  if [ "$platform" = "macos" ]; then
    case "$target" in
      chrome) echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
      edge) echo "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
    esac
  else
    case "$target" in
      chrome) echo "$HOME/.config/google-chrome/NativeMessagingHosts" ;;
      edge) echo "$HOME/.config/microsoft-edge/NativeMessagingHosts" ;;
    esac
  fi
}

write_manifest() {
  target="$1"
  host_path="$2"
  manifest_dir=$(browser_manifest_dir "$target")
  manifest_path="$manifest_dir/$HOST_NAME.json"

  mkdir -p "$manifest_dir"
  cat > "$manifest_path" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Chaoxing Weixin Study Helper native host",
  "path": "$host_path",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

  echo "Registered native host for $target:"
  echo "  $manifest_path"
}

open_extensions_page() {
  target="$1"
  platform=$(platform_name)
  if [ "$platform" = "macos" ]; then
    if [ "$target" = "chrome" ]; then
      open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true
    else
      open -a "Microsoft Edge" "edge://extensions" >/dev/null 2>&1 || true
    fi
    return
  fi

  if [ "$target" = "chrome" ]; then
    for exe in google-chrome google-chrome-stable chromium chromium-browser; do
      if command -v "$exe" >/dev/null 2>&1; then
        "$exe" "chrome://extensions" >/dev/null 2>&1 &
        return
      fi
    done
  else
    for exe in microsoft-edge microsoft-edge-stable; do
      if command -v "$exe" >/dev/null 2>&1; then
        "$exe" "edge://extensions" >/dev/null 2>&1 &
        return
      fi
    done
  fi
}

PACKAGED_HOST=$(find_packaged_host)
if [ -n "$PACKAGED_HOST" ]; then
  HOST_PATH="$PACKAGED_HOST"
  chmod +x "$HOST_PATH" || true
  echo "Using packaged native host:"
  echo "  $HOST_PATH"
else
  echo "Packaged native host was not found. Falling back to development mode with Node.js."
  check_node_version
  require_tool npm "Install Node.js 22 or newer, then run ./install.sh again: https://nodejs.org/"
  (cd "$NATIVE_DIR" && npm install)
  HOST_PATH="$NATIVE_DIR/run-host.sh"
  chmod +x "$HOST_PATH"
fi

case "$BROWSER" in
  chrome) TARGETS="chrome" ;;
  edge) TARGETS="edge" ;;
  all) TARGETS="chrome edge" ;;
esac

for target in $TARGETS; do
  write_manifest "$target" "$HOST_PATH"
done

if [ "$SKIP_OPEN" -eq 0 ]; then
  for target in $TARGETS; do
    open_extensions_page "$target"
  done
fi

echo ""
echo "Install finished."
echo "Extension ID: $EXTENSION_ID"
echo "Extension folder: $EXTENSION_DIR"
echo ""
echo "If the browser extension is not loaded yet:"
echo "  1. Enable Developer mode on the extensions page."
echo "  2. Click Load unpacked."
echo "  3. Select the extension folder shown above."
