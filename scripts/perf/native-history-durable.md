# Native history durable-write measurements

Refs #2062. These tools separate the existing canonical writer from the new durable source/receipt/projection path. A reference journal alone is not the latter.

`native-history-durable.mjs` exports `measureWrites` and `compareWrites`. Its CLI accepts `--adapter FILE --output FRESH_DIRECTORY --mode before|after --count 100 --warmup 10 --bytes 4096`. Each invocation requires a new directory, writes raw samples (including failures and warmup), and closes its real database. Use isolated test profiles and one admitted process at a time.

The adapter exports `open({directory,mode})`. The returned context exposes:

- `metadata()`: sourceSha, writerEntry, actual databasePath, additionsEnabled, and actual SQLite journalMode/synchronous/fullfsync/walAutocheckpoint values.
- `commit({index,text}, mark)`: invoke the actual serialized canonical writer. The after path marks source_durable, canonical_committed, projection_durable, ackable in that order only after the corresponding real barriers. Ackable means the durable reference is published and eligible for ACK; it excludes waiting for a renderer ACK. Return actual rowId/receiptId/projectionRef; `identity(input,result)` may point-read identities outside the timed interval when the old writer returns void.
- `verify()`: reopen/point-read real storage and return canonicalRows plus durableProjections for after. `close()` always releases the owned context.

The after adapter must not simulate receipts or mark a queued reference as durable. Missing stages or identities fail the run. Fixture construction, readback, raw-output writes and cleanup are outside the commit timer. Existing serialization/SQLite/FTS work inside the writer remains included.

Insert counts and revision counts differ. Preseed revision rows outside timing and supply `--rows` / `--projections` with the actual expected final row/version counts; defaults apply to fresh inserts only. The real revision method test updates one row ten times and verifies that one row remains. Do not invent row counts from the number of commits.

Report both mode p50/p95, after-minus-before percentile differences, paired per-index deltas, errors and raw samples. Negative differences remain negative. Use nearest-rank percentiles; eight-sample method checks are not acceptance statistics. Final experiments use identical input and SQLite policies, fresh databases, balanced before/after/after/before blocks, and multiple runs. Do not silently set synchronous=OFF or omit new fsync barriers to improve results.

After separate successful runs, `node scripts/perf/native-history-durable.mjs --compare BEFORE_DIRECTORY AFTER_DIRECTORY NEW_RESULT_FILE` reads the preserved summaries/raw samples and creates the comparison. It rejects incomplete sample counts, failed rows and differing SQLite policies.

Compatibility snapshots include every receipt's stable ID and SHA-256 of its complete persisted binding (source identity/range, canonical revision and projection reference), encoded in fixed field order by the real-schema adapter. Read and hash actual database content at each stage; do not reuse an earlier fingerprint. Counts alone cannot prove preservation. The checker preserves both canonical hashes and receipt identities/binding hashes through new → old → new; missing fingerprints, changed bindings and replacement IDs fail after saving raw readback.

`native-history-compat.mjs ADAPTER FRESH_DIRECTORY` performs old_seed → new_migrate_write → old_open_write → new_reopen on the same physical file. The adapter must actually run the pinned schemas/initializers and close every connection between stages. It supplies rows as `{id,sha256}` plus integrity, foreignKeyErrors and newReceiptRows; hashes cover canonical content, not just counts. The test requires old rows to survive, a new receipt to exist, the old writer to add a row, and receipts to survive old open/write and new reopen.

The source-schema baseline is v0.3.1 at cb2ba40311b40904aea33786008cf82e42467eeb. This does not identify any installed binary. New migration/after adapters remain unavailable until their production implementations are pinned. Never label a missing adapter or baseline-only run as compatibility or write-overhead success.
