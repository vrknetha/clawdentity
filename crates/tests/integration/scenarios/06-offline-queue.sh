#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

did_b="$(agent_did "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}")"

before_pending_a="$(outbound_pending_count "${PROVIDER_A_SERVICE}")"
before_delivered_b="$(delivered_count "${PROVIDER_B_SERVICE}")"

pass "stopping mock-proxy to force outbound queueing"
compose stop mock-proxy >/dev/null

send_message "${PROVIDER_A_SERVICE}" "${did_b}" "offline queue test message" >/dev/null

queued=0
for _ in $(seq 1 45); do
  current_pending_a="$(outbound_pending_count "${PROVIDER_A_SERVICE}")"
  if (( current_pending_a > before_pending_a )); then
    queued=1
    pass "outbound queue increased while proxy offline (${before_pending_a} -> ${current_pending_a})"
    break
  fi
  sleep 1
done
if (( queued == 0 )); then
  fail "outbound queue did not increase while proxy was offline"
fi

pass "starting mock-proxy again"
compose up -d mock-proxy >/dev/null
wait_for_health "${MOCK_PROXY_URL}/health" "mock-proxy restarted" 90 1

flushed=0
for _ in $(seq 1 90); do
  current_pending_a="$(outbound_pending_count "${PROVIDER_A_SERVICE}")"
  if (( current_pending_a <= before_pending_a )); then
    flushed=1
    pass "outbound queue drained after proxy recovery"
    break
  fi
  sleep 1
done
if (( flushed == 0 )); then
  fail "outbound queue did not drain after proxy recovery"
fi

check_received "${PROVIDER_B_SERVICE}" "${before_delivered_b}" "offline queue replay to ${PROVIDER_B_SERVICE}" 90 1

pass "offline queue scenario succeeded"
