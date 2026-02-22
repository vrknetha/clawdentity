FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl jq sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY crates/target/aarch64-unknown-linux-gnu/release/clawdentity-cli /usr/local/bin/clawdentity
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli && chmod +x /usr/local/bin/clawdentity
COPY crates/tests/integration/providers/openclaw/mock-platform.js /opt/platform/mock-platform.js
COPY crates/tests/integration/providers/openclaw/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3001 19400
ENTRYPOINT ["/entrypoint.sh"]
