import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentCreationHost, type AttachmentCreationHostDeps } from './creation-attachment-host';
import type { SessionCreateAttachmentDraftRequest, SessionAdmitCreatedAttachmentsRequest } from '@gugu/session-core/session-record/creation-attachment-protocol';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const request = (): SessionCreateAttachmentDraftRequest => ({ harness: 'codex', prompt: '',
  clientRequestId: 'creation-1', initialMessageId: 'first-1', projectId: 'project',
  attachments: [{ id: 'a', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'creation-host-')); roots.push(root);
  let context = { ownerId: 'owner', deviceId: 'device' };
  const tasks = new Map<string, { projectId: string; title: string }>();
  const accepted = new Map<string, string>();
  const deps: AttachmentCreationHostDeps = {
    root: () => root, context: async () => context,
    create: vi.fn(async (_request, sessionId, beforeCommit) => { await beforeCommit(); tasks.set(sessionId, { projectId: 'project', title: 'Task' }); }),
    task: async sessionId => tasks.get(sessionId) ?? null,
    address: vi.fn(async () => ({ agentUserId: 'agent', chatId: 'dm' })),
    resolve: vi.fn(async file => ({ agentUserId: 'agent', chatId: 'dm', itemId: file.itemId, version: file.version!, sizeBytes: 3, sha256: 'a'.repeat(64) })),
    prior: (_session, _text, id, files) => accepted.has(id) ? accepted.get(id) === JSON.stringify(files) ? 'accepted' : 'uncertain' : null,
    send: vi.fn(async (_session, _text, id, files) => { accepted.set(id, JSON.stringify(files)); }),
  };
  const host = createAttachmentCreationHost(deps);
  const input = (conversationId: string): SessionAdmitCreatedAttachmentsRequest => ({ conversationId,
    clientRequestId: 'creation-1', initialMessageId: 'first-1', placements: [{ attachmentId: 'a', file: {
      itemId: 'item', version: 2, name: 'untrusted', mimeType: 'text/plain', sizeBytes: 3, path: '/untrusted',
    } }] });
  return { root, deps, host, input, tasks, accepted, switchOwner: () => { context = { ...context, ownerId: 'other' }; } };
}

describe('attachment-first creation: real private journal and host coordinator', () => {
  it('persists before creating, returns the real target, and does not admit a caption', async () => {
    const f = await fixture();
    vi.mocked(f.deps.create).mockImplementationOnce(async (_request, id, beforeCommit) => {
      const [dir] = await readdir(f.root);
      expect(JSON.parse(await readFile(join(f.root, dir, 'intent.json'), 'utf8')).conversationId).toBe(id);
      await beforeCommit(); f.tasks.set(id, { projectId: 'project', title: 'Task' });
    });
    const result = await f.host.create(request());
    expect(result.attachmentTarget).toEqual({ agentUserId: 'agent', chatId: 'dm' });
    expect(result.attachmentDraft.state).toBe('awaiting-placement');
    expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('reopens the same durable task after host reconstruction and admits exactly the pinned first input', async () => {
    const f = await fixture(), result = await f.host.create(request());
    const restarted = createAttachmentCreationHost(f.deps);
    expect(await restarted.create(request())).toEqual(result);
    const admitted = await restarted.admit(f.input(result.conversationId));
    expect(admitted.attachmentDraft.state).toBe('admitted');
    const sent = vi.mocked(f.deps.send).mock.calls[0];
    expect(sent[2]).toBe('first-1');
    expect(sent[3][0]).toEqual({ itemId: 'item', version: 2, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 3,
      requiredPlacement: { chatId: 'dm', sha256: 'a'.repeat(64) } });
    await createAttachmentCreationHost(f.deps).admit(f.input(result.conversationId));
    expect(f.deps.create).toHaveBeenCalledTimes(1); expect(f.deps.send).toHaveBeenCalledTimes(1);
  });
  it('never re-creates a task after a commit with an unknown result and no authoritative task row', async () => {
    const f = await fixture();
    vi.mocked(f.deps.create).mockImplementationOnce(async (_request, _id, beforeCommit) => { await beforeCommit(); throw new Error('commit unknown'); });
    await expect(f.host.create(request())).rejects.toThrow('commit unknown');
    await expect(createAttachmentCreationHost(f.deps).create(request())).rejects.toThrow('cannot be recreated');
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  it('recovers a committed row after its create ACK was lost, without calling create again', async () => {
    const f = await fixture();
    vi.mocked(f.deps.create).mockImplementationOnce(async (_request, id, beforeCommit) => {
      await beforeCommit(); f.tasks.set(id, { projectId: 'project', title: 'Task' }); throw new Error('ACK lost');
    });
    await expect(f.host.create(request())).rejects.toThrow('ACK lost');
    expect((await createAttachmentCreationHost(f.deps).create(request())).attachmentDraft.state).toBe('awaiting-placement');
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  it('allows the same intent to retry a preflight failure before the commit claim', async () => {
    const f = await fixture(); vi.mocked(f.deps.create).mockRejectedValueOnce(new Error('preflight failed'));
    await expect(f.host.create(request())).rejects.toThrow('preflight failed');
    expect((await f.host.create(request())).attachmentDraft.state).toBe('awaiting-placement');
  });
  it('does not admit any file when the last authoritative byte check fails', async () => {
    const f = await fixture(), req = request(); req.attachments.push({ ...req.attachments[0], id: 'b' });
    const result = await f.host.create(req), input = f.input(result.conversationId);
    input.placements.push({ attachmentId: 'b', file: { ...input.placements[0].file, itemId: 'second' } });
    vi.mocked(f.deps.resolve).mockResolvedValueOnce({ agentUserId: 'agent', chatId: 'dm', itemId: 'item', version: 2,
      sizeBytes: 3, sha256: 'a'.repeat(64) }).mockRejectedValueOnce(new Error('last placement unavailable'));
    await expect(f.host.admit(input)).rejects.toThrow('unavailable'); expect(f.deps.send).not.toHaveBeenCalled();
    expect((await f.host.create(req)).conversationId).toBe(result.conversationId);
  });
  it('confirms the real accepted-input receipt after a lost ACK before re-reading revoked files', async () => {
    const f = await fixture(), result = await f.host.create(request()), input = f.input(result.conversationId);
    vi.mocked(f.deps.send).mockImplementationOnce(async (_session, _text, id, files) => {
      f.accepted.set(id, JSON.stringify(files)); throw new Error('input ACK lost');
    });
    await expect(f.host.admit(input)).rejects.toThrow('input ACK lost');
    vi.mocked(f.deps.resolve).mockClear().mockRejectedValue(new Error('EACCES'));
    expect((await createAttachmentCreationHost(f.deps).admit(input)).attachmentDraft.state).toBe('admitted');
    expect(f.deps.resolve).not.toHaveBeenCalled(); expect(f.deps.send).toHaveBeenCalledTimes(1);
  });
  it('retains acknowledged custody if the canonical input was later cleaned up', async () => {
    const f = await fixture(), result = await f.host.create(request()), input = f.input(result.conversationId);
    await f.host.admit(input); f.accepted.clear();
    vi.mocked(f.deps.resolve).mockRejectedValue(new Error('file removed'));
    expect((await createAttachmentCreationHost(f.deps).admit(input)).attachmentDraft.state).toBe('admitted');
    expect(f.deps.send).toHaveBeenCalledTimes(1);
  });
  it('refuses request replacement and a different account without creating or sending again', async () => {
    const f = await fixture(), result = await f.host.create(request());
    await expect(f.host.create({ ...request(), prompt: 'different' })).rejects.toThrow();
    f.switchOwner(); await expect(f.host.admit(f.input(result.conversationId))).rejects.toThrow('registered');
    expect(f.deps.create).toHaveBeenCalledTimes(1); expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('rejects a retargeted task and mismatched complete bytes', async () => {
    const f = await fixture(), result = await f.host.create(request());
    vi.mocked(f.deps.address).mockResolvedValueOnce({ chatId: 'other', agentUserId: 'agent' });
    await expect(f.host.admit(f.input(result.conversationId))).rejects.toThrow('target changed');
    vi.mocked(f.deps.resolve).mockResolvedValueOnce({ agentUserId: 'agent', chatId: 'dm', itemId: 'item', version: 2, sizeBytes: 4, sha256: 'a'.repeat(64) });
    await expect(f.host.admit(f.input(result.conversationId))).rejects.toThrow('bytes');
    expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('a corrupt record is unverified, never interpreted as a fresh request', async () => {
    const f = await fixture(); await f.host.create(request());
    const [dir] = await readdir(f.root); await writeFile(join(f.root, dir, 'intent.json'), '{');
    await expect(createAttachmentCreationHost(f.deps).create(request())).rejects.toThrow('cannot be read');
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  it('rejects replacement of a prepared placement even after the input ACK was lost', async () => {
    const f = await fixture(), result = await f.host.create(request()), input = f.input(result.conversationId);
    vi.mocked(f.deps.send).mockRejectedValueOnce(new Error('unknown input receipt'));
    await expect(f.host.admit(input)).rejects.toThrow('unknown input receipt');
    const changed = structuredClone(input); changed.placements[0].file.version = 3;
    await expect(createAttachmentCreationHost(f.deps).admit(changed)).rejects.toThrow('identities');
    expect(f.deps.send).toHaveBeenCalledTimes(1);
  });
});
