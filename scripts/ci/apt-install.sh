#!/usr/bin/env bash
# apt-install.sh [apt-get install args]... — install Ubuntu packages on a CI runner or job container.
# Ubuntu mirrors fail in two ways that a plain `apt-get update && apt-get install` turns into a red or hung job:
# a mirror mid-sync serves an index of the wrong size (update warns, keeps the stale index, install then finds
# "no installation candidate"), and a stalled connection hangs update until the job's own timeout cancels it.
# Each attempt therefore makes a failed index download an error, bounds every connection, and the whole
# update+install is retried with backoff. After the last attempt the job fails with apt's own output.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 [apt-get install args]..." >&2
  exit 2
fi

sudo=""
if [ "$(id -u)" -ne 0 ]; then sudo="sudo"; fi

apt_opts=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
)

attempts=4
for attempt in $(seq 1 "$attempts"); do
  if $sudo apt-get "${apt_opts[@]}" -o APT::Update::Error-Mode=any update \
    && $sudo env DEBIAN_FRONTEND=noninteractive apt-get "${apt_opts[@]}" install -y "$@"; then
    exit 0
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "apt-install: giving up after $attempts attempts: $*" >&2
    exit 1
  fi
  delay=$((attempt * 15))
  echo "apt-install: attempt $attempt failed; retrying in ${delay}s" >&2
  sleep "$delay"
done
