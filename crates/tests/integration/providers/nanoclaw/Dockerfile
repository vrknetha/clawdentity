FROM rust:1.85-slim AS clawdentity-builder
WORKDIR /build
COPY crates/ ./crates/
RUN cargo build --release --manifest-path crates/Cargo.toml -p clawdentity-cli

FROM node:22-alpine
RUN apk add --no-cache bash curl jq sqlite git libc6-compat

ARG NANOCLAW_REPO=https://github.com/vrknetha/nanoclaw.git
ARG NANOCLAW_BRANCH=feat/webhook-skill
RUN set -eux; \
    git clone "$NANOCLAW_REPO" /opt/nanoclaw; \
    cd /opt/nanoclaw; \
    target_branch=""; \
    if git ls-remote --exit-code --heads origin "$NANOCLAW_BRANCH" >/dev/null 2>&1; then \
      target_branch="$NANOCLAW_BRANCH"; \
    elif git ls-remote --exit-code --heads origin "feature/add-webhook" >/dev/null 2>&1; then \
      target_branch="feature/add-webhook"; \
    fi; \
    if [ -z "$target_branch" ]; then \
      echo "nanoclaw webhook branch not found" >&2; \
      exit 1; \
    fi; \
    git checkout "$target_branch"; \
    npm install; \
    npm run build

COPY --from=clawdentity-builder /build/crates/target/release/clawdentity-cli /usr/local/bin/clawdentity
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli
COPY crates/tests/integration/providers/nanoclaw/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 18794 19400
ENTRYPOINT ["/entrypoint.sh"]
