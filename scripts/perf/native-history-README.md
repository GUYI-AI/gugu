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
