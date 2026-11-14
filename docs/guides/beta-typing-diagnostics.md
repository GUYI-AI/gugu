# Incident-only local Beta typing diagnostics

The desktop Beta main window keeps editable-key timestamps and a native long-task observer. It has no Event Timing or long-animation-frame observer, no page JS sampling profiler, and no profiling document policy. Ordinary keys only update a bounded scalar history. A long task of at least 100 ms associated with recent typing requests a temporary main-process capture; shorter typed long tasks of at least 50 ms supply nearby timing ranges.

## Main-process capture

Electron's own `webContents.debugger` transport starts CDP CPU sampling at a requested 100 ms interval. A main-process timer stops the profile after 30 seconds, disables the Profiler domain and detaches. An open DevTools frontend or an attached debugger causes a local skipped status. Native attach failure also skips; the recorder never takes over a connection. Native detach revokes ownership before cleanup, so a replacement connection is preserved. Protocol commands have bounded timeouts. After a capture ends, at least five minutes elapse before another; each application launch permits at most six captures across renderer reloads. Occupied skips are throttled but do not consume a capture.

Only bounded application function/file metadata near recorded long tasks crosses the local file boundary. CDP sample offsets use the profile's own clock, with wall-clock command bounds exposing uncertainty. They are not relabeled as DOM Event Timing. The first triggering task has already ended; only subsequent work can be sampled.

## Callback accounting

Once per minute, `callback-accounting` reports keyboard callback and long-task observer delivery/entry counts, their cumulative `performance.now()` elapsed work, and separate flush/accounting callback costs. Promise wait time is excluded. The minute timer charges its own work to the window it opens. Actual window duration is retained, so rates can be normalized when timer delivery is delayed. These numbers describe the recorder's JS callback work; browser-native observer infrastructure and unrelated application code are outside this accounting. Time precision follows the browser's `performance.now()` resolution. No input text, key value, selector, composition data or DOM polling is used.

## Storage and controls

Files are JSONL in `diagnostics/typing/` beneath Electron `userData`. Five private fixed slots (`typing-0.jsonl` newest through `typing-4.jsonl`) are limited to 4,000,000 bytes each and 20,000,000 bytes in total. Rotation discards the oldest slot; crash-truncated tails are preserved in a rotated slot. Files/directories use private modes. Storage failure stops observation and capture. Records never enter ordinary logs, feedback tails, stdout or network reports.

Production builds remain disabled even if the environment requests activation. `GUGU_TYPING_DIAGNOSTICS=0` disables the feature at application startup for same-binary comparisons. Main accepts this route only from its own main window/root frame. Main-generated profile/status payloads have a separate allowlist and cannot be supplied through renderer IPC. Unknown fields, arbitrary error strings, URL queries and non-application source locations are discarded.
