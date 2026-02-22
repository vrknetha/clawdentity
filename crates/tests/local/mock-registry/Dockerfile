FROM rust:1.85-slim AS builder
WORKDIR /build
COPY crates/ ./crates/
RUN cargo build --release --manifest-path crates/Cargo.toml -p mock-registry

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/crates/target/release/mock-registry /usr/local/bin/mock-registry
EXPOSE 13370
ENTRYPOINT ["/usr/local/bin/mock-registry"]
