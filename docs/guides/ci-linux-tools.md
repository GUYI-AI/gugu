# Linux CI dependencies

Ubuntu PR jobs do not update package indexes or install system packages. The hosted Ubuntu 24.04
image supplies its existing libraries and compiler toolchain. Missing inputs fail the job's preflight.

| Jobs | Previous dependency source and purpose | Current dependency source |
| --- | --- | --- |
| Unit shards, diagnostic Linux checks, Vitest cache seeding | APT `ripgrep`; real file-boundary regressions in `deviceActionsFiles.test.ts` | ripgrep 14.1.1, upstream musl release archive |
| Desktop Linux build | APT `tmux` for `build:tmux`; `libnss3`, `libgtk-3-0t64`, `libgbm1`, `libasound2t64` for Electron/native rebuild | Static tmux 3.7b release from `mjakob-gh/build-static-tmux`; existing hosted Electron libraries, checked with `ldd` |
| Android build and Gradle cache seeding | APT `icu-devtools`, `llvm`, `clang`, `lld`; inspect ARM64 ELF, filter ICU data and relink its data library | Hosted ICU tools (installed with `libicu-dev`) and `/usr/lib/llvm-18/bin`; preflight exercises the ARM64 Android linker |
| Projection native media | APT `ffmpeg`, `gcc`, `libc6-dev` inside a Playwright container; encoding, decoding and Go race builds | Static FFmpeg/FFprobe 6.1.1 releases from `eugeneware/ffmpeg-static`; hosted GCC/libc development files; the same digest-pinned Playwright Chromium extracted onto the host |

`scripts/ci/linux-tools.json` pins each downloaded archive's release URL and SHA256. The setup action
verifies the checksum on cold downloads **and cache hits**, extracts into a fresh job directory, and runs
every binary before adding it to PATH. A mismatched archive or missing host library fails immediately.
Each profile has its own archive cache; PRs only restore it, while the dev cache workflow seeds it.
Deleting every cache still leaves a complete, verified cold-install path. No npm dependency is added.

The media job retains its browser version, Go/Node test commands, race detector, repeat counts and timeout.
Only the build environment changes: the hosted C toolchain is used directly instead of installing one
inside the browser image. The browser's shared-library closure is checked before the real decoding tests.

Hosted-image references: [software inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md),
[APT toolset](https://github.com/actions/runner-images/blob/main/images/ubuntu/toolsets/toolset-2404.json),
[Clang/LLD installation](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-clang.sh).
These inventories guide maintenance; the actual job preflight and tests determine whether an image is usable.

Container image *builds* such as `.github/docker/linux-appimage.Dockerfile` still install their own packages.
They are not executed by PR CI; this change removes package installation from running PR jobs.
