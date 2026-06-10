#!/usr/bin/env sh
set -eu

if [ "$(uname -s)" = "Darwin" ]; then
  case "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" in
    *C.UTF-8*)
      export LC_ALL=C
      export LC_CTYPE=C
      export LANG=C
      ;;
  esac
fi

PACKAGE_NAME=""
OUTPUT_DIR=""
INCLUDE_EXISTING_DIST=0
BUILD_CURRENT=0
KEEP_STAGE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/package.sh [options]

Options:
  --package-name NAME       Set the zip and staging directory name.
  --output-dir DIR          Set the output directory. Defaults to ./release.
  --include-existing-dist   Include native-host/dist when it exists.
  --build-current           Build the native host for this OS/CPU first.
  --keep-stage              Keep the staging directory after creating the zip.
  -h, --help                Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-name)
      PACKAGE_NAME="${2:-}"
      shift 2
      ;;
    --package-name=*)
      PACKAGE_NAME="${1#*=}"
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --output-dir=*)
      OUTPUT_DIR="${1#*=}"
      shift
      ;;
    --include-existing-dist)
      INCLUDE_EXISTING_DIST=1
      shift
      ;;
    --build-current)
      BUILD_CURRENT=1
      INCLUDE_EXISTING_DIST=1
      shift
      ;;
    --keep-stage)
      KEEP_STAGE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NATIVE_DIR="$ROOT_DIR/native-host"
RELEASE_DIR="${OUTPUT_DIR:-$ROOT_DIR/release}"
STAMP=$(date +"%Y%m%d-%H%M%S")

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 was not found. $2" >&2
    exit 1
  fi
}

platform_name() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *)
      echo "Unsupported OS for native host build: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

arch_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported CPU architecture for native host build: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

if [ "$BUILD_CURRENT" -eq 1 ]; then
  DEFAULT_NAME="chaoxing-weixin-study-helper-$(platform_name)-$(arch_name)-$STAMP"
elif [ "$INCLUDE_EXISTING_DIST" -eq 1 ]; then
  DEFAULT_NAME="chaoxing-weixin-study-helper-with-dist-$STAMP"
else
  DEFAULT_NAME="chaoxing-weixin-study-helper-source-$STAMP"
fi
NAME="${PACKAGE_NAME:-$DEFAULT_NAME}"
STAGE="$RELEASE_DIR/$NAME"
ZIP_PATH="$STAGE.zip"

assert_in_root() {
  path_to_check="$1"
  base="$2"
  node - "$path_to_check" "$base" <<'EOF'
const path = require("path");
const target = path.resolve(process.argv[2]);
const base = path.resolve(process.argv[3]);
const relative = path.relative(base, target);
if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  console.error(`Refusing to touch path outside expected directory: ${target}`);
  process.exit(1);
}
EOF
}

check_json() {
  require_tool node "Install Node.js 22 or newer before packaging."
  for file in \
    "$ROOT_DIR/extension/manifest.json" \
    "$NATIVE_DIR/package.json" \
    "$NATIVE_DIR/package-lock.json"
  do
    node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));' "$file"
  done
}

