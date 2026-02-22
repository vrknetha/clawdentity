# Pre-built Linux ARM64 binary (cross-compiled on macOS)
# To rebuild: cross build --release --target aarch64-unknown-linux-gnu -p clawdentity-cli
FROM debian:bookworm-slim
COPY crates/target/aarch64-unknown-linux-gnu/release/clawdentity-cli /usr/local/bin/clawdentity-cli
RUN chmod +x /usr/local/bin/clawdentity-cli
