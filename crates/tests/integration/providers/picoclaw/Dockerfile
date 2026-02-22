FROM rust:1.85-slim AS clawdentity-builder
WORKDIR /build
COPY crates/ ./crates/
RUN cargo build --release --manifest-path crates/Cargo.toml -p clawdentity-cli

FROM golang:1.22-alpine AS picoclaw-builder
RUN apk add --no-cache bash git make
ARG PICOCLAW_REPO=https://github.com/vrknetha/picoclaw.git
ARG PICOCLAW_BRANCH=feat/webhook-channel
WORKDIR /src
RUN set -eux; \
    mkdir -p /out; \
    git clone "$PICOCLAW_REPO" picoclaw; \
    cd picoclaw; \
    target_branch=""; \
    if git ls-remote --exit-code --heads origin "$PICOCLAW_BRANCH" >/dev/null 2>&1; then \
      target_branch="$PICOCLAW_BRANCH"; \
    elif git ls-remote --exit-code --heads origin "feat/clawdentity-webhook-channel" >/dev/null 2>&1; then \
      target_branch="feat/clawdentity-webhook-channel"; \
    fi; \
    if [ -z "$target_branch" ]; then \
      echo "picoclaw webhook branch not found" >&2; \
      exit 1; \
    fi; \
    git checkout "$target_branch"; \
    if [ -d cmd/picoclaw ]; then \
      go build -o /out/picoclaw ./cmd/picoclaw; \
    elif [ -f main.go ]; then \
      go build -o /out/picoclaw .; \
    else \
      main_pkg="$(go list ./... | grep '/cmd/' | head -n 1 || true)"; \
      if [ -n "$main_pkg" ]; then \
        go build -o /out/picoclaw "$main_pkg"; \
      fi; \
    fi; \
    if [ ! -f /out/picoclaw ]; then \
      if [ -f ./picoclaw ]; then \
        cp ./picoclaw /out/picoclaw; \
      elif [ -f ./bin/picoclaw ]; then \
        cp ./bin/picoclaw /out/picoclaw; \
      else \
        echo "unable to locate built picoclaw binary" >&2; \
        exit 1; \
      fi; \
    fi

FROM alpine:3.20
RUN apk add --no-cache bash curl jq sqlite git libc6-compat ca-certificates
COPY --from=clawdentity-builder /build/crates/target/release/clawdentity-cli /usr/local/bin/clawdentity
COPY --from=picoclaw-builder /out/picoclaw /usr/local/bin/picoclaw
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli \
    && chmod +x /usr/local/bin/picoclaw
COPY crates/tests/integration/providers/picoclaw/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 18794 19400
ENTRYPOINT ["/entrypoint.sh"]
