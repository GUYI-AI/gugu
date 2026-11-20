import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsync, fsyncSync, linkSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { directorySyncOpenMode } from '@gugu/session-core/session-record/window-cache/disk-frame';

export type TurnPayloadRef = { hash: string; bytes: number };
export type TurnPayloadObject = { bytes: number; kind: number; data: Buffer; chunks: string[]; children: Map<string, TurnPayloadRef> };
export type TurnPayloadMetadata = { bytes: number; kind: number; inline: boolean };
/** Supplied by the existing canonical SQLite gateway; readers never open a second database. */
export type TurnPayloadAccess = {
  alive(): boolean;
  metadata(hash: string): TurnPayloadMetadata | undefined;
  inline(hash: string): Buffer;
  chunks(hash: string, first: number, count: number): string[];
};
type Meter = (requested: number, operation: () => number, metadata?: boolean) => number;
export const INLINE_PAYLOAD_BYTES = 64 * 1024;
export const PAYLOAD_READ_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const directories = new Map<string, TurnPayloadAccess>();

export function unbindTurnPayloadDirectory(directory: string, access?: TurnPayloadAccess): void {
  if (!access || directories.get(directory) === access) directories.delete(directory);
}

/** Whole content-addressed files above 64 KiB; small objects share the canonical SQLite transaction. */
export class TurnPayloadFiles {
  readonly counters = { writtenBytes: 0, writtenFiles: 0, readBytes: 0 };
  readonly staged = new Map<string, TurnPayloadObject>();
  readonly access: TurnPayloadAccess;
  private readonly index?: TurnPayloadAccess;
  private readonly dirtyDirectories = new Set<string>();
  private readonly pendingFiles = new Map<string, number>();
  private synchronizing?: Promise<void>;
  private directoryReady = false;
  private readonly inlineCache = new Map<string, Buffer>();
  private readonly chunkCache = new Map<string, Buffer>();
  private readonly textCache = new Map<string, TurnPayloadRef>();
  private textCacheBytes = 0;

  constructor(readonly directory: string, private readonly meterRead?: Meter, index?: TurnPayloadAccess) {
    this.index = index ?? directories.get(directory);
    this.access = {
      alive: () => this.index?.alive() ?? true,
      metadata: hash => {
        const staged = this.staged.get(hash);
        return staged ? { bytes: staged.bytes, kind: staged.kind, inline: staged.bytes <= INLINE_PAYLOAD_BYTES } : this.index?.metadata(hash);
      },
      inline: hash => {
        const staged = this.staged.get(hash);
        if (staged) return staged.data;
        if (!this.index) throw new Error('Payload has no canonical SQLite access');
        return this.index.inline(hash);
      },
      chunks: (hash, first, count) => {
        const staged = this.staged.get(hash);
        if (staged) return staged.chunks.slice(first, first + count);
        if (!this.index) throw new Error('Payload has no canonical SQLite access');
        return this.index.chunks(hash, first, count);
      },
    };
  }

  bind(readonly = false): void {
    const current = directories.get(this.directory);
    if (!readonly || !current || !current.alive()) directories.set(this.directory, this.access);
  }

  private path(hash: string): string {
    if (!HASH.test(hash)) throw new Error('Invalid turn payload hash');
    return join(this.directory, `${hash}.payload`);
  }

  private ensureDirectory(): void {
    if (this.directoryReady) return;
    const created = mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (created) { this.dirtyDirectories.add(dirname(created)); this.dirtyDirectories.add(this.directory); }
    this.directoryReady = true;
  }

