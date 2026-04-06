#!/usr/bin/env sh
set -eu

BIN_NAME="clawdentity"
DEFAULT_DOWNLOADS_BASE_URL="https://downloads.clawdentity.com"
DEFAULT_SITE_BASE_URL="https://clawdentity.com"
DEFAULT_RELEASE_MANIFEST_PATH="/rust/latest.json"
DEFAULT_LOCAL_RELEASE_MANIFEST_PATH="/rust/latest-local.json"
PATH_MARKER_BEGIN="# >>> clawdentity installer PATH >>>"
PATH_MARKER_END="# <<< clawdentity installer PATH <<<"

DRY_RUN="${CLAWDENTITY_INSTALL_DRY_RUN:-0}"
NO_VERIFY="${CLAWDENTITY_NO_VERIFY:-0}"
VERSION_INPUT="${CLAWDENTITY_VERSION:-}"
INSTALL_DIR="${CLAWDENTITY_INSTALL_DIR:-}"
DOWNLOADS_BASE_URL_INPUT="${CLAWDENTITY_DOWNLOADS_BASE_URL:-}"
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

resolve_shell_profile_path() {
  if [ -n "${CLAWDENTITY_SHELL_PROFILE:-}" ]; then
    printf '%s\n' "$CLAWDENTITY_SHELL_PROFILE"
    return 0
  fi

  if [ -z "${HOME:-}" ]; then
    return 1
  fi

  case "${SHELL:-}" in
    */zsh)
      if [ -n "${ZDOTDIR:-}" ]; then
        printf '%s\n' "${ZDOTDIR}/.zshrc"
      else
        printf '%s\n' "${HOME}/.zshrc"
      fi
      return 0
      ;;
    */bash)
      printf '%s\n' "${HOME}/.bashrc"
      return 0
      ;;
    *)
      printf '%s\n' "${HOME}/.profile"
      return 0
      ;;
  esac
}

ensure_install_dir_in_shell_profile() {
  install_dir="$1"
  profile_path="$2"

  profile_dir="$(dirname "$profile_path")"
  mkdir -p "$profile_dir"
  if [ ! -f "$profile_path" ]; then
    : > "$profile_path"
  fi

  tmp_profile="$(mktemp)"
  if grep -F "$PATH_MARKER_BEGIN" "$profile_path" >/dev/null 2>&1; then
    awk -v begin="$PATH_MARKER_BEGIN" -v end="$PATH_MARKER_END" '
      $0 == begin { skip = 1; next }
      $0 == end { skip = 0; next }
      skip != 1 { print }
    ' "$profile_path" > "$tmp_profile"
  else
    cat "$profile_path" > "$tmp_profile"
  fi

  {
    printf '%s\n' ""
    printf '%s\n' "$PATH_MARKER_BEGIN"
    printf '%s\n' "# Added by clawdentity install.sh so clawdentity is available in future shells."
    printf '%s\n' "if [ -d \"$install_dir\" ]; then"
    printf '%s\n' "  case \":\$PATH:\" in"
    printf '%s\n' "    *:\"$install_dir\":*) ;;"
    printf '%s\n' "    *) export PATH=\"$install_dir:\$PATH\" ;;"
    printf '%s\n' "  esac"
    printf '%s\n' "fi"
    printf '%s\n' "$PATH_MARKER_END"
  } >> "$tmp_profile"

  mv "$tmp_profile" "$profile_path"
}

ensure_path_ready() {
  install_dir="$1"
  case ":${PATH:-}:" in
    *":${install_dir}:"*) return 0 ;;
  esac

  if [ "$DRY_RUN" = "1" ]; then
    profile_path="$(resolve_shell_profile_path || true)"
    if [ -n "${profile_path:-}" ]; then
      info "[dry-run] would ensure ${install_dir} is present in ${profile_path}"
      info "[dry-run] would warn current shell to run: export PATH=\"${install_dir}:\$PATH\""
    else
      info "[dry-run] would warn ${install_dir} is not on PATH"
    fi
    return 0
  fi

  profile_path="$(resolve_shell_profile_path || true)"
  if [ -z "${profile_path:-}" ]; then
    warn "${install_dir} is not on PATH; set CLAWDENTITY_SHELL_PROFILE or add it manually"
    return 0
  fi

  if ensure_install_dir_in_shell_profile "$install_dir" "$profile_path"; then
    info "updated ${profile_path} so future shells include ${install_dir}"
    warn "${install_dir} is not on PATH in this current shell; run: export PATH=\"${install_dir}:\$PATH\""
  else
    warn "failed to update ${profile_path}; add ${install_dir} to PATH manually"
  fi
}

trim_trailing_slash() {
  value="$1"
  while [ "${value%/}" != "$value" ]; do
    value="${value%/}"
  done
  printf '%s\n' "$value"
}

uses_noncanonical_site_origin() {
  if [ -z "$SITE_BASE_URL_INPUT" ]; then
    return 1
  fi

  normalized_site_base_url="$(trim_trailing_slash "$SITE_BASE_URL_INPUT")"
  [ "$normalized_site_base_url" != "$DEFAULT_SITE_BASE_URL" ]
}

resolve_downloads_base_url() {
  if [ -n "$DOWNLOADS_BASE_URL_INPUT" ]; then
    trim_trailing_slash "$DOWNLOADS_BASE_URL_INPUT"
    return 0
  fi

  if uses_noncanonical_site_origin; then
    trim_trailing_slash "$SITE_BASE_URL_INPUT"
    return 0
  fi

  trim_trailing_slash "$DEFAULT_DOWNLOADS_BASE_URL"
}

should_use_site_origin_release_assets() {
  uses_noncanonical_site_origin || return 1
  [ -z "$DOWNLOADS_BASE_URL_INPUT" ] || return 1
  [ -z "$MANIFEST_URL_INPUT" ]
}

resolve_manifest_url() {
  if [ -n "$MANIFEST_URL_INPUT" ]; then
    printf '%s\n' "$MANIFEST_URL_INPUT"
    return 0
  fi

  if uses_noncanonical_site_origin && [ -z "$DOWNLOADS_BASE_URL_INPUT" ]; then
    site_base_url="$(trim_trailing_slash "$SITE_BASE_URL_INPUT")"
    printf '%s\n' "${site_base_url}${DEFAULT_LOCAL_RELEASE_MANIFEST_PATH}"
    return 0
  fi

  base_url="$(resolve_downloads_base_url)"
  printf '%s\n' "${base_url}${DEFAULT_RELEASE_MANIFEST_PATH}"
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
  printf '%s\n' "${base_url}/skill.md"
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

  if should_use_site_origin_release_assets; then
    site_base_url="$(trim_trailing_slash "$SITE_BASE_URL_INPUT")"
    ASSET_BASE_URL="${site_base_url}/rust/v${VERSION}"
    CHECKSUM_URL="${ASSET_BASE_URL}/${BIN_NAME}-${VERSION}-checksums.txt"
  fi
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
  need_cmd grep

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
    normalized_downloads_base_url="$(resolve_downloads_base_url)"
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
  ensure_path_ready "$INSTALL_DIR"
}

main "$@"
