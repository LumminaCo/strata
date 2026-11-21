#!/usr/bin/env bash
set -euo pipefail

features=apps/desktop/src/features
if [[ -d "$features" ]] && grep -rnE --include='*.tsx' --include='*.css' --include='*.ts' \
    '(^|[^[:alnum:]_])#[0-9A-Fa-f]{3,8}([^[:alnum:]_]|$)|(rgba?|oklch|hsla?)\(|[[:alnum:]-]+-\[' "$features"; then
    printf 'Use design tokens in feature code.\n' >&2
    exit 1
fi

tree="$(cargo tree --locked --workspace -e normal,build)"
if grep -E '\b(openssl(-sys)?|native-tls) v' <<< "$tree"; then
    printf 'Use Rustls for database TLS.\n' >&2
    exit 1
fi
