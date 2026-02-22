FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY crates/target/aarch64-unknown-linux-gnu/release/mock-proxy /usr/local/bin/mock-proxy
RUN chmod +x /usr/local/bin/mock-proxy
EXPOSE 13371
ENTRYPOINT ["/usr/local/bin/mock-proxy"]
