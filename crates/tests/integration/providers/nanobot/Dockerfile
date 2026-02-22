FROM rust:1.85-slim AS clawdentity-builder
WORKDIR /build
COPY crates/ ./crates/
RUN cargo build --release --manifest-path crates/Cargo.toml -p clawdentity-cli

FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl jq sqlite3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG NANOBOT_REPO=https://github.com/vrknetha/nanobot.git
ARG NANOBOT_BRANCH=feat/webhook-channel
RUN set -eux; \
    git clone "$NANOBOT_REPO" /opt/nanobot; \
    cd /opt/nanobot; \
    target_branch=""; \
    if git ls-remote --exit-code --heads origin "$NANOBOT_BRANCH" >/dev/null 2>&1; then \
      target_branch="$NANOBOT_BRANCH"; \
    elif git ls-remote --exit-code --heads origin "feature/webhook-channel" >/dev/null 2>&1; then \
      target_branch="feature/webhook-channel"; \
    fi; \
    if [ -z "$target_branch" ]; then \
      echo "nanobot webhook branch not found" >&2; \
      exit 1; \
    fi; \
    git checkout "$target_branch"; \
    pip install --no-cache-dir .

COPY --from=clawdentity-builder /build/crates/target/release/clawdentity-cli /usr/local/bin/clawdentity
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli
COPY crates/tests/integration/providers/nanobot/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 18794 19400
ENTRYPOINT ["/entrypoint.sh"]
