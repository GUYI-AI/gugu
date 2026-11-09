#!/usr/bin/env bash
set -euo pipefail
version="${VENDOR_NODE_VERSION:-}"
if [ -z "$version" ]; then version="$(tr -d '[:space:]' < "${VENDOR_NODE_VERSION_FILE:-.node-version}")"; fi
case "$version" in *[!0-9.]*|'') echo '::error::An exact pinned Node version is required'; exit 1 ;; esac
case "${RUNNER_OS:?}-${RUNNER_ARCH:?}" in
  macOS-ARM64) target=darwin-arm64 ;;
  macOS-X64) target=darwin-x64 ;;
  Linux-ARM64) target=linux-arm64 ;;
  Linux-X64) target=linux-x64 ;;
  *) echo '::error::Unsupported POSIX Node build host'; exit 1 ;;
esac
name="node-v$version-$target"
archive="$name.tar.gz"
expected="$(awk -v f="$archive" '{sub(/\r$/,""); if($2==f)print $1}' "$GITHUB_ACTION_PATH/node-checksums.txt")"
[ "${#expected}" = 64 ] || { echo "::error::Missing reviewed Node checksum for $archive"; exit 1; }
cache="${RUNNER_TOOL_CACHE:?}/gugu-vendor-node/$expected"
executable="$cache/$name/bin/node"
if [ -x "$executable" ] && [ "$(cat "$cache/.verified-sha256" 2>/dev/null)" = "$expected" ] && [ "$("$executable" --version)" = "v$version" ]; then
  echo "Reusing verified Node v$version ($target)"
else
  mkdir -p "$(dirname "$cache")"
  stage="$(mktemp -d "$(dirname "$cache")/.vendor-node.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  curl -fsS --connect-timeout 30 --max-time 600 --retry 3 --retry-all-errors \
    "https://download.gugu.nextmind.space/releases/vendor/node-toolchain/v$version/$archive" -o "$stage/$archive"
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$stage/$archive" | cut -d ' ' -f 1)";
  else actual="$(shasum -a 256 "$stage/$archive" | cut -d ' ' -f 1)"; fi
  [ "$actual" = "$expected" ] || { echo '::error::Node archive SHA256 mismatch; not extracted'; exit 1; }
  tar -xzf "$stage/$archive" -C "$stage"
  candidate="$stage/$name/bin/node"
  [ "$("$candidate" --version)" = "v$version" ] || { echo '::error::Node archive version differs from pin'; exit 1; }
  rm -f "$stage/$archive"
  printf '%s\n' "$expected" > "$stage/.verified-sha256"
  if [ -e "$cache" ]; then
    [ "$(cat "$cache/.verified-sha256" 2>/dev/null)" = "$expected" ] && [ "$("$executable" --version)" = "v$version" ] || { echo '::error::Occupied Node cache is invalid'; exit 1; }
  else
    VENDOR_NODE_STAGE="$stage" VENDOR_NODE_CACHE="$cache" "$candidate" -e 'const fs = require("node:fs"); try { fs.renameSync(process.env.VENDOR_NODE_STAGE, process.env.VENDOR_NODE_CACHE) } catch (e) { if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e }'
    [ "$(cat "$cache/.verified-sha256" 2>/dev/null)" = "$expected" ] && [ "$("$executable" --version)" = "v$version" ] || { echo '::error::Published Node cache is invalid'; exit 1; }
  fi
fi
printf '%s\n' "$cache/$name/bin" >> "${GITHUB_PATH:?}"
printf 'node-version=%s\n' "$version" >> "${GITHUB_OUTPUT:?}"
