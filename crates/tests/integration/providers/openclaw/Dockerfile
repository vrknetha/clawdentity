FROM rust:1.85-slim AS clawdentity-builder
WORKDIR /build
COPY crates/ ./crates/
RUN cargo build --release --manifest-path crates/Cargo.toml -p clawdentity-cli

FROM node:22-alpine
RUN apk add --no-cache bash curl jq sqlite git libc6-compat
RUN npm install -g openclaw || \
    (git clone --depth 1 https://github.com/openclaw/openclaw.git /opt/openclaw && npm install -g /opt/openclaw)
COPY --from=clawdentity-builder /build/crates/target/release/clawdentity-cli /usr/local/bin/clawdentity
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli
COPY crates/tests/integration/providers/openclaw/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3001 19400
ENTRYPOINT ["/entrypoint.sh"]
