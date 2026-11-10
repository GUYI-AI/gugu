# Native history acceptance fixtures (#2062)

Run only after the test host has been admitted. The wrapper places fixture generation and all descendants in a `MemoryMax=4G`, `CPUQuota=200%` systemd scope. The generator verifies the effective cgroup values and the explicitly expected Linux hostname before creating a large file. `--user-scope` selects the user manager when delegated resource controls are available. No dependency installation is required; use the repository's Node version.

```sh
bash scripts/perf/native-history-acceptance.sh scripts/perf/native-history-fixture.mts \
  --expected-host "$APPROVED_TEST_HOST" --path "$PRIVATE_TEST_DIRECTORY/rollout.jsonl" \
  --bytes 21474836480 --provider codex --kind sparse-io
```

The three fixture kinds have distinct evidence meanings:

- `sparse-io`: poison/NUL prefix with a valid identical recent provider record. Proves seek/read-budget behavior only; it is not a valid imported transcript.
- `valid-jsonl`: bounded streaming generation of many legal provider records over a simulated 100-hour interval, including two earlier giant records (600 MiB each for large samples; proportionally smaller in tiny control fixtures). The product's actual capture/import path must generate durable locators; the generator does not invent an index.
- `legacy-giant`: a valid earlier record followed by a giant final provider record, with an unknown nonzero start and no locator. At 629145600 bytes this is the separate 600 MiB discovery case. Its placeholder frame, first readable body, background scan time/bytes and crash-resume behavior must be reported separately.

Generate 10 MiB, 5 GiB and 20 GiB cases sequentially, retain measurements and delete each private fixture before the next. Budget real disk for `valid-jsonl`; sparse holes cannot represent valid JSON string content. Old whole-read comparisons are permitted only below 100,000,000 bytes (`assertLegacySize`). The wrapper and generator are preparation tools, not desktop first-paint evidence.

`native-history-acceptance.mts` runs the size/cache matrix through an explicit adapter with `prepareCase`, `runCase`, and `closeCase`. The adapter must use actual product capture/import and reopen paths, honor the supplied abort signal, close its own processes, and pass the final `env` containing both isolated profile paths to product children. No primitive fallback is supplied. Feed this controller to the same scope wrapper with `--adapter`, `--directory`, `--expected-host`, `--kind` and `--provider`; desktop evidence is required by default. A legacy comparison request is rejected before any large fixture is generated.

Each raw sample retains exact source SHA, source/index/decoded/output counters, cache state, first readable paint or explicit placeholder, sampled descendant RSS, and the scope's real memory high-water mark (including fixture generation and page cache). Sampled RSS is not an exact RSS high-water mark. Invalid measurements are retained with the validation error before failing. Legacy giant adapters must separately measure background discovery and a nonzero checkpoint resume. Timing/memory ratios across 10 MiB / 5 GiB / 20 GiB must be assessed from these samples; controller success alone does not prove equal latency or bounded total application memory.

## Direct source-host RPC probe

`native-history-host-reopen.mjs` runs the real pinned desktop source-reader/bridge,
with request metadata supplied by the probe. It does not exercise the outer DB
registration, IPC envelope, ACP history page or Electron paint. It requires Node
24 and an isolated source snapshot with `PIN.json = {sha, files: {relativePath:
sha256}}`; each listed source file is checked before the matrix runs. Export the
window-cache directory, tail-source-identity.ts, contract.ts and the desktop
session-timeline desktop-source-reader.ts/desktop-window-reader.ts from the same
Git SHA. No source implementation aliases or mocked WindowResults are used.

On the admitted Linux host, invoke the script **inside gugu-limited** with
`--root PRIVATE_EMPTY_RUN --source-root SNAPSHOT --sha FULL_SHA --bytes 5368709120
--provider both --variant all --host ADMITTED_HOST --timeout 10000`. All generation
and parsing are subject to effective cgroup checks. Repeat sequentially with
10485760 and 21474836480 bytes, using new run directories. Scenarios cover ordinary
text, an empty first text block and 70KiB metadata before text. No multi-GB files
belong on development Macs. Sources are deleted by a recorded manifest after each
case. Preserve `host-samples.jsonl`, stderr, traces and the nonzero exit of a matrix
with missing body text; a deadline is a test failure, never a product size cutoff.

The independent preload measures actual FileHandle.read/readv bytes on explicit
fixture/cache paths, including background reverse reads, and refuses whole-file
entry points. Report window/discovery/reverse separately and cross-check their sum
against actual I/O; old pins may omit reverse reporting. Readable RPC latency starts
after Node imports, includes discovery/waiting, and requires real unique source text.
Child maxRSS includes cleanup; it is neither total Electron memory nor cgroup peak.
