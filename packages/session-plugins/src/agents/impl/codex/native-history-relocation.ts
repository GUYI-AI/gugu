import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import type { AgentAuthContext, ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { readAgentHomeRecord, writeAgentHomeRecord, checkAgentHomeImportSpace, streamImportFile } from '@gugu/session-core/agents/plugins/helpers';
import { withCodexAppServer, type CodexAppServer } from './subscription';

export const NATIVE_HISTORY_RECORD = '.gugu-agent-home.native-history.json';
const PLATFORM = 'gugu_platform';
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
type Meta = {
  id: string; model_provider?: string;
  source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } } | string;
  history_base?: { thread_id: string };
  attached_thread?: boolean; forked_from_id?: string;
};
export type NativeRollout = { path: string; rolloutId: string; meta: Meta; unreadable?: boolean };
type CreatedFile = { path: string; ino?: number; dev?: number };
type FileProof = { path: string; destination: string; sha256: string; bytes: number };
export type NativeHistoryEntry = {
  state: 'pending' | 'copying' | 'deleting' | 'removed' | 'retained';
  reason?: string; model?: string; ancestry?: Record<string, string>; members: string[]; files: FileProof[]; created: CreatedFile[];
};
export type NativeHistoryCounts = { removed: number; pending: number; retained: number; unowned: number };
export type NativeHistoryLedger = {
  version: 1; sourceRoot: string; complete: boolean; entries: Record<string, NativeHistoryEntry>;
  unowned: string[]; counts: NativeHistoryCounts;
};
type Context = Pick<AgentAuthContext, 'cli' | 'env'>;
export type NativeHistoryProvider = { args: readonly string[]; env: Record<string, string> };
export type NativeHistoryOptions = {
  home: ResolvedAgentHome; ownedIds: ReadonlySet<string>; context: Context;
  resolveProvider: () => Promise<NativeHistoryProvider>; cliVersion: string; signal?: AbortSignal;
  pageSize?: number; onError?: (error: unknown) => void;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
function parent(meta: Meta) {
  return typeof meta.source === 'object' ? meta.source?.subagent?.thread_spawn?.parent_thread_id : undefined;
}
async function logicalStream(path: string) {
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const input = handle.createReadStream({ autoClose: true });
  if (!path.endsWith('.zst')) return input;
  const output = createZstdDecompress();
  input.on('error', error => output.destroy(error));
  output.once('close', () => input.destroy());
  return input.pipe(output);
}
async function safePath(root: string, path: string) {
  if (!inside(root, path)) throw new Error('History path escapes its home');
  let current = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const stat = await fs.lstat(current).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error('History path contains a symbolic link');
  }
}
/** Only the first logical line is inflated; no complete rollout is buffered. */
export async function readNativeRolloutMeta(path: string): Promise<Meta> {
  const stream = await logicalStream(path), parts: Buffer[] = [];
  try {
    for await (const raw of stream) {
      const chunk = Buffer.from(raw), end = chunk.indexOf(10);
      parts.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end >= 0) break;
    }
    const line = JSON.parse(Buffer.concat(parts).toString('utf8')) as { type?: string; payload?: Meta };
    if (line.type !== 'session_meta' || typeof line.payload?.id !== 'string' || !line.payload.id)
      throw new Error('Rollout has no session metadata');
    return line.payload;
  } finally { stream.destroy(); }
}
export async function scanNativeRollouts(root: string, signal?: AbortSignal): Promise<NativeRollout[]> {
  const found: NativeRollout[] = [];
  async function visit(path: string): Promise<void> {
    signal?.throwIfAborted();
    await safePath(root, path);
    const entries = await fs.readdir(path, { withFileTypes: true }).catch((error: unknown) => { if (missing(error)) return []; throw error; });
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Rollout inventory contains a symbolic link');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
        const rolloutId = entry.name.match(/([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\.jsonl(?:\.zst)?$/i)?.[1];
        const path = relative(root, full);
        try {
          if (!rolloutId) throw new Error('Rollout filename has no rollout id');
          found.push({ path, rolloutId, meta: await readNativeRolloutMeta(full) });
        } catch {
          signal?.throwIfAborted();
          // Its spawn parent cannot be established. No root may be deleted with an opaque inventory.
          found.push({ path, rolloutId: rolloutId ?? basename(full), meta: { id: rolloutId ?? basename(full) }, unreadable: true });
        }
      }
    }
  }
  for (const folder of ['sessions', 'archived_sessions']) await visit(join(root, folder));
  return found;
}
function nativeHistoryMembers(root: string, inventory: readonly NativeRollout[], previouslyProven: readonly string[] = []) {
  const members = new Set([root, ...previouslyProven]);
  for (;;) {
    const before = members.size;
    for (const file of inventory) if (parent(file.meta) && members.has(parent(file.meta)!)) members.add(file.meta.id);
    if (members.size === before) break;
  }
  return members;
}
export function nativeHistoryClosure(root: string, inventory: readonly NativeRollout[], previouslyProven: readonly string[] = [], includePrefixes = true) {
  const members = nativeHistoryMembers(root, inventory, previouslyProven);
  const files = new Set(inventory.filter(file => members.has(file.meta.id)));
  for (;;) {
    const before = files.size;
    for (const file of [...files]) if (includePrefixes && file.meta.history_base) {
      const prefixes = inventory.filter(prefix => prefix.rolloutId === file.meta.history_base!.thread_id);
      if (!prefixes.length) throw new Error('Referenced history prefix is missing');
      for (const prefix of prefixes) files.add(prefix);
    }
    if (files.size === before) break;
  }
  return { members, files: [...files] };
}
function retention(root: string, members: ReadonlySet<string>, inventory: readonly NativeRollout[], owned: ReadonlySet<string>, ancestry: Record<string, string> = {}) {
  if (!owned.has(root) || inventory.some(file => file.unreadable || members.has(file.meta.id) && file.meta.model_provider !== PLATFORM)) return 'subtreeNotOwned';
  const parents = new Map(Object.entries(ancestry)), observed = new Map<string, string>();
  for (const file of inventory) if (members.has(file.meta.id) && file.meta.id !== root) {
    const from = parent(file.meta);
    if (!from || observed.has(file.meta.id) && observed.get(file.meta.id) !== from) return 'subtreeNotOwned';
    observed.set(file.meta.id, from); parents.set(file.meta.id, from);
  }
  for (const id of members) {
    let current = id; const visited = new Set<string>();
    while (current !== root) {
      if (visited.has(current) || !members.has(current) || !parents.has(current)) return 'subtreeNotOwned';
      visited.add(current); current = parents.get(current)!;
    }
  }
  const rolloutIds = new Set(inventory.filter(file => members.has(file.meta.id)).map(file => file.rolloutId));
  if (inventory.some(file => file.meta.attached_thread && (members.has(file.meta.id) || members.has(file.meta.forked_from_id ?? '')))) return 'referenced';
  if (inventory.some(file => !members.has(file.meta.id) && rolloutIds.has(file.meta.history_base?.thread_id ?? ''))) return 'referenced';
  return undefined;
}
/** Resume appends thread_settings: compare the original's logical bytes with the copy's prefix. */
export async function verifyNativeHistoryPrefix(source: string, destination: string, signal?: AbortSignal) {
  const before = await fs.lstat(source), targetBefore = await fs.lstat(destination);
  const sourceHash = createHash('sha256'), targetHash = createHash('sha256');
  const input = await logicalStream(source);
  let output: Awaited<ReturnType<typeof logicalStream>> | undefined;
  let remaining = Buffer.alloc(0), bytes = 0;
  try {
    output = await logicalStream(destination);
    const iterator = output[Symbol.asyncIterator]();
    for await (const raw of input) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(raw); sourceHash.update(chunk); bytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        if (!remaining.length) {
          const next = await iterator.next();
          if (next.done) throw new ManagedDiverged();
          remaining = Buffer.from(next.value);
        }
        const length = Math.min(remaining.length, chunk.length - offset);
        targetHash.update(remaining.subarray(0, length));
        offset += length; remaining = remaining.subarray(length);
      }
    }
    const after = await fs.lstat(source), targetAfter = await fs.lstat(destination);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || targetBefore.ino !== targetAfter.ino || targetBefore.dev !== targetAfter.dev || targetBefore.size !== targetAfter.size || targetBefore.mtimeMs !== targetAfter.mtimeMs)
      throw Object.assign(new Error('History changed during verification'), { code: 'ESTALE' });
    const sha256 = sourceHash.digest('hex');
    if (sha256 !== targetHash.digest('hex')) throw new ManagedDiverged();
    return { sha256, bytes };
  } finally { input.destroy(); output?.destroy(); }
}
class ManagedDiverged extends Error { constructor() { super('Managed history differs from its original'); } }
export function nativeHistoryCounts(ledger: Pick<NativeHistoryLedger, 'entries' | 'unowned'>): NativeHistoryCounts {
  const counts = { removed: 0, pending: 0, retained: 0, unowned: ledger.unowned.length };
  for (const entry of Object.values(ledger.entries)) counts[entry.state === 'removed' || entry.state === 'retained' ? entry.state : 'pending']++;
  return counts;
}
export async function readNativeHistoryLedger(home: ResolvedAgentHome): Promise<NativeHistoryLedger | null> {
  const raw = await readAgentHomeRecord(home, NATIVE_HISTORY_RECORD) as NativeHistoryLedger | null;
  if (raw === null) return null;
  if (raw.version !== 1 || raw.sourceRoot !== home.userConfigRoot || typeof raw.complete !== 'boolean' || !raw.entries || !Array.isArray(raw.unowned))
    throw new Error('Invalid native history relocation record');
  for (const entry of Object.values(raw.entries)) if (!['pending', 'copying', 'deleting', 'removed', 'retained'].includes(entry.state)
    || !Array.isArray(entry.members) || !Array.isArray(entry.files) || !Array.isArray(entry.created)) throw new Error('Invalid native history entry');
  return raw;
}
async function turnIds(server: CodexAppServer, threadId: string, limit: number): Promise<string[]> {
  const ids: string[] = [], cursors = new Set<string>(); let cursor: string | null = null;
  do {
    const page = await server.request('thread/turns/list', { threadId, cursor, limit, sortDirection: 'asc' }) as { data: { id: string }[]; nextCursor: string | null };
    if (!Array.isArray(page.data) || !('nextCursor' in page)) throw new Error('Invalid turn page');
    for (const turn of page.data) { if (typeof turn.id !== 'string') throw new Error('Invalid turn id'); ids.push(turn.id); }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated turn cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor !== null);
  return ids;
}
async function listedIds(server: CodexAppServer, limit: number) {
  const ids = new Set<string>();
  for (const archived of [false, true]) {
    let cursor: string | null = null; const cursors = new Set<string>();
    do {
      const page = await server.request('thread/list', { cursor, limit, archived, useStateDbOnly: true, modelProviders: [PLATFORM], sourceKinds: SOURCE_KINDS }) as { data: { id: string }[]; nextCursor: string | null };
      if (!Array.isArray(page.data) || !('nextCursor' in page)) throw new Error('Invalid thread page');
      for (const thread of page.data) ids.add(thread.id);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated thread cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor !== null);
  }
  return ids;
}
function atLeast0167(version: string) {
  const parts = version.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)/);
  return !!parts && (Number(parts[1]) > 0 || Number(parts[2]) >= 167);
}

