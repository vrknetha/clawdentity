#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO_DIR="${SCRIPT_DIR}/../scenarios"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

scenarios=(
  "00-health.sh"
  "01-identity.sh"
  "02-pairing.sh"
  "03-send-receive.sh"
  "04-round-trip.sh"
  "05-mesh.sh"
  "06-offline-queue.sh"
)
# TODO: add dead-letter API scenarios (replay, purge)

passed=0
failed=0

for scenario in "${scenarios[@]}"; do
  script_path="${SCENARIO_DIR}/${scenario}"
  printf '\n== Running %s ==\n' "${scenario}"
  if "${script_path}"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    printf 'Scenario failed: %s\n' "${scenario}" >&2
  fi
done

printf '\nSummary: %s passed, %s failed\n' "${passed}" "${failed}"
if (( failed > 0 )); then
  exit 1
fi
