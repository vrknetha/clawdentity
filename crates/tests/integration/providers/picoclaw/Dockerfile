FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl jq sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=clawdentity-builder /usr/local/bin/clawdentity-cli /usr/local/bin/clawdentity
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli
COPY crates/tests/integration/providers/picoclaw/mock-platform.py /opt/platform/mock-platform.py
COPY crates/tests/integration/providers/picoclaw/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /opt/platform/mock-platform.py
EXPOSE 18794 19400
ENTRYPOINT ["/entrypoint.sh"]
