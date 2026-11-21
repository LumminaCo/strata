#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")"
export STRATA_UID="${STRATA_UID:-$(id -u)}" STRATA_GID="${STRATA_GID:-$(id -g)}"

ensure_env() {
  if [[ ! -f .env ]]; then
    (
      umask 077
      set -o noclobber
      for key in POSTGRES_PASSWORD MSSQL_SA_PASSWORD ORACLE_PASSWORD ORACLE_APP_PASSWORD STRATA_DEV_TOKEN; do
        bytes=16
        # Oracle XE 11g limits passwords to 30 bytes.
        if [[ "$key" == ORACLE_* ]]; then bytes=10; fi
        printf '%s=Strata9_%s\n' "$key" "$(od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n')"
      done > .env
    ) || [[ -f .env ]]
  fi
}

ensure_dev() {
  if ! docker image inspect strata-dev:local >/dev/null 2>&1; then
    docker compose build dev
  fi
}

run_dev() {
  ensure_dev
  docker compose run --rm -T --no-deps dev just "$@"
}

prepare_databases() {
  ensure_dev
  ensure_env
  docker compose up -d --build --wait postgres mssql oracle
  if [[ ",${COMPOSE_PROFILES:-}," == *,legacy,* ]]; then
    docker compose up -d --build --wait oracle11
  fi
  run_dev seed
}

case "${1:-help}" in
  up)
    prepare_databases
    run_dev install
    docker compose up -d --wait devserver web
    printf 'Strata is running at http://localhost:5173\n'
    ;;
  rebuild)
    docker compose build dev
    ;;
  down)
    docker compose --profile legacy down
    ;;
  seed)
    prepare_databases
    ;;
  test-int)
    prepare_databases
    run_dev test-int
    docker compose exec -T oracle /opt/strata-fixtures/verify.sh
    if [[ ",${COMPOSE_PROFILES:-}," == *,legacy,* ]]; then
      docker compose exec -T oracle11 /opt/strata-fixtures/verify.sh
    fi
    ;;
  gui)
    ensure_dev
    auth_source="${XAUTHORITY:-$HOME/.Xauthority}"
    mkdir -p .local
    STRATA_XAUTH_FILE="$(mktemp "$PWD/.local/xauth.XXXXXX")"
    export STRATA_XAUTH_FILE
    trap 'rm -f -- "$STRATA_XAUTH_FILE"' EXIT
    if [[ -s "$auth_source" ]]; then cat "$auth_source" > "$STRATA_XAUTH_FILE"; fi
    docker compose -f docker-compose.yml -f dev/gui.compose.yml run --rm -T --no-deps dev just gui
    ;;
  *)
    run_dev "$@"
    ;;
esac
