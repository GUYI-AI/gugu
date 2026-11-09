#!/usr/bin/env bash
set -euo pipefail
# All fixture creation, product processes and measurement descendants inherit this scope.
if [[ $(uname -s) != Linux ]]; then
  echo 'Acceptance requires an explicitly admitted Linux host.' >&2
  exit 1
fi
if [[ $# -lt 1 ]]; then echo "Usage: $0 [--user-scope] SCRIPT [ARGS...]" >&2; exit 1; fi
scope_args=()
if [[ ${1:-} == --user-scope ]]; then scope_args+=(--user); shift; fi
if [[ $# -lt 1 ]]; then echo "A script path is required." >&2; exit 1; fi
exec systemd-run "${scope_args[@]}" --scope -p MemoryMax=4G -p CPUQuota=200% -- \
  "${GUGU_ACCEPTANCE_NODE:-node}" "$@"