  private metadata(ref: TurnPayloadRef): TurnPayloadMetadata {
    if (!HASH.test(ref.hash) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('Invalid turn payload reference');
    const result: { value?: TurnPayloadMetadata } = {};
    if (!this.access.alive()) throw new Error('Canonical payload connection is closed');
    const read = () => { result.value = this.access.metadata(ref.hash); return result.value ? 24 : 0; };
    if (this.meterRead) this.meterRead(24, read, true); else read();
    const value = result.value;
    if (!value) throw Object.assign(new Error('Missing canonical payload object'), { code: 'ENOENT' });
    if (!Number.isSafeInteger(value.bytes) || value.bytes !== ref.bytes + 1 || ![0, 2, 3].includes(value.kind)
      || value.inline !== (value.bytes <= INLINE_PAYLOAD_BYTES)) throw new Error('Missing or invalid canonical payload metadata');
    return value;
  }

  private fileRange(ref: TurnPayloadRef, meta: TurnPayloadMetadata, start: number, end: number): Buffer {
    const fd = openSync(this.path(ref.hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(meta.bytes)) throw new Error('Turn payload file length mismatch');
      const parts: Buffer[] = [];
      for (let ordinal = Math.floor(start / PAYLOAD_READ_BYTES); ordinal * PAYLOAD_READ_BYTES < end; ordinal++) {
        const key = `${ref.hash}:${before.mtimeNs}:${before.ctimeNs}:${ordinal}`, offset = ordinal * PAYLOAD_READ_BYTES;
        let bytes = this.chunkCache.get(key);
        if (!bytes) {
          let expected: string[] = [];
          const hashes = () => { expected = this.access.chunks(ref.hash, ordinal, 1); return expected.length * 64; };
          if (this.meterRead) this.meterRead(64, hashes, true); else hashes();
          if (expected.length !== 1 || !HASH.test(expected[0])) throw new Error('Missing payload range checksum');
          const length = Math.min(PAYLOAD_READ_BYTES, meta.bytes - offset);
          let received = 0, failed = false, failure: unknown;
          const result: { bytes?: Buffer } = {};
          const read = () => {
            const buffer = result.bytes = Buffer.alloc(length);
            try {
              while (received < length) {
                const count = readSync(fd, buffer, received, length - received, offset + received);
                if (!count) throw new Error('Turn payload changed while reading');
                received += count;
              }
            } catch (error) { failed = true; failure = error; }
            return received;
          };
          if (this.meterRead) this.meterRead(length, read); else read();
          this.counters.readBytes += received;
          if (failed) throw failure;
          bytes = result.bytes;
          if (!bytes) throw new Error('Admitted payload read did not execute');
          if (digest(bytes) !== expected[0]) throw new Error('Turn payload range integrity check failed');
          if (this.chunkCache.size === 2) this.chunkCache.delete(this.chunkCache.keys().next().value!);
          this.chunkCache.set(key, bytes);
        }
        parts.push(bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset)));
      }
      const after = fstatSync(fd, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        throw new Error('Turn payload changed while reading');
      return Buffer.concat(parts, end - start);
    } finally { closeSync(fd); }
  }

