// @@@file-flush — a test cannot observe whether bytes reached the platter: there is no power cut to survive.
// It can observe the order of writes, flushes and publications, and the errors a flush reports; both stay intact.
//
// What it costs to flush anyway: on macOS, libuv turns every FileHandle.sync() into fcntl(F_FULLFSYNC),
// which drains the whole drive's write cache. Measured on the 32-core CI Mac (2026-11-21): ~6 ms alone, ~60 ms
// with 32 concurrent writers, and every other process's disk I/O waits behind it. session-main-db asked for
// ~8.5k of them per run (over half on directories) and session-main ~2.9k; with them elided, files that never
// flush themselves (agent-schedules 43 s → 1.5 s) stopped queueing behind the rest.
//
// So FileHandle flushes resolve without the syscall. A closed handle still rejects, as the real call does.
// Spies and per-test overrides of `sync` keep working: they wrap whatever is on the prototype. A test that
// wants the real barrier calls fs.fsync(handle.fd), which stays native (creation-attachment-durability does).
import { open } from 'node:fs/promises';

const probe = await open(process.execPath, 'r');
const FileHandlePrototype = Object.getPrototypeOf(probe) as typeof probe;
await probe.close();

for (const name of ['sync', 'datasync'] as const) {
  const flush = FileHandlePrototype[name];
  FileHandlePrototype[name] = async function (this: typeof probe) {
    if (this.fd === -1) return flush.call(this);
  };
}
