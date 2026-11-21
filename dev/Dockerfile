ARG RUST_VERSION=1.100.0
ARG NODE_VERSION=24.22.3
ARG IMAGE_PREFIX=docker.io/library/
FROM ${IMAGE_PREFIX}node:${NODE_VERSION}-bookworm-slim AS node

FROM ${IMAGE_PREFIX}rust:${RUST_VERSION}-bookworm
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG TARGETARCH
ARG GO_VERSION=1.27.4
ARG VP_VERSION=1.7.0
ARG BUN_VERSION=1.4.5
ARG JUST_VERSION=1.59.0
ARG TAURI_CLI_VERSION=2.12.6
ARG XWIN_VERSION=0.23.1
ARG NEXTEST_VERSION=0.9.152
ARG WATCH_VERSION=8.5.3
ARG SQLCMD_VERSION=1.11.0

RUN apt-get update && apt-get install --no-install-recommends -y \
    clang lld llvm nsis patchelf postgresql-client xdg-utils xauth xvfb file gettext-base \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libfuse2 libgtk-3-dev libssl-dev zstd xz-utils zip unzip \
    && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy && rustup target add x86_64-pc-windows-msvc

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN set -eu; \
    case "$TARGETARCH" in amd64) arch=x86_64; bunarch=x64 ;; arm64) arch=aarch64; bunarch=aarch64 ;; *) exit 1 ;; esac; \
    curl -fsSL --retry 3 "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" -o /tmp/go.tar.gz; \
    tar -xzf /tmp/go.tar.gz -C /usr/local; \
    curl -fsSL --retry 3 "https://github.com/voidzero-dev/vite-plus/releases/download/v${VP_VERSION}/vp-${arch}-unknown-linux-gnu.tar.gz" -o /tmp/vp.tar.gz; \
    tar -xzf /tmp/vp.tar.gz -C /usr/local/bin vp; \
    curl -fsSL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bunarch}.zip" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp; \
    install "/tmp/bun-linux-${bunarch}/bun" /usr/local/bin/bun; \
    ln -s bun /usr/local/bin/bunx; \
    curl -fsSL --retry 3 "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${arch}-unknown-linux-musl.tar.gz" -o /tmp/just.tar.gz; \
    tar -xzf /tmp/just.tar.gz -C /usr/local/bin just; \
    curl -fsSL --retry 3 "https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v${TAURI_CLI_VERSION}/cargo-tauri-${arch}-unknown-linux-gnu.tgz" -o /tmp/tauri.tgz; \
    tar -xzf /tmp/tauri.tgz -C /usr/local/bin cargo-tauri; \
    curl -fsSL --retry 3 "https://github.com/rust-cross/cargo-xwin/releases/download/v${XWIN_VERSION}/cargo-xwin-v${XWIN_VERSION}.${arch}-unknown-linux-musl.tar.gz" -o /tmp/xwin.tar.gz; \
    tar -xzf /tmp/xwin.tar.gz -C /tmp; \
    find /tmp -name cargo-xwin -type f -exec install '{}' /usr/local/bin/cargo-xwin ';'; \
    curl -fsSL --retry 3 "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-${NEXTEST_VERSION}/cargo-nextest-${NEXTEST_VERSION}-${arch}-unknown-linux-gnu.tar.gz" -o /tmp/nextest.tar.gz; \
    tar -xzf /tmp/nextest.tar.gz -C /usr/local/bin cargo-nextest; \
    curl -fsSL --retry 3 "https://github.com/watchexec/cargo-watch/releases/download/v${WATCH_VERSION}/cargo-watch-v${WATCH_VERSION}-${arch}-unknown-linux-gnu.tar.xz" -o /tmp/watch.tar.xz; \
    tar -xJf /tmp/watch.tar.xz -C /tmp; \
    find /tmp -name cargo-watch -type f -exec install '{}' /usr/local/bin/cargo-watch ';'; \
    curl -fsSL --retry 3 "https://github.com/microsoft/go-sqlcmd/releases/download/v${SQLCMD_VERSION}/sqlcmd-linux-${TARGETARCH}.tar.bz2" -o /tmp/sqlcmd.tar.bz2; \
    tar -xjf /tmp/sqlcmd.tar.bz2 -C /usr/local/bin sqlcmd; \
    rm -rf /tmp/*; \
    test -x /usr/local/bin/vp && cargo tauri --version && cargo xwin --version && cargo nextest --version && cargo watch --version && sqlcmd --version

ENV VP_HOME="/opt/vite-plus" VP_NODE_MANAGER=no VP_PM_MANAGER=no
RUN vp --version && vp env off
RUN groupadd --non-unique --gid "$HOST_GID" strata \
    && useradd --non-unique --uid "$HOST_UID" --gid "$HOST_GID" --create-home strata \
    && chown -R "$HOST_UID:$HOST_GID" "$VP_HOME" \
    && install -d -o "$HOST_UID" -g "$HOST_GID" /cache/cargo /cache/bun /cache/xwin /cache/go /workspace/target /workspace/node_modules /workspace/apps/desktop/node_modules


# Tauri's NSIS template uses headers added after Debian Bookworm's NSIS 3.08.
ARG NSIS_VERSION=3.13
ARG NSIS_SOURCE_SHA256=a8ffe024602d46b6d766f9e1ce30c324ad2a24daeacd3efc2642d436a0c157ac
ARG NSIS_DATA_SHA256=ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8
ENV NSISDIR="/opt/nsis-${NSIS_VERSION}"
RUN apt-get update && apt-get install --no-install-recommends -y scons zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    curl -fsSL --retry 3 "https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}-src.tar.bz2" -o /tmp/nsis-src.tar.bz2; \
    curl -fsSL --retry 3 "https://github.com/tauri-apps/binary-releases/releases/download/nsis-${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip" -o /tmp/nsis-data.zip; \
    printf '%s  %s\n' "$NSIS_SOURCE_SHA256" /tmp/nsis-src.tar.bz2 "$NSIS_DATA_SHA256" /tmp/nsis-data.zip | sha256sum -c -; \
    tar -xjf /tmp/nsis-src.tar.bz2 -C /tmp; \
    unzip -q /tmp/nsis-data.zip -d /opt; \
    cd "/tmp/nsis-${NSIS_VERSION}-src"; \
    scons -s -j "$(nproc)" VERSION="$NSIS_VERSION" VER_MAJOR="${NSIS_VERSION%%.*}" VER_MINOR="${NSIS_VERSION#*.}" \
      SKIPSTUBS=all SKIPPLUGINS=all SKIPUTILS=all SKIPMISC=all \
      NSIS_CONFIG_CONST_DATA_PATH=no PREFIX="$NSISDIR" install-compiler; \
    ln -s "$NSISDIR/makensis" /usr/local/bin/makensis; \
    test -f "$NSISDIR/Include/Win/RestartManager.nsh"; \
    actual_version="$(makensis -VERSION)"; printf '%s\n' "$actual_version"; test "$actual_version" = "v$NSIS_VERSION"; \
    rm -rf /tmp/nsis-src.tar.bz2 /tmp/nsis-data.zip "/tmp/nsis-${NSIS_VERSION}-src"

ENV PATH="/usr/local/go/bin:$PATH" \
    CARGO_HOME="/cache/cargo" CARGO_TARGET_DIR="/workspace/target" \
    BUN_INSTALL_CACHE_DIR="/cache/bun" XWIN_CACHE_DIR="/cache/xwin" GOCACHE="/cache/go" \
    VP_PACKAGE_MANAGER=bun@${BUN_VERSION} \
    APPIMAGE_EXTRACT_AND_RUN=1
USER strata
WORKDIR /workspace
