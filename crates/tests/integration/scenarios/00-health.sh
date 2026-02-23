#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

wait_for_health "${MOCK_REGISTRY_URL}/health" "mock-registry"
wait_for_health "${MOCK_PROXY_URL}/health" "mock-proxy"
wait_for_health "http://127.0.0.1:${PROVIDER_A_CONNECTOR_HOST_PORT}/v1/status" "${PROVIDER_A_SERVICE} connector"
wait_for_health "http://127.0.0.1:${PROVIDER_B_CONNECTOR_HOST_PORT}/v1/status" "${PROVIDER_B_SERVICE} connector"
wait_for_health "http://127.0.0.1:${PROVIDER_C_CONNECTOR_HOST_PORT}/v1/status" "${PROVIDER_C_SERVICE} connector"

pass "all integration services are healthy"
