#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

did_a="$(agent_did "${PROVIDER_A_SERVICE}" "${PROVIDER_A_AGENT_NAME}")"
did_b="$(agent_did "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}")"
did_c="$(agent_did "${PROVIDER_C_SERVICE}" "${PROVIDER_C_AGENT_NAME}")"

count_a="$(delivered_count "${PROVIDER_A_SERVICE}")"
count_b="$(delivered_count "${PROVIDER_B_SERVICE}")"
count_c="$(delivered_count "${PROVIDER_C_SERVICE}")"

send_message "${PROVIDER_A_SERVICE}" "${did_b}" "mesh A->B" >/dev/null
check_received "${PROVIDER_B_SERVICE}" "${count_b}" "mesh ${PROVIDER_A_SERVICE} -> ${PROVIDER_B_SERVICE}"
count_b="$(delivered_count "${PROVIDER_B_SERVICE}")"

send_message "${PROVIDER_A_SERVICE}" "${did_c}" "mesh A->C" >/dev/null
check_received "${PROVIDER_C_SERVICE}" "${count_c}" "mesh ${PROVIDER_A_SERVICE} -> ${PROVIDER_C_SERVICE}"
count_c="$(delivered_count "${PROVIDER_C_SERVICE}")"

send_message "${PROVIDER_B_SERVICE}" "${did_a}" "mesh B->A" >/dev/null
check_received "${PROVIDER_A_SERVICE}" "${count_a}" "mesh ${PROVIDER_B_SERVICE} -> ${PROVIDER_A_SERVICE}"
count_a="$(delivered_count "${PROVIDER_A_SERVICE}")"

send_message "${PROVIDER_B_SERVICE}" "${did_c}" "mesh B->C" >/dev/null
check_received "${PROVIDER_C_SERVICE}" "${count_c}" "mesh ${PROVIDER_B_SERVICE} -> ${PROVIDER_C_SERVICE}"
count_c="$(delivered_count "${PROVIDER_C_SERVICE}")"

send_message "${PROVIDER_C_SERVICE}" "${did_a}" "mesh C->A" >/dev/null
check_received "${PROVIDER_A_SERVICE}" "${count_a}" "mesh ${PROVIDER_C_SERVICE} -> ${PROVIDER_A_SERVICE}"
count_a="$(delivered_count "${PROVIDER_A_SERVICE}")"

send_message "${PROVIDER_C_SERVICE}" "${did_b}" "mesh C->B" >/dev/null
check_received "${PROVIDER_B_SERVICE}" "${count_b}" "mesh ${PROVIDER_C_SERVICE} -> ${PROVIDER_B_SERVICE}"

pass "full 3-provider mesh delivery succeeded"
