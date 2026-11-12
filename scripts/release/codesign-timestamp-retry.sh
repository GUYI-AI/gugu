#!/bin/bash
# codesign that retries only one failure: Apple's timestamp server refusing a request.
#
# Every Developer ID signature asks timestamp.apple.com for a timestamp, and one app takes ~56 of them. The server
# intermittently answers 503 (measured 2026-11-10 from the macOS build host: 8 of 168 kept-alive requests; from a second network path
# 4 of 168), and codesign then fails with "The timestamp service is not available." — so a single refusal threw away a
# whole Mac build, the "succeeds this time, fails next time" pattern of the Beta runs. developer-id-mac-sign.cjs puts
# this file first on PATH while @electron/osx-sign signs, so each file that hits a refusal is signed again after a
# short wait. Any other codesign failure exits immediately with codesign's own status and message.
real=${GUGU_CODESIGN_REAL:-/usr/bin/codesign}
delay=${GUGU_CODESIGN_RETRY_DELAY:-5}
attempts=4
err=$(mktemp "${TMPDIR:-/tmp}/codesign-err.XXXXXX")
trap 'rm -f "$err"' EXIT
for attempt in $(seq 1 "$attempts"); do
  "$real" "$@" 2>"$err"
  status=$?
  if [ "$status" -eq 0 ] || [ "$attempt" -eq "$attempts" ] || ! grep -q 'The timestamp service is not available' "$err"; then
    cat "$err" >&2
    exit "$status"
  fi
  wait_s=$((attempt * delay))
  echo "[mac-signing] Apple timestamp service refused (attempt $attempt/$attempts); signing ${!#} again in ${wait_s}s" >&2
  sleep "$wait_s"
done
