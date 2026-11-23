#!/bin/sh
set -eu

# Sovereign Linux installer for b8g-production-rack
# Usage:
#   curl -fsSL https://b8g.app/install.sh | sh
#   B8G_BASE_URL=http://127.0.0.1:8788 B8G_INSTALL_DIR=$HOME/.b8g-rack sh install.sh

B8G_BASE_URL="${B8G_BASE_URL:-https://b8g.app}"
B8G_BASE_URL="${B8G_BASE_URL%/}"

if [ -z "${B8G_INSTALL_DIR:-}" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    B8G_INSTALL_DIR="/opt/b8g-rack"
  else
    B8G_INSTALL_DIR="${HOME:-/tmp}/.b8g-rack"
  fi
fi

log() {
  printf '[b8g-rack] %s\n' "$*"
}

fail() {
  printf '[b8g-rack] ERROR: %s\n' "$*" >&2
  exit 1
}

OS="$(uname -s)"
if [ "$OS" != "Linux" ]; then
  fail "Unsupported operating system: $OS (this installer targets Linux)."
fi

RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  x86_64|amd64)
    ARCH="linux-x64"
    ;;
  aarch64|arm64)
    ARCH="linux-arm64"
    ;;
  *)
    fail "Unsupported CPU architecture: $RAW_ARCH (expected x86_64 or aarch64/arm64)."
    ;;
esac

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    fail "Neither curl nor wget was found in PATH."
  fi
}

extract_tarball_sha256() {
  manifest_path="$1"
  target_filename="$2"
  awk -v fname="$target_filename" '
    index($0, "\"" fname "\"") > 0 { found = 1 }
    found && /"sha256"[[:space:]]*:/ {
      line = $0
      sub(/^.*"sha256"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      if (length(line) == 64) {
        print line
        exit 0
      }
    }
  ' "$manifest_path"
}

verify_sha256() {
  file_path="$1"
  expected="$2"
  if [ -z "$expected" ]; then
    log "WARNING: Could not parse expected SHA-256 from manifest.json; skipping checksum verification."
    return 0
  fi

  actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file_path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  else
    log "WARNING: Neither sha256sum nor shasum found; skipping checksum verification."
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    fail "SHA-256 mismatch for $(basename "$file_path"): expected $expected, got $actual"
  fi
  log "SHA-256 verified: $actual"
}

TARBALL="b8g-production-rack-${ARCH}.tar.gz"
MANIFEST_URL="${B8G_BASE_URL}/releases/manifest.json"
TARBALL_URL="${B8G_BASE_URL}/releases/${TARBALL}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/b8g-rack.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

log "Target: ${ARCH} | Base URL: ${B8G_BASE_URL} | Install dir: ${B8G_INSTALL_DIR}"
log "Downloading ${MANIFEST_URL}..."
download_file "$MANIFEST_URL" "${TMP_DIR}/manifest.json"

log "Downloading ${TARBALL_URL}..."
download_file "$TARBALL_URL" "${TMP_DIR}/${TARBALL}"

EXPECTED_SHA256="$(extract_tarball_sha256 "${TMP_DIR}/manifest.json" "$TARBALL")"
verify_sha256 "${TMP_DIR}/${TARBALL}" "$EXPECTED_SHA256"

mkdir -p "$B8G_INSTALL_DIR"
log "Extracting ${TARBALL} into ${B8G_INSTALL_DIR}..."
tar -xzf "${TMP_DIR}/${TARBALL}" -C "$B8G_INSTALL_DIR"

if [ -d "${B8G_INSTALL_DIR}/bin" ]; then
  chmod +x "${B8G_INSTALL_DIR}/bin/"* 2>/dev/null || true
fi
if [ -f "${B8G_INSTALL_DIR}/install.sh" ]; then
  chmod +x "${B8G_INSTALL_DIR}/install.sh" 2>/dev/null || true
fi

log "Installation complete!"
printf '\n'
printf 'Next steps:\n'
printf '  1. Add binaries to your PATH:\n'
printf '       export PATH="%s/bin:$PATH"\n' "$B8G_INSTALL_DIR"
printf '  2. Verify the installed runtimes:\n'
printf '       %s/bin/b8g-shim --version\n' "$B8G_INSTALL_DIR"
printf '       %s/bin/sectium-es --help\n' "$B8G_INSTALL_DIR"
printf '       %s/bin/sectium-jvm --help\n' "$B8G_INSTALL_DIR"
printf '  3. Shared libraries installed in:\n'
printf '       %s/lib\n' "$B8G_INSTALL_DIR"
printf '  4. Local telemetry & 30-day renewable lease endpoints:\n'
printf '       %s/api/telemetry  (or UNIX socket /run/b8g/host-bus.sock)\n' "$B8G_BASE_URL"
printf '       %s/api/rack/lease (30-day renewable evaluation lease; graceful read-only on expiry, never destroys user data)\n' "$B8G_BASE_URL"
printf '       Policy file: %s/lease-policy.json\n' "$B8G_INSTALL_DIR"
printf '  5. Pull-on-View live viewer:\n'
printf '       %s\n' "$B8G_BASE_URL"
printf '\n'
