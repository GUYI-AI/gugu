# Local Beta typing diagnostics

The desktop Beta records content-free performance data for the main application window. Production builds do not activate the recorder, even when the runtime environment requests it. `GUGU_TYPING_DIAGNOSTICS=0` disables it at application startup for a controlled comparison using the same Beta binary. It does not change application data or account settings.

Files are JSON lines in `diagnostics/typing/` beneath Electron's application `userData` directory. The recorder owns five fixed slots, `typing-0.jsonl` (newest) through `typing-4.jsonl`. Each slot is at most 4,000,000 bytes; their combined size cannot exceed 20,000,000 bytes. Rotation discards the oldest slot. Unrelated files are not removed. A crash-truncated last line is preserved in a rotated slot rather than joined to a fresh record.

These records use a dedicated local IPC route. They are not ordinary application logs, stdout, feedback log tails or network reports. The recorder never reads typed characters, composition data, input values or message text. It does not retain DOM elements, selectors, frame names, attachment names, URL queries, arbitrary stack strings, or non-application source URLs. A field allowlist is enforced before IPC and again before disk.

## Timing and attribution

- `long-task`: PerformanceObserver tasks of at least 50 ms, with the browser's coarse container attribution.
- `long-frame`: long animation frames, their rendering/blocking timings, and the twelve longest script contributions. Application function names and source locations are retained; `scriptsTotal` shows the original contribution count.
- `key-latency`: trusted keydown events targeting an editable element, including shadow-root inputs. `durationMs` retains the browser's Event Timing duration: input timestamp to next rendering completion, rounded to 8 ms, with a minimum reporting threshold of 16 ms. This is not exact physical keyboard-to-display timing. When the browser additionally supplies `presentationTime`, `latencyMs` uses that timestamp and `metric` is `event-timing-presentation`; otherwise `metric` is `event-timing-next-paint`. Processing delay and handler duration are separate fields. Events below the browser's reporting threshold have no latency entry.
- `composition-start`, `composition-end`, and recent-input blur contain only timing and state. The original `trusted` flag is retained; no event is synthesized, stopped or prevented by the recorder.
- `typing-summary` contains cumulative editable-key and matched Event Timing counts, so reporting coverage is visible. Missing timings are not imputed as zero or assumed to be fast. Bounded key-history eviction is counted separately.
- `observer-error`: identifies a failed entry reader by its allowlisted entry type, without recording the exception text. That observer disconnects; the remaining observers keep working.

`typingActive` means an editable key timestamp falls between one second before the task and the task's end. `typingOverlap` requires the timestamp to be inside the task. These flags are computed when the batch is flushed, so a key queued during a blocking task can still be associated after its handler finally runs. If the bounded key history is incomplete, an absence of observed input is left unknown instead of reported as false.

Every record carries its page's `timeOrigin`; add it to `startMs` to align it with wall-clock observations, even after the initial page record has rotated away. Main adds the actual renderer PID, application version, schema and batch receipt time. `receivedAt` can lag the event; asynchronous disk persistence can finish later still.

## Cost and lifecycle

The recorder does no DOM polling or layout reads. It keeps bounded scalar histories and a bounded batch queue, schedules writes only when there is data, and serializes disk work asynchronously. Overflow is counted in `suppressed` records. A storage failure disables the recorder rather than rerouting diagnostic data to another log or interfering with input. Page teardown removes observers/listeners.

Script attribution comes from long animation frames. The recorder does not create a JS sampling profiler or enable a profiling document policy. Availability and overhead must be verified in the actual Electron runtime before a release.
