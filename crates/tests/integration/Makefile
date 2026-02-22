SHELL := /bin/bash

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
COMPOSE := docker compose --env-file $(ROOT).env -f $(ROOT)docker-compose.yml

.PHONY: build build-rotate test test-rotate clean

build:
	$(COMPOSE) build clawdentity-builder
	$(COMPOSE) build mock-registry mock-proxy openclaw picoclaw nanobot

build-rotate: build
	$(COMPOSE) --profile rotate build nanoclaw

test: build
	@set -euo pipefail; \
	$(COMPOSE) up -d mock-registry mock-proxy openclaw picoclaw nanobot; \
	trap '$(COMPOSE) down --remove-orphans >/dev/null 2>&1 || true' EXIT; \
	$(ROOT)runner/run-all.sh

test-rotate: build-rotate
	@set -euo pipefail; \
	$(COMPOSE) --profile rotate up -d mock-registry mock-proxy openclaw picoclaw nanoclaw; \
	trap '$(COMPOSE) --profile rotate down --remove-orphans >/dev/null 2>&1 || true' EXIT; \
	PROVIDER_C_SERVICE=nanoclaw \
	PROVIDER_C_AGENT_NAME=$${NANOCLAW_AGENT_NAME:-nanoclaw-agent} \
	PROVIDER_C_FRAMEWORK=nanoclaw \
	PROVIDER_C_CONNECTOR_HOST_PORT=$${NANOCLAW_CONNECTOR_HOST_PORT:-19440} \
	$(ROOT)runner/run-all.sh

clean:
	$(COMPOSE) --profile rotate down -v --remove-orphans
