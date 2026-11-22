set shell := ["bash", "-euo", "pipefail", "-c"]

help:
    @echo "Strata tasks: up, down, gui, check, test-int, seed, bridge, bindings, bundle-linux, bundle-windows, ci"

install:
    vp install --frozen-lockfile

web:
    cd apps/desktop && vp dev --host 0.0.0.0

devserver: bridge
    poll=(); if [[ "${CARGO_WATCH_POLL:-0}" == 1 ]]; then poll+=(--poll); fi; cargo watch "${poll[@]}" --ignore 'apps/desktop/**' --ignore 'artifacts/**' -x 'run --locked -p strata-devserver'

gui: install bridge
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -s "${STRATA_XAUTH_SOURCE:-}" ]]; then
        umask 077
        export XAUTHORITY=/tmp/strata-display.xauth
        touch "$XAUTHORITY"
        xauth -f "$STRATA_XAUTH_SOURCE" nlist | sed 's/^..../ffff/' | xauth -f "$XAUTHORITY" nmerge -
    fi
    cd apps/desktop
    cargo tauri dev

frontend: install
    cd apps/desktop && vp build

check: frontend
    cargo fmt --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo test --locked --workspace
    cd apps/desktop && vp check && vp test
    cd bridge/oracle && go vet ./... && go test ./...
    bash dev/check-source.sh

seed:
    bash dev/seed/mssql/seed.sh

test-int: bridge frontend
    bash dev/test-int.sh
    STRATA_IT=1 SSL_CERT_FILE=/opt/strata-pg-trust/ca.pem cargo test --locked -p strata-driver-postgres --test postgres -- --ignored
    STRATA_IT=1 cargo test --locked -p strata-driver-mssql --test sql_server -- --ignored
    STRATA_IT=1 STRATA_ORACLE_BRIDGE=/workspace/artifacts/oracle-bridge ORACLE11_TEST="$(getent hosts oracle11 >/dev/null && printf 1 || printf 0)" cargo test --locked -p strata-driver-oracle -- --ignored
    STRATA_IT=1 cargo test --locked -p strata-app --test engine -- --ignored
    STRATA_IT=1 cargo test --locked -p strata-app --test desktop -- --ignored
    STRATA_IT=1 STRATA_ORACLE_BRIDGE=/workspace/artifacts/oracle-bridge cargo test --locked -p strata --test mcp -- --ignored

bridge:
    mkdir -p artifacts
    cd bridge/oracle && CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags '-s -w' -o ../../artifacts/oracle-bridge .

bindings:
    STRATA_UPDATE_BINDINGS=1 cargo test -p strata-app --lib typescript_bindings

bundle-linux: install
    cd apps/desktop && cargo tauri build --bundles deb -- --locked
    mkdir -p artifacts
    for deb in target/release/bundle/deb/*.deb; do name="${deb##*/}"; bash dev/build-appimage.sh "$deb" "artifacts/${name%.deb}.AppImage"; cp "$deb" artifacts/; done

bundle-windows: install
    cd apps/desktop && cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis -- --locked
    mkdir -p artifacts
    cp target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe artifacts/

ci: check
