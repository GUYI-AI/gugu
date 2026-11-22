import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentCreationHost, type AttachmentCreationHostDeps } from './creation-attachment-host';
import { openCreationAttachmentJournal } from './creation-attachment-journal';
import type { SessionCreateAttachmentDraftRequest } from '@gugu/session-core/session-record/creation-attachment-protocol';

const fault = vi.hoisted(() => ({
  fail: null as { path: string; occurrence: number } | null,
  closeFailures: new Map<string, unknown>(),
  syncs: new Map<string, number>(), events: [] as string[], opened: 0, closed: 0,
}));
// Real directory handles and actual fsync remain in the path: fsync on the descriptor, since the
// project setup elides FileHandle flushes (vitest-file-flush.ts); only the chosen barrier reports EIO.
// This models a failed durability ACK, not a power-off test.
vi.mock('node:fs/promises', async importOriginal => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  const fsync = (await import('node:util')).promisify((await import('node:fs')).fsync);
  return { ...native, open: async (...args: Parameters<typeof native.open>) => {
    const handle = await native.open(...args), path = String(args[0]);
    const close = handle.close.bind(handle);
    fault.opened += 1;
    handle.sync = async () => {
      const count = (fault.syncs.get(path) ?? 0) + 1; fault.syncs.set(path, count);
      fault.events.push(`sync:${path}`);
      if (fault.fail?.path === path && fault.fail.occurrence === count) {
        throw Object.assign(new Error('directory barrier failed'), { code: 'EIO' });
      }
      await fsync(handle.fd);
    };
    handle.close = async () => {
      try { await close(); } finally { fault.closed += 1; }
      if (fault.closeFailures.has(path)) throw fault.closeFailures.get(path);
    };
    return handle;
  } };
});
const roots: string[] = [];
beforeEach(() => { fault.fail = null; fault.closeFailures.clear(); fault.syncs.clear(); fault.events.length = 0; fault.opened = 0; fault.closed = 0; });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const anchor = await mkdtemp(join(tmpdir(), 'creation-durability-')); roots.push(anchor);
  const root = join(anchor, 'private', 'creation-attachments', 'v1');
  const tasks = new Map<string, { projectId: string; title: string }>();
  const request: SessionCreateAttachmentDraftRequest = { harness: 'codex', prompt: '', clientRequestId: 'creation',
    initialMessageId: 'first', projectId: 'project', attachments: [{ id: 'a', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) }] };
  const deps: AttachmentCreationHostDeps = {
    root: () => root, durabilityRoot: () => anchor, context: async () => ({ ownerId: 'owner', deviceId: 'device' }),
    create: vi.fn(async (_request, id, beforeCommit) => {
      fault.events.push('task'); await beforeCommit(); tasks.set(id, { projectId: 'project', title: 'Task' });
    }),
    task: async id => tasks.get(id) ?? null, address: async () => ({ agentUserId: 'agent', chatId: 'dm' }),
    resolve: vi.fn(), prior: () => null, send: vi.fn(),
  };
  return { anchor, root, tasks, request, deps };
}

describe.skipIf(process.platform === 'win32')('creation directory durability before any task/native side effect', () => {
  it.each([
    ['anchor', 1], ['private', 2], ['creation-attachments', 2], ['v1', 2],
  ] as const)('fails closed at the %s parent barrier, including when the failed directories already exist', async (part, occurrence) => {
    const f = await fixture();
    const chain = [f.anchor, join(f.anchor, 'private'), join(f.anchor, 'private', 'creation-attachments'), f.root];
    const path = chain[['anchor', 'private', 'creation-attachments', 'v1'].indexOf(part)];
    fault.fail = { path, occurrence };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fault.syncs.clear();
      await expect(createAttachmentCreationHost(f.deps).create(f.request)).rejects.toThrow('directory barrier failed');
      expect(f.deps.create).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
      expect(f.tasks.size).toBe(0); expect(fault.closed).toBe(fault.opened);
    }
    // Keep all partially created directories. A new host must redo the chain,
    // not depend on mkdir returning a first-created path a second time.
    fault.fail = null; fault.syncs.clear(); fault.events.length = 0;
    const created = await createAttachmentCreationHost(f.deps).create(f.request);
    expect(f.deps.create).toHaveBeenCalledTimes(1); expect(f.deps.send).not.toHaveBeenCalled();
    const beforeTask = fault.events.slice(0, fault.events.indexOf('task'));
    for (const ancestor of chain) expect(beforeTask).toContain(`sync:${ancestor}`);
    expect((await createAttachmentCreationHost(f.deps).create(f.request)).conversationId).toBe(created.conversationId);
    expect(f.deps.create).toHaveBeenCalledTimes(1); expect(fault.closed).toBe(fault.opened);
  });
  it('requires the controller anchor before creating any journal directory', async () => {
    const f = await fixture();
    await expect(openCreationAttachmentJournal(f.root, 'owner', 'device', 'creation')).rejects.toThrow('durable attachment storage boundary');
    expect(await readdir(f.anchor)).toEqual([]); expect(fault.opened).toBe(0);
  });
  it('preserves the barrier failure when cleanup also fails and still closes all ancestors', async () => {
    const f = await fixture();
    fault.fail = { path: join(f.anchor, 'private', 'creation-attachments'), occurrence: 2 };
    fault.closeFailures.set(f.root, new Error('close acknowledgement failed'));
    await expect(createAttachmentCreationHost(f.deps).create(f.request)).rejects.toThrow('directory barrier failed');
    expect(fault.closed).toBe(fault.opened); expect(f.deps.create).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('refuses a cleanup-only failure even when its thrown value is undefined', async () => {
    const f = await fixture(); fault.closeFailures.set(f.root, undefined);
    await expect(createAttachmentCreationHost(f.deps).create(f.request)).rejects.toBeUndefined();
    expect(fault.closed).toBe(fault.opened); expect(f.deps.create).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('rejects paths outside the anchor and excessive depth without creating them', async () => {
    const f = await fixture();
    for (const root of [join(f.anchor, '..', 'creation-escape'), join(f.anchor, ...Array<string>(33).fill('nested'))]) {
      await expect(openCreationAttachmentJournal(root, 'owner', 'device', 'creation', { durabilityRoot: f.anchor })).rejects.toThrow('outside its durable boundary');
    }
    expect(await readdir(f.anchor)).toEqual([]); expect(fault.opened).toBe(0);
  });
  it('rejects an intermediate symlink before writing through it and closes every held ancestor', async () => {
    const f = await fixture(), other = join(f.anchor, 'other');
    await mkdir(other, { mode: 0o700 }); await symlink(other, join(f.anchor, 'private'));
    await expect(createAttachmentCreationHost(f.deps).create(f.request)).rejects.toThrow();
    expect(await readdir(other)).toEqual([]); expect(f.deps.create).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled(); expect(fault.closed).toBe(fault.opened);
  });
  it('rejects a writable intermediate directory without proceeding to a task', async () => {
    const f = await fixture(), intermediate = join(f.anchor, 'private');
    await mkdir(intermediate, { mode: 0o700 }); await chmod(intermediate, 0o777);
    await expect(createAttachmentCreationHost(f.deps).create(f.request)).rejects.toThrow('stable private directory');
    expect(await readdir(intermediate)).toEqual([]); expect(f.deps.create).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled(); expect(fault.closed).toBe(fault.opened);
  });
});
