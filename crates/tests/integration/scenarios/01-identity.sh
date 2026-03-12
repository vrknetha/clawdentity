#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

check_identity() {
  local service="$1"
  local agent_name="$2"
  local expected_framework="$3"

  local did
  did="$(agent_did "${service}" "${agent_name}")"
  if [[ ! "${did}" =~ ^did:cdi:[a-z0-9.-]+:agent:[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
    fail "${service} did format invalid: ${did}"
  fi
  pass "${service} has valid agent DID"

  local framework
  framework="$(agent_framework "${service}" "${agent_name}")"
  assert_eq "${expected_framework}" "${framework}" "${service} framework"
}

check_identity "${PROVIDER_A_SERVICE}" "${PROVIDER_A_AGENT_NAME}" "${PROVIDER_A_FRAMEWORK}"
check_identity "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}" "${PROVIDER_B_FRAMEWORK}"
check_identity "${PROVIDER_C_SERVICE}" "${PROVIDER_C_AGENT_NAME}" "${PROVIDER_C_FRAMEWORK}"

pass "identity bootstrap verified for all providers"
