#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

did_a="$(agent_did "${PROVIDER_A_SERVICE}" "${PROVIDER_A_AGENT_NAME}")"
did_b="$(agent_did "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}")"

before_b="$(delivered_count "${PROVIDER_B_SERVICE}")"
send_message "${PROVIDER_A_SERVICE}" "${did_b}" "round-trip step 1 from ${PROVIDER_A_SERVICE}" >/dev/null
check_received "${PROVIDER_B_SERVICE}" "${before_b}" "round-trip ${PROVIDER_A_SERVICE} -> ${PROVIDER_B_SERVICE}"

before_a="$(delivered_count "${PROVIDER_A_SERVICE}")"
send_message "${PROVIDER_B_SERVICE}" "${did_a}" "round-trip step 2 from ${PROVIDER_B_SERVICE}" >/dev/null
check_received "${PROVIDER_A_SERVICE}" "${before_a}" "round-trip ${PROVIDER_B_SERVICE} -> ${PROVIDER_A_SERVICE}"

pass "round-trip message exchange succeeded"
