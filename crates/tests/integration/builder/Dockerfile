FROM rust:1.85-slim AS clawdentity-builder
WORKDIR /build
COPY crates/ ./crates/
RUN cargo build --release --manifest-path crates/Cargo.toml -p clawdentity-cli

FROM debian:bookworm-slim
COPY --from=clawdentity-builder /build/crates/target/release/clawdentity-cli /usr/local/bin/clawdentity-cli
