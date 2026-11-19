# Build archive downloads

`build:mise` and `build:frpc` use `scripts/build/mise-archive-cache.mts` to obtain the
exact archive named in their committed release manifest. The cache is addressed by
`<sha256>/<asset>`, under `GUGU_MISE_CACHE_DIR` or the user's XDG cache. A valid hit
makes no network request. Every newly downloaded archive must match the same pinned
SHA-256 before an atomic rename publishes it in the cache.

On a cold cache, the download order is:

| Tool | Primary base | Explicit official mirror |
| --- | --- | --- |
| mise | `https://download.gugu.nextmind.space/releases/vendor/mise` | `https://github.com/jdx/mise/releases/download` |
| frpc | `https://download.gugu.nextmind.space/releases/vendor/frp` | `https://github.com/fatedier/frp/releases/download` |

Both bases use `/v<version>/<asset>` from the committed manifest. Other callers of
the shared helper have no implicit mirror. The helper allows two attempts per
source, with a one-second pause between failed transient attempts, and at most four
requests when a mirror is configured. Each curl invocation has a 15-second connect
timeout, a 180-second transfer limit and the existing 60-second low-speed timeout.
There is no unbounded retry loop or alternate unpinned binary.

Retries cover connection/DNS failures, interrupted transfers and curl's transient
HTTP response codes (408, 429, 500, 502, 503, 504, 522 and 524). The official mirror
is tried only after the primary exhausts its transient-error budget. A SHA-256
mismatch, TLS/certificate failure, persistent HTTP error or local file failure is
immediately fatal; it does not trigger another source or weaken verification.

If verification cannot reopen an archive after curl succeeds, the error names the
verification stage, file path and OS error. Inspect filesystem permissions and
endpoint-security/quarantine records separately from network reachability. The
build does not change security settings, restore quarantined files or repeatedly
download an unreadable archive. Any removable partial file is discarded on failure;
failure to remove it is reported with its path.
