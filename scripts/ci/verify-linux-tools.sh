#!/usr/bin/env bash
set -euo pipefail

# No package manager here: an image regression must fail before tests/builds, with its missing input.
case "$1" in
  unit) rg --version ;;
  desktop)
    tmux -V
    electron="$GITHUB_WORKSPACE/node_modules/electron/dist/electron"
    test -x "$electron"
    libraries=$(ldd "$electron")
    printf '%s\n' "$libraries"
    if [[ "$libraries" == *'not found'* ]]; then exit 1; fi
    ;;
  android)
    for tool in icupkg derb genrb llvm-readelf llvm-objcopy clang ld.lld; do command -v "$tool"; done
    # Exercise the same cross-linker path as mobile-runtime-icu.mts, not only --version.
    printf '.section .rodata\n.byte 0\n' > "$RUNNER_TEMP/gugu-icu-probe.s"
    clang --target=aarch64-linux-android26 -fuse-ld=lld -nostdlib -shared \
      -Wl,-z,max-page-size=16384 "$RUNNER_TEMP/gugu-icu-probe.s" -o "$RUNNER_TEMP/gugu-icu-probe.so"
    llvm-readelf -h "$RUNNER_TEMP/gugu-icu-probe.so"
    ;;
  media)
    ffmpeg -version
    ffprobe -version
    test -x "$(dirname "$(command -v ffmpeg)")/ffprobe"
    printf '#include <stdlib.h>\nint main(void) { return EXIT_SUCCESS; }\n' | gcc -x c - -o "$RUNNER_TEMP/gugu-c-probe"
    "$RUNNER_TEMP/gugu-c-probe"
    ;;
  *) echo "Unknown Linux tool profile: $1" >&2; exit 2 ;;
esac
