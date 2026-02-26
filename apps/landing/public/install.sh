#!/usr/bin/env sh
set -eu

REPO="vrknetha/clawdentity"
BIN_NAME="clawdentity"

DRY_RUN="${CLAWDENTITY_INSTALL_DRY_RUN:-0}"
NO_VERIFY="${CLAWDENTITY_NO_VERIFY:-0}"
VERSION_INPUT="${CLAWDENTITY_VERSION:-}"
INSTALL_DIR="${CLAWDENTITY_INSTALL_DIR:-}"

TAG=""
VERSION=""
PLATFORM=""

info() {
  printf '%s\n' "clawdentity installer: $*"
}

warn() {
  printf '%s\n' "clawdentity installer: warning: $*" >&2
}

fail() {
  printf '%s\n' "clawdentity installer: error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

resolve_latest_tag() {
  latest_url="https://api.github.com/repos/${REPO}/releases/latest"
  releases_url="https://api.github.com/repos/${REPO}/releases?per_page=100"

  latest_tag="$(
    curl -fsSL "$latest_url" 2>/dev/null \
      | awk -F'"' '/"tag_name":[[:space:]]*"[^"]+"/ { print $4; exit }'
  )"
  case "${latest_tag:-}" in
    rust/v*) printf '%s\n' "$latest_tag"; return 0 ;;
  esac

  fallback_tag="$(
    curl -fsSL "$releases_url" \
      | awk -F'"' '/"tag_name":[[:space:]]*"rust\/v[0-9]+\.[0-9]+\.[0-9]+"/ { print $4; exit }'
  )"
  [ -n "${fallback_tag:-}" ] || return 1
  printf '%s\n' "$fallback_tag"
}

set_version_from_input() {
  input="$1"
  case "$input" in
    rust/v*)
      TAG="$input"
      VERSION="${input#rust/v}"
      ;;
    v*)
      VERSION="${input#v}"
      TAG="rust/v${VERSION}"
      ;;
    *)
      VERSION="$input"
      TAG="rust/v${VERSION}"
      ;;
  esac
}

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux) os_part="linux" ;;
    Darwin) os_part="macos" ;;
    *) fail "unsupported OS: $os (supported: Linux, Darwin)" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch_part="x86_64" ;;
    arm64|aarch64) arch_part="aarch64" ;;
    *) fail "unsupported architecture: $arch (supported: x86_64, arm64/aarch64)" ;;
  esac

  PLATFORM="${os_part}-${arch_part}"
}

download_file() {
  url="$1"
  output_path="$2"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] curl -fL --retry 3 --retry-delay 1 '$url' -o '$output_path'"
    return 0
  fi

  curl -fL --retry 3 --retry-delay 1 --connect-timeout 20 "$url" -o "$output_path"
}

sha256_file() {
  file_path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{ print $1 }'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{ print $1 }'
    return 0
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file_path" | awk '{ print $NF }'
    return 0
  fi

  return 1
}

main() {
  need_cmd curl
  need_cmd uname
  need_cmd tar
  need_cmd mktemp
  need_cmd awk
  need_cmd find

  detect_platform

  if [ -z "$INSTALL_DIR" ]; then
    if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
      INSTALL_DIR="/usr/local/bin"
    else
      INSTALL_DIR="${HOME:-$PWD}/.local/bin"
    fi
  fi

  if [ -n "$VERSION_INPUT" ]; then
    set_version_from_input "$VERSION_INPUT"
  else
    [ "$DRY_RUN" = "1" ] && info "resolving latest rust/v* release tag from GitHub"
    latest_tag="$(resolve_latest_tag)" || fail "could not resolve latest rust/v* release tag"
    set_version_from_input "$latest_tag"
  fi

  asset_name="${BIN_NAME}-${VERSION}-${PLATFORM}.tar.gz"
  checksum_name="${BIN_NAME}-${VERSION}-checksums.txt"
  base_url="https://github.com/${REPO}/releases/download/${TAG}"
  asset_url="${base_url}/${asset_name}"
  checksum_url="${base_url}/${checksum_name}"
  target_path="${INSTALL_DIR}/${BIN_NAME}"

  tmp_dir="$(mktemp -d)"
  asset_path="${tmp_dir}/${asset_name}"
  checksum_path="${tmp_dir}/${checksum_name}"
  extract_dir="${tmp_dir}/extract"

  cleanup() {
    [ -d "$tmp_dir" ] && rm -rf "$tmp_dir"
  }
  trap cleanup EXIT INT TERM

  info "tag: ${TAG}"
  info "platform: ${PLATFORM}"
  info "install dir: ${INSTALL_DIR}"
  info "download: ${asset_url}"

  download_file "$asset_url" "$asset_path"

  if [ "$NO_VERIFY" = "1" ]; then
    warn "checksum verification disabled (CLAWDENTITY_NO_VERIFY=1)"
  else
    download_file "$checksum_url" "$checksum_path"
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] would verify SHA256 for ${asset_name}"
    else
      expected_sha="$(
        awk -v asset="$asset_name" '
          {
            file = $2
            sub(/^\*/, "", file)
            if (file == asset) {
              print $1
              exit
            }
          }
        ' "$checksum_path"
      )"
      [ -n "${expected_sha:-}" ] || fail "could not find checksum for ${asset_name} in ${checksum_name}"

      actual_sha="$(sha256_file "$asset_path")" || fail "no SHA256 tool found (sha256sum/shasum/openssl)"
      [ "$actual_sha" = "$expected_sha" ] || fail "checksum mismatch for ${asset_name}"
      info "checksum verified"
    fi
  fi

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] mkdir -p '${INSTALL_DIR}'"
    info "[dry-run] tar -xzf '${asset_path}' -C '${extract_dir}'"
    info "[dry-run] install binary to '${target_path}'"
    info "[dry-run] next step: use the onboarding prompt in https://clawdentity.com/skill.md"
    info "[dry-run] complete"
    exit 0
  fi

  mkdir -p "$extract_dir"
  tar -xzf "$asset_path" -C "$extract_dir"

  binary_path="$(find "$extract_dir" -type f -name "$BIN_NAME" -print | head -n 1)"
  [ -n "${binary_path:-}" ] || fail "could not find ${BIN_NAME} inside ${asset_name}"

  mkdir -p "$INSTALL_DIR"
  [ -w "$INSTALL_DIR" ] || fail "install dir is not writable: ${INSTALL_DIR} (set CLAWDENTITY_INSTALL_DIR)"

  if command -v install >/dev/null 2>&1; then
    install -m 0755 "$binary_path" "$target_path"
  else
    cp "$binary_path" "$target_path"
    chmod 0755 "$target_path"
  fi

  info "installed ${BIN_NAME} to ${target_path}"
  info "next step: use the onboarding prompt in https://clawdentity.com/skill.md"
  case ":${PATH:-}:" in
    *":${INSTALL_DIR}:"*) ;;
    *) warn "${INSTALL_DIR} is not on PATH; add it to your shell profile" ;;
  esac
}

main "$@"
