#!/usr/bin/env sh
set -eu

BIN_NAME="clawdentity"
DEFAULT_DOWNLOADS_BASE_URL="https://downloads.clawdentity.com"
DEFAULT_SITE_BASE_URL="https://clawdentity.com"

DRY_RUN="${CLAWDENTITY_INSTALL_DRY_RUN:-0}"
NO_VERIFY="${CLAWDENTITY_NO_VERIFY:-0}"
VERSION_INPUT="${CLAWDENTITY_VERSION:-}"
INSTALL_DIR="${CLAWDENTITY_INSTALL_DIR:-}"
DOWNLOADS_BASE_URL="${CLAWDENTITY_DOWNLOADS_BASE_URL:-$DEFAULT_DOWNLOADS_BASE_URL}"
MANIFEST_URL_INPUT="${CLAWDENTITY_RELEASE_MANIFEST_URL:-}"
SITE_BASE_URL_INPUT="${CLAWDENTITY_SITE_BASE_URL:-}"
SKILL_URL_INPUT="${CLAWDENTITY_SKILL_URL:-}"

TAG=""
VERSION=""
PLATFORM=""
ASSET_BASE_URL=""
CHECKSUM_URL=""
manifest_path=""
tmp_dir=""

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

trim_trailing_slash() {
  value="$1"
  while [ "${value%/}" != "$value" ]; do
    value="${value%/}"
  done
  printf '%s\n' "$value"
}

resolve_manifest_url() {
  if [ -n "$MANIFEST_URL_INPUT" ]; then
    printf '%s\n' "$MANIFEST_URL_INPUT"
    return 0
  fi

  base_url="$(trim_trailing_slash "$DOWNLOADS_BASE_URL")"
  printf '%s\n' "${base_url}/rust/latest.json"
}

resolve_skill_url() {
  if [ -n "$SKILL_URL_INPUT" ]; then
    printf '%s\n' "$SKILL_URL_INPUT"
    return 0
  fi

  base_url="$DEFAULT_SITE_BASE_URL"
  if [ -n "$SITE_BASE_URL_INPUT" ]; then
    base_url="$SITE_BASE_URL_INPUT"
  fi

  base_url="$(trim_trailing_slash "$base_url")"
  printf '%s\n' "${base_url}/agent-skill.md"
}

extract_manifest_string() {
  key="$1"
  manifest_path="$2"
  awk -F'"' -v key="$key" '$2 == key { print $4; exit }' "$manifest_path"
}

resolve_latest_release_from_manifest() {
  manifest_url="$(resolve_manifest_url)"
  manifest_path="$1"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] fetching latest release metadata from ${manifest_url}"
    curl -fL --retry 3 --retry-delay 1 --connect-timeout 20 "$manifest_url" -o "$manifest_path"
  else
    download_file "$manifest_url" "$manifest_path"
  fi

  resolved_version="$(extract_manifest_string "version" "$manifest_path")"
  resolved_tag="$(extract_manifest_string "tag" "$manifest_path")"
  resolved_asset_base_url="$(extract_manifest_string "assetBaseUrl" "$manifest_path")"
  resolved_checksums_url="$(extract_manifest_string "checksumsUrl" "$manifest_path")"

  [ -n "${resolved_version:-}" ] || fail "release manifest is missing version"
  [ -n "${resolved_tag:-}" ] || fail "release manifest is missing tag"
  [ -n "${resolved_asset_base_url:-}" ] || fail "release manifest is missing assetBaseUrl"
  [ -n "${resolved_checksums_url:-}" ] || fail "release manifest is missing checksumsUrl"

  VERSION="$resolved_version"
  TAG="$resolved_tag"
  ASSET_BASE_URL="$resolved_asset_base_url"
  CHECKSUM_URL="$resolved_checksums_url"
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
    normalized_downloads_base_url="$(trim_trailing_slash "$DOWNLOADS_BASE_URL")"
    ASSET_BASE_URL="${normalized_downloads_base_url}/rust/v${VERSION}"
    CHECKSUM_URL="${ASSET_BASE_URL}/${BIN_NAME}-${VERSION}-checksums.txt"
  else
    manifest_path="$(mktemp)"
    resolve_latest_release_from_manifest "$manifest_path"
  fi

  asset_name="${BIN_NAME}-${VERSION}-${PLATFORM}.tar.gz"
  checksum_name="${BIN_NAME}-${VERSION}-checksums.txt"
  asset_url="${ASSET_BASE_URL}/${asset_name}"
  checksum_url="${CHECKSUM_URL}"
  target_path="${INSTALL_DIR}/${BIN_NAME}"
  skill_url="$(resolve_skill_url)"

  tmp_dir="$(mktemp -d)"
  asset_path="${tmp_dir}/${asset_name}"
  checksum_path="${tmp_dir}/${checksum_name}"
  extract_dir="${tmp_dir}/extract"

  cleanup() {
    if [ -d "$tmp_dir" ]; then
      rm -rf "$tmp_dir"
    fi
    if [ -n "$manifest_path" ]; then
      rm -f "$manifest_path"
    fi
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
    info "[dry-run] next step: use the onboarding prompt in ${skill_url}"
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
  info "next step: use the onboarding prompt in ${skill_url}"
  case ":${PATH:-}:" in
    *":${INSTALL_DIR}:"*) ;;
    *) warn "${INSTALL_DIR} is not on PATH; add it to your shell profile" ;;
  esac
}

main "$@"
