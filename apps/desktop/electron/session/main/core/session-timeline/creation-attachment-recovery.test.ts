import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentCreationHost, type AttachmentCreationHostDeps } from './creation-attachment-host';
import { openCreationAttachmentJournal } from './creation-attachment-journal';
import type { SessionCreateAttachmentDraftRequest, SessionAdmitCreatedAttachmentsRequest } from '@gugu/session-core/session-record/creation-attachment-protocol';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'creation-recovery-')); roots.push(root);
  const tasks = new Map<string, { projectId: string; title: string }>();
  const accepted = new Set<string>();
  const request: SessionCreateAttachmentDraftRequest = { harness: 'codex', prompt: 'original', clientRequestId: 'creation',
    initialMessageId: 'first', projectId: 'project', attachments: [{ id: 'a', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) }] };
  const deps: AttachmentCreationHostDeps = {
    root: () => root, context: async () => ({ ownerId: 'owner', deviceId: 'device' }),
    create: vi.fn(async (_request, id, beforeCommit) => { await beforeCommit(); tasks.set(id, { projectId: 'project', title: 'Task' }); }),
    task: async id => tasks.get(id) ?? null,
    address: async () => ({ agentUserId: 'agent', chatId: 'dm' }),
    resolve: vi.fn(async file => ({ agentUserId: 'agent', chatId: 'dm', itemId: file.itemId, version: file.version!, sizeBytes: 3, sha256: 'a'.repeat(64) })),
    prior: (_conversation, _text, id) => accepted.has(id) ? 'accepted' : null,
    send: vi.fn(async (_conversation, _text, id) => { accepted.add(id); }),
  };
  const host = createAttachmentCreationHost(deps), result = await host.create(request);
  const input: SessionAdmitCreatedAttachmentsRequest = { conversationId: result.conversationId, clientRequestId: 'creation', initialMessageId: 'first',
    placements: [{ attachmentId: 'a', file: { itemId: 'item', version: 2, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3 } }] };
  const journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'creation');
  return { root, request, input, deps, host, journal, result, accepted, tasks };
}

// This suite exercises real POSIX files, not Windows DPAPI/VFS. That native
// backend retains its separate real-SQLite/portable-encryption test boundary.
describe.skipIf(process.platform === 'win32')('attachment input crash recovery with the real private journal', () => {
  it('does not inject twice after native consumption but before any receipt is persisted', async () => {
    const f = await fixture(); let nativeInjections = 0;
    vi.mocked(f.deps.send).mockImplementation(async () => { nativeInjections += 1; throw new Error('interrupted before receipt'); });
    await expect(f.host.admit(f.input)).rejects.toThrow('interrupted');
    expect(await f.journal.read('admitting')).toEqual({ initialMessageId: 'first', placementKey: JSON.stringify([['a', 'item', 2]]) });
    expect(await f.journal.read('admitted')).toBeNull();
    await expect(createAttachmentCreationHost(f.deps).admit(f.input)).rejects.toThrow('outcome is unknown');
    expect(nativeInjections).toBe(1); expect(f.deps.create).toHaveBeenCalledTimes(1); expect(f.tasks.size).toBe(1);
  });
  it('settles a proven durable receipt after a lost ACK without another native injection', async () => {
    const f = await fixture();
    vi.mocked(f.deps.send).mockImplementationOnce(async () => { f.accepted.add('first'); throw new Error('ACK lost'); });
    await expect(f.host.admit(f.input)).rejects.toThrow('ACK lost');
    vi.mocked(f.deps.resolve).mockClear().mockRejectedValue(new Error('permission now revoked'));
    expect((await createAttachmentCreationHost(f.deps).admit(f.input)).attachmentDraft.state).toBe('admitted');
    expect(f.deps.send).toHaveBeenCalledTimes(1); expect(f.deps.resolve).not.toHaveBeenCalled();
  });
  it('permits the same request after a definite pre-claim byte-proof rejection', async () => {
    const f = await fixture(); vi.mocked(f.deps.resolve).mockRejectedValueOnce(new Error('preflight rejected'));
    await expect(f.host.admit(f.input)).rejects.toThrow('preflight rejected');
    expect(await f.journal.read('admitting')).toBeNull(); expect(f.deps.send).not.toHaveBeenCalled();
    expect((await createAttachmentCreationHost(f.deps).admit(f.input)).attachmentDraft.state).toBe('admitted');
    expect(f.deps.send).toHaveBeenCalledTimes(1); expect(f.tasks.size).toBe(1);
  });
  it('retains an unknown claim if persistence completed before its response failed', async () => {
    const f = await fixture();
    f.deps.journal = async (...args) => {
      const actual = await openCreationAttachmentJournal(...args);
      return { ...actual, append: async (stage, value) => {
        const appended = await actual.append(stage, value);
        if (stage === 'admitting') throw new Error('claim ACK lost');
        return appended;
      } };
    };
    await expect(createAttachmentCreationHost(f.deps).admit(f.input)).rejects.toThrow('claim ACK lost');
    delete f.deps.journal;
    await expect(createAttachmentCreationHost(f.deps).admit(f.input)).rejects.toThrow('outcome is unknown');
    expect(await f.journal.read('admitting')).not.toBeNull(); expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('does not retrofit a fresh claim onto an old ambiguous prepared journal', async () => {
    const f = await fixture();
    await f.journal.append('prepared', { placementKey: JSON.stringify([['a', 'item', 2]]), files: [] });
    await expect(createAttachmentCreationHost(f.deps).admit(f.input)).rejects.toThrow('outcome is unknown');
    expect(await f.journal.read('admissionProtocol')).toBeNull(); expect(await f.journal.read('admitting')).toBeNull();
    expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('allows a new-protocol prepared fact to continue when no dispatch claim exists', async () => {
    const f = await fixture();
    await f.journal.append('admissionProtocol', { version: 2 });
    await f.journal.append('prepared', { placementKey: JSON.stringify([['a', 'item', 2]]), files: [{ itemId: 'item', version: 2, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3,
      requiredPlacement: { chatId: 'dm', sha256: 'a'.repeat(64) } }] });
    expect((await createAttachmentCreationHost(f.deps).admit(f.input)).attachmentDraft.state).toBe('admitted');
    expect(f.deps.send).toHaveBeenCalledTimes(1);
  });
  it('refuses another host while the exclusive claimant is still inside native dispatch', async () => {
    const f = await fixture(); let entered!: () => void, release!: () => void;
    const inNative = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.deps.send).mockImplementationOnce(async () => { entered(); await resume; f.accepted.add('first'); });
    const first = f.host.admit(f.input);
    try {
      await inNative;
      await expect(createAttachmentCreationHost(f.deps).admit(f.input)).rejects.toThrow('outcome is unknown');
      expect(f.deps.send).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
  });
  it('rejects a losing claim with an uncertain prior even when an admitted marker exists', async () => {
    const f = await fixture();
    f.deps.prior = () => 'uncertain';
    f.deps.journal = async (...args) => {
      const actual = await openCreationAttachmentJournal(...args);
      return { ...actual, append: async (stage, value) => {
        if (stage === 'admitting') {
          await actual.append(stage, value);
          await actual.append('admitted', { initialMessageId: 'first' });
          return false;
        }
        return actual.append(stage, value);
      } };
    };
    await expect(createAttachmentCreationHost(f.deps).admit(f.input)).rejects.toThrow('receipt conflicts');
    expect(await f.journal.read('admitted')).toEqual({ initialMessageId: 'first' });
    expect(f.deps.send).not.toHaveBeenCalled();
  });
});
