FROM alpine:3.20
RUN apk add --no-cache bash curl jq make docker-cli docker-cli-compose
WORKDIR /workspace
COPY crates/tests/integration /workspace
ENTRYPOINT ["/workspace/runner/run-all.sh"]
