#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../runner/lib.sh"

pair_agents() {
  local initiator_service="$1"
  local initiator_agent="$2"
  local responder_service="$3"
  local responder_agent="$4"

  local initiator_did responder_did initiator_ait responder_ait
  initiator_did="$(agent_did "${initiator_service}" "${initiator_agent}")"
  responder_did="$(agent_did "${responder_service}" "${responder_agent}")"
  initiator_ait="$(agent_ait "${initiator_service}" "${initiator_agent}")"
  responder_ait="$(agent_ait "${responder_service}" "${responder_agent}")"

  local ts nonce start_payload start_response ticket confirm_payload confirm_response status_response
  ts="$(date +%s)"
  nonce="pair-$(date +%s%N)"

  start_payload="$(jq -nc \
    --arg proxy "${MOCK_PROXY_URL}" \
    --arg initiator_name "${initiator_agent}" \
    '{ttlSeconds: 300, initiatorProfile: {agentName: $initiator_name, humanName: "Integration Initiator", proxyOrigin: $proxy}}')"

  start_response="$(curl -fsS -X POST "${MOCK_PROXY_URL}/pair/start" \
    -H "Authorization: Claw ${initiator_ait}" \
    -H "Content-Type: application/json" \
    -H "X-Claw-Timestamp: ${ts}" \
    -H "X-Claw-Nonce: ${nonce}" \
    -H "X-Claw-Body-SHA256: integration" \
    -H "X-Claw-Proof: integration" \
    --data "${start_payload}")"

  ticket="$(jq -r '.ticket' <<<"${start_response}")"
  if [[ ! "${ticket}" =~ ^clwpair1_ ]]; then
    fail "pair ticket format invalid for ${initiator_service} -> ${responder_service}: ${ticket}"
  fi
  pass "pair ticket created (${initiator_service} -> ${responder_service})"

  confirm_payload="$(jq -nc \
    --arg t "${ticket}" \
    --arg proxy "${MOCK_PROXY_URL}" \
    --arg responder_name "${responder_agent}" \
    '{ticket: $t, responderProfile: {agentName: $responder_name, humanName: "Integration Responder", proxyOrigin: $proxy}}')"

  confirm_response="$(curl -fsS -X POST "${MOCK_PROXY_URL}/pair/confirm" \
    -H "Authorization: Claw ${responder_ait}" \
    -H "Content-Type: application/json" \
    -H "X-Claw-Timestamp: ${ts}" \
    -H "X-Claw-Nonce: ${nonce}" \
    -H "X-Claw-Body-SHA256: integration" \
    -H "X-Claw-Proof: integration" \
    --data "${confirm_payload}")"
  assert_eq "true" "$(jq -r '.paired' <<<"${confirm_response}")" "pair confirmed (${initiator_service} -> ${responder_service})"

  status_response="$(curl -fsS "${MOCK_PROXY_URL}/pair/status/${ticket}")"
  assert_eq "confirmed" "$(jq -r '.status' <<<"${status_response}")" "pair status (${initiator_service} -> ${responder_service})"
  assert_eq "${initiator_did}" "$(jq -r '.initiatorAgentDid' <<<"${status_response}")" "initiator DID (${initiator_service})"
  assert_eq "${responder_did}" "$(jq -r '.responderAgentDid' <<<"${status_response}")" "responder DID (${responder_service})"
}

pair_agents "${PROVIDER_A_SERVICE}" "${PROVIDER_A_AGENT_NAME}" "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}"
pair_agents "${PROVIDER_B_SERVICE}" "${PROVIDER_B_AGENT_NAME}" "${PROVIDER_C_SERVICE}" "${PROVIDER_C_AGENT_NAME}"

pass "pairing flow verified"
