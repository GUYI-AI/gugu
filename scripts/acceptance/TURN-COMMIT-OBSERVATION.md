# Acceptance-only turnCommitted observation

This branch is an instrumentation input, not a product PR. Parent: `5ce3a6bfa76c47d3be66c3062db9a70cb6f49711`.
The same patch applies to `4f0306469212f59f7b894671f21d7404c142c61b`; their ACP boot input is identical.
Do not merge or carry this observer into a product head. It does not repair the pack dependency or close findings.

## Build and launch

Build the real desktop Electron instance from this exact checkout using its existing build configuration.
The actual hook is in `packages/session-runtime/src/acp-agents/node/boot.ts`, after the private
`turnCommitted.emit`. Rebuild `acp-runtime.js` along with its matching application/chunks;
an old installed application will not gain this hook by setting environment variables.
Record the exact observer commit and normal build provenance in the experiment manifest.
No new dependencies or native rebuild are required by this observer itself.

Use the instance admission queue. Do not stop another person's app. Launch only an independently built
artifact with unique final child environment values for **both** isolation paths. For example, with
the experiment directory, Electron binary and built app root already selected:

```sh
GUGU_HOME="$experiment/home" \
GUGU_USER_DATA_DIR="$experiment/user-data" \
GUGU_COMMIT_OBSERVE_DIR="$experiment/observation" \
GUGU_COMMIT_OBSERVE_SOURCE_PIN="$observer_commit" \
"$electron_binary" "$built_app_root"
```

Do not set `ELECTRON_RUN_AS_NODE` when launching the real desktop app. Keep the test-account/shared-test
configuration separate from daily profiles. Verify the effective home/userData and worker environment
before measurement. Log in and prepare scenarios before starting the capture. Starting the observer
does not create or start a session; a normal real session start creates the ACP worker as usual.

## Start and stop

The worker writes a private `worker-<pid>-<uuid>.json` endpoint file under the observation directory.
Its loopback token stays in that mode-0600 file. Select the endpoint of the actual current worker;
do not reuse one after a worker replacement. Control with Node 24:

```sh
node scripts/acceptance/control-turn-commit-observer.mjs status "$endpoint_file"
node scripts/acceptance/control-turn-commit-observer.mjs start "$endpoint_file" tools
# Run the real scenario for about ten minutes. Cases: normal, tools, background.
node scripts/acceptance/control-turn-commit-observer.mjs stop "$endpoint_file"
```

Start returns the precise monotonic start; stop freezes the end before serialization and writes one
mode-0600 `capture-<uuid>.json`. There are no capture-time file writes or polling timers. Event rows
contain only `sessionId`, `provider` (null when absent), `source`, `monoNs`. Replay is excluded and counted
separately. No turn/reference/body/prompt/tool data or credentials are retained. All time coordinates
are decimal nanoseconds from `process.hrtime.bigint` within the recorded worker identity.

Keep the full start-to-end interval, including zero-event windows. Use separate per-session rates for
1s/5s/30s windows, and report the number of distinct committing sessions in each window. That count
is **not** proof that those sessions were simultaneously busy: record the real running-session inventory
and scenario concurrency separately. Worker restart/close makes an active capture incomplete; stop
then exits nonzero. Missing raw, failed export, or the explicit 500,000-event overflow also invalidate
the sample. No partial dataset is a successful ten-minute measurement.

Local control/export regression: `node --test scripts/acceptance/turn-commit-observer.test.mjs`.
These checks exercise the real control socket and filesystem; they do not claim real harness sampling.