export async function relocateNativeCodexHistory(options: NativeHistoryOptions): Promise<NativeHistoryLedger> {
  const { home, context, ownedIds, signal, pageSize = 100 } = options;
  let ledger = await readNativeHistoryLedger(home);
  if (ledger?.complete) return ledger;
  const sourceRoot = await fs.realpath(home.userConfigRoot).catch((error: unknown) => { if (missing(error)) return resolve(home.userConfigRoot); throw error; });
  const managedRoot = await fs.realpath(home.configRoot);
  if (inside(sourceRoot, managedRoot) || inside(managedRoot, sourceRoot)) throw new Error('Native and managed history homes overlap');
  ledger ??= { version: 1, sourceRoot: home.userConfigRoot, complete: false, entries: {}, unowned: [], counts: { removed: 0, pending: 0, retained: 0, unowned: 0 } };
  const save = async () => { ledger.counts = nativeHistoryCounts(ledger); await writeAgentHomeRecord(home, NATIVE_HISTORY_RECORD, ledger); };
  signal?.throwIfAborted();
  let inventory = await scanNativeRollouts(home.userConfigRoot, signal);
  const candidates = new Set(inventory.filter(file => (file.meta.model_provider === PLATFORM || file.unreadable) && ownedIds.has(file.meta.id)).map(file => file.meta.id));
  const profileMembers = new Set([...candidates].flatMap(id => [...nativeHistoryMembers(id, inventory)]));
  ledger.unowned = [...new Set(inventory.filter(file => file.meta.model_provider === PLATFORM && !profileMembers.has(file.meta.id)).map(file => file.meta.id))];
  // A spawned descendant belongs to its root's record, never an independent delete attempt.
  const closures = new Map([...candidates].map(id => [id, nativeHistoryMembers(id, inventory)]));
  const descendants = new Set([...closures].flatMap(([root, closure]) => [...closure].filter(id => id !== root)));
  for (const [id, closure] of closures) {
    if (descendants.has(id)) continue;
    ledger.entries[id] ??= { state: 'pending', members: [...closure], files: [], created: [] };
  }
  await save();
  // Referencing roots are visited first. An external/unmovable reference is retained below.
  const roots = Object.keys(ledger.entries), ordered: string[] = [], visiting = new Set<string>();
  const order = (root: string) => {
    if (ordered.includes(root) || visiting.has(root)) return;
    visiting.add(root);
    const members = new Set(ledger.entries[root]!.members);
    const rolloutIds = new Set(inventory.filter(file => members.has(file.meta.id)).map(file => file.rolloutId));
    for (const other of roots) if (other !== root && inventory.some(file => ledger.entries[other]!.members.includes(file.meta.id) && rolloutIds.has(file.meta.history_base?.thread_id ?? ''))) order(other);
    ordered.push(root);
  };
  roots.forEach(order);
  for (const root of ordered) {
    signal?.throwIfAborted();
    const entry = ledger.entries[root]!;
    if (entry.state === 'removed' || entry.state === 'retained') continue;
    const wasDeleting = entry.state === 'deleting';
    let deletionStarted = wasDeleting;
    try {
      inventory = await scanNativeRollouts(home.userConfigRoot, signal);
      const closure = nativeHistoryClosure(root, inventory, entry.members, !wasDeleting);
      const members = new Set([...entry.members, ...closure.members]);
      const reason = retention(root, members, inventory, ownedIds, entry.ancestry);
      if (reason) { entry.state = 'retained'; entry.reason = reason; await save(); continue; }
      entry.members = [...members];
      entry.ancestry = { ...entry.ancestry, ...Object.fromEntries(inventory.filter(file => members.has(file.meta.id) && parent(file.meta)).map(file => [file.meta.id, parent(file.meta)!])) };
      if (!atLeast0167(options.cliVersion)) { entry.reason = 'codexTooOld'; await save(); continue; }
      let provider: NativeHistoryProvider;
      try { provider = await options.resolveProvider(); }
      catch (error) {
        entry.reason = 'probeConfigurationFailed: ' + (error instanceof Error ? error.message : String(error));
        await save(); options.onError?.(error); continue;
      }
      const sourceCtx = { ...context, env: { ...context.env, CODEX_HOME: home.userConfigRoot } };
      const managedCtx = { ...context, env: { ...context.env, ...provider.env, CODEX_HOME: home.configRoot } };
      await save(); // Before either app-server can perform native backfill.
      await withCodexAppServer(sourceCtx, async native => {
        if (!wasDeleting) {
          await checkAgentHomeImportSpace([{ home, groups: new Set(), historyPaths: closure.files.map(file => file.path) }], signal, { includeStaging: false, includeCredentials: false });
          entry.state = 'copying'; entry.reason = undefined; await save();
          // Prior outputs may already be in use; only this attempt's new files may be rolled back.
          entry.created = []; entry.files = []; await save();
          for (const file of closure.files) {
            signal?.throwIfAborted();
            const source = resolve(home.userConfigRoot, file.path), destination = resolve(home.configRoot, file.path);
            await safePath(home.userConfigRoot, source); await safePath(home.configRoot, destination);
            if (!await fs.lstat(destination).then(() => true, error => { if (missing(error)) return false; throw error; })) {
              const created: CreatedFile = { path: file.path };
              entry.created.push(created); await save();
              await fs.mkdir(dirname(destination), { recursive: true });
              const sha = await streamImportFile(source, destination, undefined, home.userConfigRoot, signal, async identity => { Object.assign(created, identity); await save(); });
              await streamImportFile(destination, undefined, sha, home.configRoot, signal);
            }
            const proof = await verifyNativeHistoryPrefix(source, destination, signal);
            entry.files.push({ path: file.path, destination: file.path, ...proof }); await save();
          }
        }
        // Even deleting records must re-prove every surviving original against the managed prefix.
        for (const file of entry.files) {
          const source = resolve(home.userConfigRoot, file.path), destination = resolve(home.configRoot, file.destination);
          await safePath(home.userConfigRoot, source); await safePath(home.configRoot, destination);
          if (await fs.lstat(source).then(() => true, error => { if (missing(error)) return false; throw error; }))
            await verifyNativeHistoryPrefix(source, destination, signal);
        }
        await withCodexAppServer(managedCtx, async managed => {
          if (wasDeleting) {
            const readable = await managed.request('thread/read', { threadId: root, includeTurns: false }) as { thread?: { id?: string } };
            if (readable.thread?.id !== root) throw new Error('Managed history is unavailable before continuing deletion');
          } else {
            for (const id of members) {
              const originalThread = await native.request('thread/read', { threadId: id, includeTurns: false }) as { thread?: { model?: string } };
              const model = originalThread.thread?.model;
              if (typeof model !== 'string' || !model) throw new Error('Native thread has no model');
              if (id === root) { entry.model = model; await save(); }
              // 0.167 leaves copied descendants' turn index empty when resume excludes turns.
              // Load each descendant's history before the independent paginated comparison.
              const resumed = await managed.request('thread/resume', { threadId: id, excludeTurns: id === root, model }) as { modelProvider?: string; thread?: { id: string; path: string } };
              if (resumed.modelProvider !== PLATFORM || resumed.thread?.id !== id || !resumed.thread.path
                || !inside(await fs.realpath(home.configRoot), await fs.realpath(resumed.thread.path))) throw new Error('Managed resume did not prove the relocated thread');
              const original = await turnIds(native, id, pageSize), copy = await turnIds(managed, id, pageSize);
              if (JSON.stringify(original) !== JSON.stringify(copy)) throw new Error('Managed turn sequence differs');
            }
          }
          const fresh = await scanNativeRollouts(home.userConfigRoot, signal), freshClosure = nativeHistoryClosure(root, fresh, entry.members, !wasDeleting);
          if ([...freshClosure.members].some(id => !members.has(id)) || retention(root, members, fresh, ownedIds, entry.ancestry)) throw new Error('Native subtree changed before deletion');
          for (const file of freshClosure.files) {
            if (!entry.files.some(proof => proof.path === file.path)) throw new Error('Native rollout set changed before deletion');
            await verifyNativeHistoryPrefix(resolve(home.userConfigRoot, file.path), resolve(home.configRoot, file.path), signal);
          }
          entry.state = 'deleting'; entry.reason = undefined; entry.created = []; await save();
          deletionStarted = true;
          signal?.throwIfAborted();
          try { await native.request('thread/delete', { threadId: root }); }
          catch (error) {
            if (!/no rollout found|thread not found/i.test(String(error))) {
              if (/attached|forked history still references/i.test(String(error))) { entry.state = 'retained'; entry.reason = 'referenced'; await save(); return; }
              throw error;
            }
          }
          const listed = await listedIds(native, pageSize);
          if ([...members].some(id => listed.has(id)) || (await scanNativeRollouts(home.userConfigRoot, signal)).some(file => members.has(file.meta.id)))
            throw new Error('Native deletion is incomplete');
          const read = await managed.request('thread/read', { threadId: root, includeTurns: false }) as { thread?: { id?: string } };
          if (read.thread?.id !== root) throw new Error('Managed thread cannot be read after deletion');
          entry.state = 'removed'; entry.reason = undefined; await save();
        }, { args: provider.args, signal });
      }, { signal });
    } catch (error) {
      // Only outputs created by this attempt are eligible for rollback, and never after delete began.
      if (deletionStarted) entry.state = 'deleting';
      else {
        for (const created of entry.created) {
          const path = resolve(home.configRoot, created.path);
          await safePath(home.configRoot, path);
          const stat = await fs.lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; });
          // A concurrent importer may have won wx or replaced our output. Never unlink its file.
          if (created.ino !== undefined && stat?.ino === created.ino && stat.dev === created.dev) await fs.rm(path);
        }
        entry.created = [];
        entry.state = error instanceof ManagedDiverged ? 'retained' : 'pending';
      }
      entry.reason = error instanceof ManagedDiverged ? 'managedDiverged'
        : (error as { code?: string }).code === 'AGENT_HOME_INSUFFICIENT_SPACE' || (error as { code?: string }).code === 'ENOSPC' ? 'space' : 'verificationFailed';
      await save();
      options.onError?.(error);
      signal?.throwIfAborted();
    }
  }
  ledger.complete = Object.values(ledger.entries).every(entry => entry.state === 'removed' || entry.state === 'retained');
  await save();
  return ledger;
}
