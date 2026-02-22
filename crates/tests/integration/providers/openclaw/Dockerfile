FROM node:22-alpine
RUN apk add --no-cache bash curl jq sqlite
COPY --from=clawdentity-builder /usr/local/bin/clawdentity-cli /usr/local/bin/clawdentity
RUN ln -sf /usr/local/bin/clawdentity /usr/local/bin/clawdentity-cli
COPY crates/tests/integration/providers/openclaw/mock-platform.js /opt/platform/mock-platform.js
COPY crates/tests/integration/providers/openclaw/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3001 19400
ENTRYPOINT ["/entrypoint.sh"]
