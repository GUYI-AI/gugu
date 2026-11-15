# Abrupt native host recovery regression

This synthetic process test uses the actual Pi/JavaScriptCore scheduler and APFS
journals. It makes no real cloud, model or EventKit requests.

Compile `main.swift` with the native Host sources and their owner-session type
dependencies. The parent runner starts `prepare <private-root> <agent.js>` with
private process data directories. `ready.json` is written only after a one-use
approval, native `beginMutation`, and one durable synthetic external effect. The
executor deliberately withholds its completion receipt.

After checking the child PID, parent PID and exact executable/fixture arguments,
the parent sends SIGKILL to that child only. It then starts a fresh process with
`reopen <same-private-root> <same-agent.js>`.

The reopened process must report the original input as interrupted and the write
as `execution_unknown`, expose its history and uncertainty to explicit
continuation, and execute zero model calls or writes. The independent effect
file must still contain exactly the first effect. A graceful `stop()` is never
used to prepare the crash, so the test cannot mistake cancellation for abrupt
process recovery. This is a native component process test; real iOS force-quit
and network recovery remain part of full-package acceptance.
