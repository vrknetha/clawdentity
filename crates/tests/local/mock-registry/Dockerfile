FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY crates/target/aarch64-unknown-linux-gnu/release/mock-registry /usr/local/bin/mock-registry
RUN chmod +x /usr/local/bin/mock-registry
EXPOSE 13370
ENTRYPOINT ["/usr/local/bin/mock-registry"]
