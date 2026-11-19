# Pinned build archives

The pinned build inventory contains 64 archives: psmux, the Android Node closure, mise, frp, Gradle, tmux, Electron, SQLite Node prebuilds, current electron-builder tools and Node toolchains. They use immutable versioned objects below `https://download.gugu.nextmind.space/releases/vendor/`. Dependency versions and existing pins remain unchanged. A failed download or hash check does not fall back to an upstream archive.

After changing a pin, regenerate the data-only mirror inventory:

```sh
node scripts/build/vendor-release-manifest.mts > scripts/build/vendor-assets.json
```

The inventory is derived from the existing pin sources and `vendor-build-pins.json`; its consistency test fails when the checked-in inventory is stale. Release maintainers populate new objects through a controlled uploader and verify complete bytes through both OSS and ordinary public URLs before merging consumer changes. A receipt must match the exact client SHA, manifest digest and full inventory; an older partial receipt is insufficient. The old Android GitHub-release upload command is retired.

The Node bootstrap uses Bash on POSIX and PowerShell on Windows, verifies the official archive SHA before extraction and atomically publishes a content-addressed cache. Electron retains its official checksums. SQLite prebuilds receive a SHA guard before extraction/loading, including cache hits; unsupported ABI/platform combinations keep the original source-build fallback. Isolated npm trees install with scripts disabled, receive the verified installer guard, then run their original lifecycle scripts through npm rebuild.

The controlled producer must be deployed and return a complete 67-item receipt before consumer CI begins. Merge the public consumer before private workflows reference its new local action, and let older release consumers finish before switching their bootstrap. Source checkouts, GitHub Actions, metadata/producer operations, npm packages and platform package repositories are outside this fixed-archive inventory; this is not a network-free build.