check_js() {
  require_tool node "Install Node.js 22 or newer before packaging."
  for file in \
    "$ROOT_DIR/extension/background/background.js" \
    "$ROOT_DIR/extension/popup/popup.js" \
    "$NATIVE_DIR/host.mjs" \
    "$NATIVE_DIR/src/host.mjs" \
    "$ROOT_DIR"/extension/content/*.js
  do
    node --check "$file" >/dev/null
  done
}

build_current_native_host() {
  require_tool npm "Install Node.js 22 or newer before building native host binaries."
  platform=$(platform_name)
  arch=$(arch_name)
  script="build:$platform:$arch"

  (cd "$NATIVE_DIR" && npm install && npm run "$script")

  output="$NATIVE_DIR/dist/$platform-$arch/chaoxing-weixin-native-host"
  if [ "$platform" = "win" ]; then
    output="$output.exe"
  fi
  if [ ! -f "$output" ]; then
    echo "Native host build finished without expected output: $output" >&2
    exit 1
  fi
}

copy_project_item() {
  item="$1"
  source="$ROOT_DIR/$item"
  if [ ! -e "$source" ]; then
    echo "Required package item not found: $source" >&2
    exit 1
  fi
  cp -R "$source" "$STAGE/"
}

copy_native_host() {
  target="$STAGE/native-host"
  mkdir -p "$target"

  for item in \
    host.mjs \
    package.json \
    package-lock.json \
    run-host.cmd \
    run-host.sh \
    com.audio_check.weixin_monitor.chrome.json \
    com.audio_check.weixin_monitor.edge.json
  do
    cp "$NATIVE_DIR/$item" "$target/"
  done

  cp -R "$NATIVE_DIR/src" "$target/"
  cp -R "$NATIVE_DIR/scripts" "$target/"

  if [ "$INCLUDE_EXISTING_DIST" -eq 1 ] && [ -d "$NATIVE_DIR/dist" ]; then
    cp -R "$NATIVE_DIR/dist" "$target/"
  fi
}

remove_package_exclusions() {
  find "$STAGE" \( -type d \( -name node_modules -o -name .state -o -name .git \) -prune -exec rm -rf {} + \) -o \
    \( -type f -name "*.generated.json" -exec rm -f {} + \)
}

new_root_extension_manifest() {
  node - "$STAGE/extension/manifest.json" "$STAGE/manifest.json" <<'EOF'
const fs = require("fs");
const source = process.argv[2];
const target = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(source, "utf8"));

if (manifest.background && manifest.background.service_worker) {
  manifest.background.service_worker = `extension/${manifest.background.service_worker}`;
}

for (const script of manifest.content_scripts || []) {
  script.js = (script.js || []).map((file) => `extension/${file}`);
}

if (manifest.action && manifest.action.default_popup) {
  manifest.action.default_popup = `extension/${manifest.action.default_popup}`;
}

manifest.description = `${manifest.description} Packaged root manifest; loading this folder or the extension folder both work.`;
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
EOF
}

validate_zip() {
  require_tool unzip "Install unzip before packaging."
  bad_entries=$(unzip -Z1 "$ZIP_PATH" | grep -E '(^|/)(node_modules|\.state|\.git)(/|$)|generated\.json' || true)
  if [ -n "$bad_entries" ]; then
    echo "Package contains excluded entries:" >&2
    printf '%s\n' "$bad_entries" >&2
    exit 1
  fi
}

if [ "$BUILD_CURRENT" -eq 1 ]; then
  build_current_native_host
fi

check_json
check_js
require_tool zip "Install zip before packaging."

mkdir -p "$RELEASE_DIR"

if [ -e "$STAGE" ]; then
  assert_in_root "$STAGE" "$RELEASE_DIR"
  rm -rf "$STAGE"
fi
if [ -e "$ZIP_PATH" ]; then
  assert_in_root "$ZIP_PATH" "$RELEASE_DIR"
  rm -f "$ZIP_PATH"
fi

mkdir -p "$STAGE"
for item in extension scripts docs install.cmd install.sh README.md package.cmd package-source.cmd; do
  copy_project_item "$item"
done
copy_native_host
remove_package_exclusions
new_root_extension_manifest

(cd "$RELEASE_DIR" && zip -qr "$ZIP_PATH" "$NAME")
validate_zip

if command -v shasum >/dev/null 2>&1; then
  HASH=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
else
  HASH=$(openssl dgst -sha256 "$ZIP_PATH" | awk '{print $NF}')
fi
ENTRY_COUNT=$(unzip -Z1 "$ZIP_PATH" | wc -l | tr -d ' ')
SIZE_MB=$(node -e 'const fs=require("fs"); console.log((fs.statSync(process.argv[1]).size / 1024 / 1024).toFixed(3));' "$ZIP_PATH")

if [ "$KEEP_STAGE" -eq 0 ]; then
  assert_in_root "$STAGE" "$RELEASE_DIR"
  rm -rf "$STAGE"
fi

echo ""
echo "Package created:"
echo "  $ZIP_PATH"
echo "Size:"
echo "  $SIZE_MB MB"
echo "SHA256:"
echo "  $HASH"
echo "Entries:"
echo "  $ENTRY_COUNT"

if [ "$INCLUDE_EXISTING_DIST" -eq 0 ]; then
  echo ""
  echo "Note: this is a source package. The target machine needs Node.js 22+ and npm; install.sh/install.cmd will run npm install."
fi