  private range(ref: TurnPayloadRef, start: number, end: number, kind: number): Buffer {
    if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > ref.bytes) throw new Error('Invalid payload range');
    const meta = this.metadata(ref);
    if (meta.kind !== kind) throw new Error('Turn payload kind mismatch');
    if (!meta.inline) return this.fileRange(ref, meta, start + 1, end + 1);
    let bytes = this.inlineCache.get(ref.hash);
    if (!bytes) {
      const result: { bytes?: Buffer } = {};
      const read = () => { result.bytes = this.access.inline(ref.hash); return result.bytes.length; };
      if (this.meterRead) this.meterRead(meta.bytes, read); else read();
      bytes = result.bytes;
      if (!bytes) throw new Error('Admitted inline payload read did not execute');
      if (bytes.length !== meta.bytes || digest(bytes) !== ref.hash || bytes[0] !== kind) throw new Error('Inline payload integrity check failed');
      this.counters.readBytes += bytes.length;
      if (this.inlineCache.size < 64) this.inlineCache.set(ref.hash, bytes);
    }
    return Buffer.from(bytes.subarray(start + 1, end + 1));
  }

  private verifyExisting(ref: TurnPayloadRef, meta: TurnPayloadMetadata): void {
    this.chunkCache.clear();
    const bytes = meta.inline ? this.index!.inline(ref.hash) : this.fileRange(ref, meta, 0, meta.bytes);
    if (bytes.length !== meta.bytes || digest(bytes) !== ref.hash) throw new Error('Existing payload integrity check failed');
  }

  private put(kind: number, value: Uint8Array): TurnPayloadRef {
    const data = Buffer.concat([Buffer.from([kind]), value]), ref = { hash: digest(data), bytes: value.byteLength };
    if (this.staged.has(ref.hash)) return ref;
    const chunks: string[] = [];
    if (data.length > INLINE_PAYLOAD_BYTES) for (let at = 0; at < data.length; at += PAYLOAD_READ_BYTES) chunks.push(digest(data.subarray(at, at + PAYLOAD_READ_BYTES)));
    const object: TurnPayloadObject = { bytes: data.length, kind, data, chunks, children: new Map() };
    const prior = this.index?.metadata(ref.hash);
    if (prior) {
      if (prior.bytes !== data.length || prior.kind !== kind || prior.inline !== (data.length <= INLINE_PAYLOAD_BYTES)) throw new Error('Payload registry mismatch');
      this.verifyExisting(ref, prior);
    } else if (data.length > INLINE_PAYLOAD_BYTES) {
      const path = this.path(ref.hash), temporary = `${path}.${randomUUID()}.tmp`;
      this.ensureDirectory();
      try {
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { writeFileSync(fd, data); } finally { closeSync(fd); }
        try { linkSync(temporary, path); this.counters.writtenBytes += data.length; this.counters.writtenFiles++; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const observed = fstatSync(fd);
            if (!observed.isFile() || observed.size !== data.length) throw new Error('Orphan payload size mismatch');
            const actual = createHash('sha256'), buffer = Buffer.alloc(PAYLOAD_READ_BYTES);
            for (let at = 0; at < data.length;) {
              const count = readSync(fd, buffer, 0, Math.min(buffer.length, data.length - at), at);
              if (!count) throw new Error('Orphan payload changed');
              actual.update(buffer.subarray(0, count)); at += count;
            }
            if (actual.digest('hex') !== ref.hash) throw new Error('Orphan payload integrity check failed');
          } finally { closeSync(fd); }
        }
        this.pendingFiles.set(ref.hash, data.length);
        this.dirtyDirectories.add(this.directory);
      } finally { rmSync(temporary, { force: true }); }
    }
    this.staged.set(ref.hash, object); this.bind();
    return ref;
  }

  private openPending(hash: string, bytes: number): number {
    const fd = openSync(this.path(hash), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== bytes) throw new Error('Pending payload file length mismatch');
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }

  private syncDirectories(): void {
    // Even an all-inline database has its paired, possibly empty, backup directory.
    this.ensureDirectory();
    for (const path of this.dirtyDirectories) {
      const directory = openSync(path, directorySyncOpenMode());
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    this.dirtyDirectories.clear();
  }

  /** Synchronous record-backfill commits use the same pending-file durability barrier. */
  durable(): void {
    for (const [hash, bytes] of this.pendingFiles) {
      const fd = this.openPending(hash, bytes);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      this.pendingFiles.delete(hash);
    }
    this.syncDirectories();
  }

  /** Await every file, at most two in flight, before the directory and canonical publication. */
  async durableAsync(): Promise<void> {
    while (this.pendingFiles.size || this.synchronizing) {
      if (!this.synchronizing) {
        const entries = [...this.pendingFiles];
        let next = 0, failed = false;
        const worker = async () => {
          while (!failed && next < entries.length) {
            const [hash, bytes] = entries[next++];
            try {
              const fd = this.openPending(hash, bytes);
              try { await new Promise<void>((resolve, reject) => fsync(fd, error => error ? reject(error) : resolve())); }
              finally { closeSync(fd); }
              this.pendingFiles.delete(hash);
            } catch (error) { failed = true; throw error; }
          }
        };
        this.synchronizing = (async () => {
          // A rejected sync must still wait for its sibling before writer cleanup can run.
          const results = await Promise.allSettled(Array.from({ length: Math.min(2, entries.length) }, worker));
          for (const result of results) if (result.status === 'rejected') throw result.reason;
        })();
      }
      const current = this.synchronizing;
      try { await current; } finally { if (this.synchronizing === current) this.synchronizing = undefined; }
    }
    this.syncDirectories();
  }

  clear(): void {
    this.staged.clear(); this.inlineCache.clear(); this.chunkCache.clear();
    this.textCache.clear(); this.textCacheBytes = 0;
  }
  remove(hash: string): void { if (!this.access.metadata(hash)?.inline) rmSync(this.path(hash), { force: true }); }
  removeTemporary(hash: string, id: string): void {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid payload temporary identity');
    rmSync(`${this.path(hash)}.${id}.tmp`, { force: true });
  }

  putBytes(bytes: Uint8Array): TurnPayloadRef { return this.put(0, bytes); }
  putText(text: string, references: readonly TurnPayloadRef[] = []): TurnPayloadRef {
    // outputText and rawOutput's parsed leaf often share a body. Reuse only within
    // this writer, with bounded retention; descriptors must still attach their child owners.
    const cached = references.length ? undefined : this.textCache.get(text);
    if (cached && this.staged.has(cached.hash)) return cached;
    const root = this.put(2, Buffer.from(JSON.stringify(text)));
    if (!references.length && root.bytes <= 1024 * 1024) {
      while (this.textCache.size >= 64 || this.textCacheBytes + root.bytes > 1024 * 1024) {
        const oldest = this.textCache.keys().next().value!;
        this.textCacheBytes -= this.textCache.get(oldest)!.bytes; this.textCache.delete(oldest);
      }
      this.textCache.set(text, root); this.textCacheBytes += root.bytes;
    }
    let level = [...new Map(references.map(ref => [ref.hash, ref])).values()];
    while (level.length > 64) {
      const next: TurnPayloadRef[] = [];
      for (let at = 0; at < level.length; at += 64) {
        const children = level.slice(at, at + 64), ref = this.put(3, Buffer.from(JSON.stringify(children)));
        for (const child of children) this.staged.get(ref.hash)!.children.set(child.hash, child);
        next.push(ref);
      }
      level = next;
    }
    for (const ref of level) this.staged.get(root.hash)!.children.set(ref.hash, ref);
    return root;
  }

  readBytes(ref: TurnPayloadRef): Buffer { return this.range(ref, 0, ref.bytes, 0); }
  readText(ref: TurnPayloadRef): string {
    const value: unknown = JSON.parse(this.range(ref, 0, ref.bytes, 2).toString('utf8'));
    if (typeof value !== 'string') throw new Error('Invalid turn text payload');
    return value;
  }
  readBytesRange(ref: TurnPayloadRef, start: number, end: number): Buffer { return this.range(ref, start, end, 0); }
  readEncodedTextRange(ref: TurnPayloadRef, start: number, end: number): Buffer { return this.range(ref, start, end, 2); }
}
