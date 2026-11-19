import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { directorySyncOpenMode } from '@gugu/session-core/session-record/window-cache/disk-frame';

/** Durable history, not an evictable window cache. Every reference owns immutable, verified bytes. */
export type TurnPayloadRef = { hash: string; bytes: number };
export type TurnPayloadObject = { bytes: number; children: Map<string, TurnPayloadRef> };
type Branch = { version: 1; kind: 'branch'; children: TurnPayloadRef[] };
// Divisible by three: a binary image block projects to exactly 16 KiB of base64 for bounded window readers.
const BLOCK_BYTES = 12 * 1024;
const FANOUT = 64;
const HASH = /^[a-f0-9]{64}$/;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class TurnPayloadFiles {
  readonly counters = { writtenBytes: 0, writtenFiles: 0, readBytes: 0 };
  readonly staged = new Map<string, TurnPayloadObject>();
  private readonly syncedDirectories = new Set<string>();
  constructor(readonly directory: string, private readonly meterRead?: (requested: number, operation: () => number) => number) {}

  private path(hash: string): string {
    if (!HASH.test(hash)) throw new Error('Invalid turn payload hash');
    return join(this.directory, hash.slice(0, 2), `${hash.slice(2)}.payload`);
  }

  private readBlock(ref: TurnPayloadRef): Buffer {
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('Invalid turn payload length');
    const fd = openSync(this.path(ref.hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer = Buffer.alloc(0);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > BLOCK_BYTES + 1) throw new Error('Invalid turn payload block size');
      let failed = false, failure: unknown;
      const read = () => {
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        try {
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) throw new Error('Turn payload changed while reading');
            offset += count;
          }
        } catch (error) { failed = true; failure = error; }
        return offset;
      };
      if (this.meterRead) this.meterRead(before.size, read); else read();
      if (failed) throw failure;
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Turn payload changed while reading');
    } finally { closeSync(fd); }
    this.counters.readBytes += bytes.length;
    if (bytes.length > BLOCK_BYTES + 1 || digest(bytes) !== ref.hash) throw new Error('Turn payload integrity check failed');
    return bytes;
  }

  /** Only the owner registry may unlink an object, after proving it has no owners. */
  remove(hash: string): void { rmSync(this.path(hash), { force: true }); }

  removeTemporary(hash: string, id: string): void {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid payload temporary identity');
    rmSync(`${this.path(hash)}.${id}.tmp`, { force: true });
  }

  private putBlock(bytes: Buffer, logicalBytes: number): TurnPayloadRef {
    if (bytes.length > BLOCK_BYTES + 1) throw new Error('Turn payload block exceeds its encoding bound');
    const ref = { hash: digest(bytes), bytes: logicalBytes }, path = this.path(ref.hash);
    const object = this.staged.get(ref.hash) ?? { bytes: bytes.length, children: new Map<string, TurnPayloadRef>() };
    if (bytes[0] === 1) for (const child of (JSON.parse(bytes.subarray(1).toString('utf8')) as Branch).children) object.children.set(child.hash, child);
    this.staged.set(ref.hash, object);
    // Verify an existing object. A corrupt or missing object must never be adopted by its name alone.
    try { this.readBlock(ref); return ref; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = join(this.directory, ref.hash.slice(0, 2));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    for (const path of [this.directory, dirname(this.directory)]) if (!this.syncedDirectories.has(path)) {
      const directory = openSync(path, directorySyncOpenMode());
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.syncedDirectories.add(path);
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temporary, path); this.counters.writtenBytes += bytes.length; this.counters.writtenFiles++; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.readBlock(ref);
      }
      const directory = openSync(parent, directorySyncOpenMode());
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { rmSync(temporary, { force: true }); }
    return ref;
  }

  private branch(children: TurnPayloadRef[]): TurnPayloadRef {
    const value: Branch = { version: 1, kind: 'branch', children };
    return this.putBlock(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]), children.reduce((n, r) => n + r.bytes, 0));
  }

  /** A bounded fanout tree; a long body never makes a long reference array in a database row. */
  private root(leaves: TurnPayloadRef[]): TurnPayloadRef {
    if (!leaves.length) return this.putBlock(Buffer.from([0]), 0);
    let level = leaves;
    while (level.length > 1) {
      const next: TurnPayloadRef[] = [];
      for (let at = 0; at < level.length; at += FANOUT) next.push(this.branch(level.slice(at, at + FANOUT)));
      level = next;
    }
    return level[0]!;
  }

  putBytes(bytes: Uint8Array): TurnPayloadRef {
    const leaves: TurnPayloadRef[] = [];
    for (let at = 0; at < bytes.byteLength; at += BLOCK_BYTES) {
      const part = bytes.subarray(at, at + BLOCK_BYTES);
      leaves.push(this.putBlock(Buffer.concat([Buffer.from([0]), part]), part.byteLength));
    }
    return this.root(leaves);
  }

  /** JSON strings preserve even lone UTF-16 surrogates; no whole-output stringify is allocated. */
  putText(text: string, references: readonly TurnPayloadRef[] = []): TurnPayloadRef {
    const leaves: TurnPayloadRef[] = [];
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + 8192, text.length), part: Buffer;
      for (;;) {
        const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        part = Buffer.from(JSON.stringify(text.slice(at, end)));
        if (part.length <= BLOCK_BYTES) break;
        end = at + Math.max(1, Math.floor((end - at) / 2));
      }
      leaves.push(this.putBlock(Buffer.concat([Buffer.from([2]), part]), part.length));
      at = end;
    }
    const root = this.root(leaves);
    const unique = [...new Map(references.map(ref => [ref.hash, ref])).values()];
    // A large descriptor must not create an unbounded cascade when its last owner goes away.
    for (const ref of unique.length > FANOUT ? [this.root(unique)] : unique) this.staged.get(root.hash)!.children.set(ref.hash, ref);
    return root;
  }

  private *leaves(ref: TurnPayloadRef, parents = new Set<string>()): Generator<Buffer> {
    if (parents.has(ref.hash)) throw new Error('Cyclic turn payload reference');
    const bytes = this.readBlock(ref);
    if (bytes[0] === 0 || bytes[0] === 2) {
      if (bytes.length - 1 !== ref.bytes) throw new Error('Turn payload length mismatch');
      yield bytes; return;
    }
    if (bytes[0] !== 1) throw new Error('Unknown turn payload block version');
    const branch = JSON.parse(bytes.subarray(1).toString('utf8')) as Branch;
    if (branch.version !== 1 || branch.kind !== 'branch' || !Array.isArray(branch.children)
      || branch.children.length < 1 || branch.children.length > FANOUT
      || branch.children.some(child => !child || !HASH.test(child.hash) || !Number.isSafeInteger(child.bytes) || child.bytes < 0)
      || branch.children.reduce((n, r) => n + r.bytes, 0) !== ref.bytes) throw new Error('Invalid turn payload branch');
    const lineage = new Set(parents).add(ref.hash);
    for (const child of branch.children) yield* this.leaves(child, lineage);
  }

  readBytes(ref: TurnPayloadRef): Buffer {
    const parts: Buffer[] = [];
    for (const leaf of this.leaves(ref)) {
      if (leaf[0] !== 0) throw new Error('Expected binary turn payload');
      parts.push(leaf.subarray(1));
    }
    return Buffer.concat(parts, ref.bytes);
  }

  readText(ref: TurnPayloadRef): string {
    if (ref.bytes === 0) { this.readBytes(ref); return ''; }
    const parts: string[] = [];
    for (const leaf of this.leaves(ref)) {
      if (leaf[0] !== 2) throw new Error('Expected text turn payload');
      const value: unknown = JSON.parse(leaf.subarray(1).toString('utf8'));
      if (typeof value !== 'string') throw new Error('Invalid turn text payload');
      parts.push(value);
    }
    return parts.join('');
  }

  /** Structural references only. Callers never have to read preceding body blocks to reach one page. */
  *leafReferences(ref: TurnPayloadRef): Generator<TurnPayloadRef> {
    const bytes = this.readBlock(ref);
    if (bytes[0] === 0 || bytes[0] === 2) { yield ref; return; }
    if (bytes[0] !== 1) throw new Error('Unknown turn payload block version');
    const branch = JSON.parse(bytes.subarray(1).toString('utf8')) as Branch;
    if (branch.version !== 1 || branch.kind !== 'branch' || !Array.isArray(branch.children)
      || branch.children.length < 1 || branch.children.length > FANOUT
      || branch.children.reduce((n, r) => n + r.bytes, 0) !== ref.bytes) throw new Error('Invalid turn payload branch');
    for (const child of branch.children) yield* this.leafReferences(child);
  }

  encodedTextLeaf(ref: TurnPayloadRef): string {
    const bytes = this.readBlock(ref);
    if (bytes[0] !== 2 || bytes.length - 1 !== ref.bytes) throw new Error('Expected encoded text leaf');
    return bytes.subarray(1).toString('utf8');
  }

  readBytesRange(ref: TurnPayloadRef, start: number, end: number): Buffer {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > ref.bytes) throw new Error('Invalid payload range');
    const bytes = this.readBlock(ref);
    if (bytes[0] === 0) {
      if (bytes.length - 1 !== ref.bytes) throw new Error('Binary payload length mismatch');
      return bytes.subarray(1 + start, 1 + end);
    }
    if (bytes[0] !== 1) throw new Error('Expected binary payload');
    const branch = JSON.parse(bytes.subarray(1).toString('utf8')) as Branch;
    if (branch.version !== 1 || branch.kind !== 'branch' || !Array.isArray(branch.children) || branch.children.length > FANOUT
      || branch.children.reduce((n, r) => n + r.bytes, 0) !== ref.bytes) throw new Error('Invalid binary payload branch');
    let at = 0; const parts: Buffer[] = [];
    for (const child of branch.children) {
      const next = at + child.bytes;
      if (next > start && at < end) parts.push(this.readBytesRange(child, Math.max(0, start - at), Math.min(child.bytes, end - at)));
      at = next;
    }
    return Buffer.concat(parts, end - start);
  }
}
