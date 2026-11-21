Local session history has a versioned SQLite representation. Older turns keep
their original `session_turns.data` JSON. New turns use bounded field
descriptors and content-addressed body files. A revision to an older turn adds
normalized fields; it does not rewrite that turn's original JSON. The history
reader combines the explicitly stored versions at one entry point.

Payloads up to 64 KiB, including small tool output and window index pieces,
share content-addressed SQLite objects. Larger payloads each occupy one whole
content-addressed file. The writer synchronizes every new file, then its batch
directory once, before registering references in the canonical transaction.
Range checksums in SQLite permit bounded reads without re-reading an entire
large file. Tool output shared by multiple fields is still stored only once.

The database and the adjacent `<database filename>.turn-payloads` directory
form one durable store. For example, a database named `history.db` has a
`history.db.turn-payloads` directory. A complete offline backup or move must
include both paths. Restore the content directory beside the restored
database, using the restored database filename as its prefix. Copy the pair
with the app closed so collection or revision cannot change their ownership
during the copy. Copying only SQLite is sufficient for the old inline format,
and omits body files required by the new format.

The private window cache remains derived data. Its immutable source views
reference the same canonical bodies; they do not store another image or tool
output copy. Fields and window receipts hold transactional references to body
objects. Collection releases objects only after their last owner and older
SQLite reader snapshots have gone. An interrupted writer's unowned objects are
discovered and collected in bounded batches after restart. Missing or damaged
referenced objects are reported as errors.

This change does not convert existing turns or compact database files. A
separate, explicitly reviewed migration is required for existing inline data.
