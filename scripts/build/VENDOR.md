# Pinned build archives

The psmux, Cua driver, Android Node closure, mise and frp build archives use immutable versioned objects below `https://download.gugu.nextmind.space/releases/vendor/`. Their versions, archive contents, SHA pins, extraction checks and existing content-addressed caches are retained. A failed download or hash check fails the build; there is no automatic upstream fallback.

After changing a pin, regenerate the data-only mirror inventory:

```sh
node scripts/build/vendor-release-manifest.mts > scripts/build/vendor-assets.json
```

The inventory is derived from the existing pin sources; its consistency test fails when the checked-in inventory is stale. Release maintainers populate new objects through a controlled uploader and verify complete bytes through the ordinary public URLs before merging consumer changes. The old Android GitHub-release upload command is retired.

Generic archive-cache users can still pass an explicit download base, such as the separately pinned tmux distribution. mise/frp production bundlers and their host prewarm callers use the vendor roots directly.
