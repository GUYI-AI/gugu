import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createWorkspaceUploads, currentEtag, WorkspaceTransferError } from '@main/core/files/workspace-transfer';
import { REMOTE_WORKSPACE_CHUNK_BYTES, WORKSPACE_CONFLICT_CODE } from '@gugu/session-core/session-record/contract';
import { KeyedMutex } from '@gugu/session-core/lib';
import { eq } from 'drizzle-orm';
import { listAgents } from '@gugu/core';
import { agentsForOwner } from '@gugu/core/local/state/agentOwner';
import { AssistantPanelError, type AssistantPanelClient, type AssistantPanelCommit, type AssistantPanelItem, type AssistantPanelReceipt, type AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel';
import { composeInstructions, splitInstructions } from '@gugu/core/shared/assistantInstructions';
import { memoryIndexHints, parseMemoryNote, readFrontmatter, removeIndexEntry } from '@gugu/core/shared/assistantMemory';
import { assistantHomeKind, assistantHomePaths, type AssistantHomePaths } from '@gugu/core/shared/assistantPolicy';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { SESSIONPAGE_SESSION_CACHE_KEY } from '@main/core/sessionpage/sessionpage-session-agent';
import { atomicWriteText } from '@gugu/core/local/state/paths';
import { watchAssistantHome } from './assistant-home-watch';
import { assistantHomePath } from './assistant-home-path';

/**
 * The personal assistant's home on this computer, answered as the resource store answers an App (the same snapshot, items
 * and receipts as `createAssistantPanelClient`), from the home's own files: reading lists and reads them, a change writes
 * them. Nothing is published or kept anywhere else, and nothing runs between calls. A change is checked against the file
 * as it is now (its revision includes the modification time and content digest) and applied at once: its receipt is `applied` or it is refused.
 */

type FileDomain = 'memory' | 'files' | 'skills' | 'voice-notes';
const DOMAINS = ['memory', 'files', 'skills', 'personality', 'voice-notes'] as const;
type HomeDomain = (typeof DOMAINS)[number];
type Row = { key: string; path: string | null; data: Record<string, unknown>; revision: string; at: Date; bytes?: Uint8Array; digest?: string };

const LOCAL_BODY = 'home:';
const UPLOAD_BODY = 'upload:';
/** Whether a resource's content is a file of the home itself (not a file of any conversation). */
export const isHomeBody = (itemId: string) => itemId.startsWith(LOCAL_BODY);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// The binding protocol accepts opaque revisions as up to 19 decimal digits. Reserve 0 for missing and 1 for markers.
const revisionOf = (identity: string) => (createHash('sha256').update(identity).digest().readBigUInt64BE() % ((1n << 63n) - 2n) + 2n).toString();
const writes = new KeyedMutex();
const workspaceWrites = createWorkspaceUploads({ maxBytes: Number.MAX_SAFE_INTEGER, createMode: 0o600 });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const refused = (code: string, message: string, key?: string, domain?: string) => new AssistantPanelError(code, message, key, domain);

export type AssistantHomeStore = {
  client: Pick<AssistantPanelClient, 'snapshot' | 'resource' | 'commit'>;
  watch(signal: AbortSignal, changed: () => void): Promise<void>;
  readBody(item: AssistantPanelItem, maxBytes?: number): Promise<Uint8Array>;
  upload(label: string, bytes: Uint8Array): Promise<{ itemId: string; sha256: string }>;
  discard(itemId: string): Promise<void>;
};

// Within one host process: an upload waits for the change that takes it; a change asked again answers its receipt.
const uploads = new Map<string, Uint8Array>();
const receipts = new Map<string, AssistantPanelReceipt>();
const RECEIPTS_KEPT = 500;

export type AssistantHomeHere = { paths: AssistantHomePaths; anchor: string };

export function createAssistantHomeStore(input: {
  ownerId: string; assistantId: string; deviceId: string; home: AssistantHomeHere; changed(): void;
}): AssistantHomeStore {
  const { paths, anchor } = input.home;
  const rootOf = (domain: FileDomain) => domain === 'memory' ? paths.memoryDir : domain === 'files' ? paths.resourcesDir
    : domain === 'skills' ? paths.skillsDir : `${paths.memoryDir}/voice-notes`;
  const at = (path: string | null, domain: HomeDomain, create = false) => domain === 'personality'
    ? assistantHomePath(dirname(paths.instructions), 'CLAUDE.md', { home: anchor, createParents: create })
    : assistantHomePath(rootOf(domain), path, { home: anchor, createParents: create });

  async function collect(domain: HomeDomain): Promise<Row[]> {
    if (domain === 'personality') {
      const target = await at(null, domain);
      const info = await stat(target, { bigint: true }).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      const bytes = info ? await readFile(target) : null;
      const text = bytes?.toString('utf8') ?? '';
      return [{ key: 'instructions', path: null, data: { text: splitInstructions(text).user }, revision: info && bytes ? revisionOf(`${info.mtimeNs}:${sha256(bytes)}`) : '1', at: info?.mtime ?? new Date(0) }];
    }
    const rows: Row[] = [];
    const root = rootOf(domain);
    async function walk(relative: string) {
      let entries;
      try { entries = await readdir(relative ? await at(relative, domain) : root, { withFileTypes: true }); }
      catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.tmp') || domain === 'memory' && !relative && entry.name === 'voice-notes') continue;
        if (entry.isSymbolicLink()) continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const info = await stat(await at(path, domain), { bigint: true });
        const modifiedAt = info.mtime.toISOString();
        if (entry.isDirectory()) {
          // A folder has no content of its own: its time moves with what is put in it, so it is not its revision.
          if (domain === 'files') rows.push({ key: path, path, data: { name: entry.name, path, kind: 'directory', modifiedAt }, revision: '1', at: info.mtime });
          if (domain === 'voice-notes') rows.push({ key: path, path, data: { noteId: path.split('/')[0], kind: 'directory' }, revision: '1', at: info.mtime });
          await walk(path);
        } else if (entry.isFile()) {
          if (domain === 'skills' && (!relative || relative.includes('/') || entry.name !== 'SKILL.md')) continue;
          const bytes = new Uint8Array(await readFile(await at(path, domain)));
          const key = domain === 'skills' ? relative : path;
          const data = domain === 'files' ? { name: entry.name, path, kind: 'file', sizeBytes: bytes.length, modifiedAt }
            : domain === 'memory' ? { relativePath: path, title: entry.name, modifiedAt, kind: 'file' }
            : domain === 'skills' ? { name: relative, modifiedAt } : { noteId: path.split('/')[0], kind: entry.name };
          const digest = sha256(bytes);
          rows.push({ key, path, data, revision: revisionOf(`${info.mtimeNs}:${digest}`), at: info.mtime, bytes, digest });
        }
      }
    }
    await walk('');
    if (domain === 'memory') {
      const index = rows.find((row) => row.key === 'MEMORY.md');
      const hints = memoryIndexHints(index?.bytes ? new TextDecoder().decode(index.bytes) : '');
      for (const row of rows) {
        const note = parseMemoryNote(row.key, new TextDecoder().decode(row.bytes), hints.get(row.key));
        row.data = { ...row.data, title: note.title, kind: row.key === 'owner-profile.md' ? 'user' : note.kind };
      }
    }
    if (domain === 'skills') for (const row of rows) {
      const { fields } = readFrontmatter(new TextDecoder().decode(row.bytes));
      row.data = { ...row.data, name: fields.name || row.key, description: fields.description ?? '' };
    }
    return rows;
  }

  const itemOf = (domain: HomeDomain, row: Row): AssistantPanelItem => ({
    assistant_user_id: input.assistantId, owner_user_id: input.ownerId, domain, resource_key: row.key, device_id: input.deviceId,
    revision: row.revision, data: row.data,
    body_item_id: row.bytes && row.path ? `${LOCAL_BODY}${row.path}` : null, body_sha256: row.digest ?? null,
    deleted_at: null, observed_at: null, updated_at: row.at.toISOString(),
  });
  const marker = (domain: HomeDomain): AssistantPanelItem => ({
    assistant_user_id: input.assistantId, owner_user_id: input.ownerId, domain, resource_key: '__collection__', device_id: input.deviceId,
    revision: '1', data: { state: 'ready', schemaVersion: 1 }, body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null,
    updated_at: new Date(0).toISOString(),
  });
  async function items(domain: HomeDomain) { return (await collect(domain)).map((row) => itemOf(domain, row)); }
  async function current(domain: HomeDomain, key: string) { return (await items(domain)).find((item) => item.resource_key === key) ?? null; }

  async function snapshot(): Promise<AssistantPanelSnapshot> {
    const all = (await Promise.all(DOMAINS.map(async (domain) => [marker(domain), ...await items(domain)]))).flat();
    const revision = revisionOf(JSON.stringify(all.map(item => [item.domain, item.resource_key, item.revision, item.updated_at])));
    return { version: 1, revision, items: all, application: [] };
  }

  async function bytesOf(itemId: string, domain: FileDomain): Promise<Uint8Array> {
    if (itemId.startsWith(UPLOAD_BODY)) {
      const bytes = uploads.get(itemId);
      if (!bytes) throw refused('body-unavailable', 'The uploaded content is gone: send it again');
      return bytes;
    }
    if (itemId.startsWith(LOCAL_BODY)) return new Uint8Array(await readFile(await at(itemId.slice(LOCAL_BODY.length), domain)));
    throw refused('22023', 'Unknown content');
  }
  async function replace(target: string, bytes: Uint8Array, expectedRevision: string, absentRevision = '0') {
    const uploadId = randomUUID();
    const expectedEtag = await currentEtag(target);
    const validate = async (file: string) => {
      const info = await stat(file, { bigint: true }).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      const revision = info ? revisionOf(`${info.mtimeNs}:${sha256(await readFile(file))}`) : absentRevision;
      if (revision !== expectedRevision) throw new WorkspaceTransferError(WORKSPACE_CONFLICT_CODE, 'The assistant file has changed');
    };
    try {
      let offset = 0;
      do {
        const end = Math.min(bytes.length, offset + REMOTE_WORKSPACE_CHUNK_BYTES);
        const data = Buffer.from(bytes.subarray(offset, end)).toString('base64');
        await workspaceWrites.write(anchor, { path: target, uploadId, offset, data, total: bytes.length, final: end === bytes.length, expectedEtag }, validate);
        offset = end;
      } while (offset < bytes.length);
    } catch (error) {
      await workspaceWrites.abort(uploadId);
      if (error instanceof WorkspaceTransferError && error.code === WORKSPACE_CONFLICT_CODE) throw refused('PT409', 'This resource changed: read it again');
      throw error;
    }
  }

  async function apply(change: AssistantPanelCommit, item: AssistantPanelItem | null): Promise<void> {
    const domain = change.domain as HomeDomain;
    if (domain === 'personality') {
      if (change.operation !== 'save' || typeof change.data?.text !== 'string') throw refused('22023', 'The personality is only ever saved, as text');
      const target = await at(null, domain, true);
      const now = await readFile(target, 'utf8').catch((error: unknown) => { if (missing(error)) return ''; throw error; });
      await replace(target, Buffer.from(composeInstructions(now, change.data.text)), change.expectedRevision, '1');
      return;
    }
    const data = change.data ?? {};
    const path = domain === 'memory' ? (data.relativePath ?? item?.data.relativePath ?? change.key)
      : domain === 'files' ? (data.path ?? item?.data.path ?? change.key)
      : domain === 'skills' ? `${change.key}/SKILL.md` : change.key;
    if (typeof path !== 'string') throw refused('22023', 'The change names no path');
    if (change.operation === 'remove') {
      if (!item) return;
      const target = await at(domain === 'skills' ? change.key : path, domain);
      await rm(target, { recursive: true, force: true });
      if (domain === 'memory') {
        const index = await at('MEMORY.md', domain);
        const text = await readFile(index, 'utf8').catch((error: unknown) => { if (missing(error)) return null; throw error; });
        const next = text === null ? null : removeIndexEntry(text, path);
        if (text !== null && next !== text) await atomicWriteText(index, next!);
      }
      return;
    }
    if (change.operation !== 'save') throw refused('22023', `This store does not ${change.operation}`);
    const target = await at(path, domain, true);
    const from = item && item.body_item_id?.startsWith(LOCAL_BODY) ? item.body_item_id.slice(LOCAL_BODY.length) : item?.resource_key;
    if ((domain === 'files' || domain === 'voice-notes') && data.kind === 'directory') {
      await mkdir(target, { recursive: true, mode: 0o700 });
      // A folder renamed: its contents moved first (deepest first), what is left of the old one goes if it is empty.
      if (item && from && from !== path) await rmdir(await at(from, domain)).catch(() => undefined);
      return;
    }
    if (!change.body) throw refused('22023', 'A file is saved with its content');
    if (change.body.itemId === item?.body_item_id && from && from !== path) {
      await rename(await at(from, domain), target);
      return;
    }
    const bytes = await bytesOf(change.body.itemId, domain);
    if (sha256(bytes) !== change.body.sha256) throw refused('22023', 'The content does not match its digest');
    await replace(target, bytes, change.expectedRevision);
    if (change.body.itemId.startsWith(UPLOAD_BODY)) uploads.delete(change.body.itemId);
  }

  async function commit(assistant: string, change: AssistantPanelCommit): Promise<AssistantPanelReceipt> {
    if (assistant !== input.assistantId) throw refused('42501', 'Personal assistant is not available to this account');
    if (!(DOMAINS as readonly string[]).includes(change.domain)) throw refused('22023', `The ${change.domain} resources are not kept here`);
    const receiptKey = JSON.stringify([input.ownerId, input.assistantId, anchor, change.operationId]);
    const done = receipts.get(receiptKey);
    if (done) return done;
    const domain = change.domain as HomeDomain;
    const item = await current(domain, change.key);
    if ((item?.revision ?? '0') !== change.expectedRevision) throw refused('PT409', 'This resource changed: read it again', change.key, domain);
    await apply(change, item);
    const after = await current(domain, domain === 'files' && typeof change.data?.path === 'string' ? change.data.path
      : domain === 'memory' && typeof change.data?.relativePath === 'string' ? change.data.relativePath : change.key);
    const receipt: AssistantPanelReceipt = { operationId: change.operationId, revision: after?.revision ?? item?.revision ?? '0', status: 'applied' };
    receipts.set(receiptKey, receipt);
    for (const old of [...receipts.keys()].slice(0, Math.max(0, receipts.size - RECEIPTS_KEPT))) receipts.delete(old);
    input.changed();
    return receipt;
  }

  return {
    client: {
      snapshot: async (assistant) => {
        if (assistant !== input.assistantId) throw refused('42501', 'Personal assistant is not available to this account');
        return snapshot();
      },
      resource: async (assistant, domain, key) => {
        if (assistant !== input.assistantId) throw refused('42501', 'Personal assistant is not available to this account');
        return (DOMAINS as readonly string[]).includes(domain) ? current(domain as HomeDomain, key) : null;
      },
      commit: (assistant, change) => writes.runExclusive(anchor, () => commit(assistant, change)),
    },
    watch: (signal, changed) => watchAssistantHome(input.home, signal, changed),
    async readBody(item, maxBytes) {
      if (!item.body_item_id) throw refused('body-unavailable', 'No content');
      const bytes = await bytesOf(item.body_item_id, item.domain as FileDomain);
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw Object.assign(refused('too-large', 'Too large'), { size: bytes.byteLength });
      if (item.body_sha256 !== sha256(bytes)) throw refused('PT409', 'The file changed during this read');
      return bytes;
    },
    async upload(_label, bytes) {
      const itemId = `${UPLOAD_BODY}${randomUUID()}`;
      uploads.set(itemId, bytes.slice());
      return { itemId, sha256: sha256(bytes) };
    },
    async discard(itemId) { uploads.delete(itemId); },
  };
}

