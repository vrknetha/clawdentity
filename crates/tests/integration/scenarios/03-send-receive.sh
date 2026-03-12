#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

did_a="$(agent_did "${PROVIDER_A_SERVICE}" "${PROVIDER_A_AGENT_NAME}")"
did_b="$(agent_did "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}")"
did_c="$(agent_did "${PROVIDER_C_SERVICE}" "${PROVIDER_C_AGENT_NAME}")"

before_b="$(delivered_count "${PROVIDER_B_SERVICE}")"
send_message "${PROVIDER_A_SERVICE}" "${did_b}" "hello from ${PROVIDER_A_SERVICE}" >/dev/null
check_received "${PROVIDER_B_SERVICE}" "${before_b}" "${PROVIDER_A_SERVICE} -> ${PROVIDER_B_SERVICE}"

before_c="$(delivered_count "${PROVIDER_C_SERVICE}")"
send_message "${PROVIDER_B_SERVICE}" "${did_c}" "hello from ${PROVIDER_B_SERVICE}" >/dev/null
check_received "${PROVIDER_C_SERVICE}" "${before_c}" "${PROVIDER_B_SERVICE} -> ${PROVIDER_C_SERVICE}"

before_a="$(delivered_count "${PROVIDER_A_SERVICE}")"
send_message "${PROVIDER_C_SERVICE}" "${did_a}" "hello from ${PROVIDER_C_SERVICE}" >/dev/null
check_received "${PROVIDER_A_SERVICE}" "${before_a}" "${PROVIDER_C_SERVICE} -> ${PROVIDER_A_SERVICE}"

pass "send/receive loop across 3 providers succeeded"