/** Whether `deviceId` is this computer (an unknowable answer is a read failure, never "elsewhere"). */
export async function isThisComputer(deviceId: string): Promise<boolean> {
  const { otherMachines } = await import('@main/core/sessions/session-family');
  try {
    return await otherMachines().isThisDevice(deviceId);
  } catch {
    throw Object.assign(new Error('Could not tell whether its home is this computer'), { code: 'failed' });
  }
}

/** The agent's one session on this computer, by the roster's binding (none: it does not live here). */
export async function agentSessionHere(ownerId: string, agentId: string): Promise<string | null> {
  const found = new Set(agentsForOwner(await listAgents(process.env, { includeGuests: true }), ownerId)
    .filter((agent) => agent.gugu_user_id === agentId)
    .map((agent) => agent.cache?.[SESSIONPAGE_SESSION_CACHE_KEY])
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  if (found.size > 1) throw Object.assign(new Error('This agent is bound to more than one session here'), { code: 'failed' });
  return [...found][0] ?? null;
}

/**
 * The personal assistant's home, when it lives on this computer: its home device is this one and its session is here,
 * in the folder that session works in. Null: it lives elsewhere.
 */
export async function assistantHomeHere(ownerId: string, agentId: string, deviceId: string): Promise<AssistantHomeHere | null> {
  if (!(await isThisComputer(deviceId))) return null;
  const sessionId = await agentSessionHere(ownerId, agentId);
  if (!sessionId) throw refused('failed', 'The local assistant session is unavailable');
  const [row] = await db.select({ path: workspaces.path, archivedAt: sessions.archivedAt }).from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId)).where(eq(sessions.id, sessionId)).limit(1);
  if (!row?.path || row.archivedAt != null) throw refused('failed', 'The local assistant workspace is unavailable');
  const kind = assistantHomeKind(process.env), home = homedir();
  return { paths: assistantHomePaths(home, row.path, kind), anchor: kind === 'cloud' ? home : row.path };
}
