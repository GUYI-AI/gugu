import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles';
import { assistantPanelCollection } from '@gugu/core/cloud/assistantPanel';
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy';

vi.mock('@main/core/runtime/runtime-manager', async () => {
  const { FilesRuntime } = await import('@gugu/session-core/files');
  return { runtimeManager: { acquire: async () => {
    const files = new FilesRuntime();
    return { value: { files }, release: () => files.dispose() };
  } } };
});
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@gugu/core', () => ({ listAgents: async () => [] }));
const { createAssistantHomeStore } = await import('./assistant-home-store');

/**
 * The assistant's home on this computer as an App's binding reads and changes it: its own files, answered with the store's
 * items, revisions and receipts. A change is checked against the file as it is now and written at once.
 */
const OWNER = 'owner-1';
const AGENT = 'agent-1';
let root: string;
let workdir: string;
let changed: () => void;
const open = () => {
  const paths = assistantHomePaths(join(root, 'home'), workdir, 'computer');
  return { paths, store: createAssistantHomeStore({ ownerId: OWNER, assistantId: AGENT, deviceId: 'this-device', home: { paths, anchor: workdir }, changed }) };
};
const files = (store: ReturnType<typeof open>['store']) => createAssistantPanelFiles({
  assistantId: AGENT, deviceId: 'this-device', ownerId: OWNER, cloud: store.client as never, assertCurrent: () => undefined,
  readBody: (item) => store.readBody(item), upload: (label, bytes) => store.upload(label, bytes), discard: (id) => store.discard(id), changed: () => undefined,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'assistant-home-'));
  workdir = join(root, 'assistant');
  await mkdir(join(workdir, '.claude', 'memory'), { recursive: true });
  changed = vi.fn();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('reading the home', () => {
  it('lists each domain from its folder, ready, with titles, kinds, sizes and content digests', async () => {
    const { paths, store } = open();
    await writeFile(join(paths.memoryDir, 'owner-profile.md'), '# About me\nLikes tea');
    await writeFile(join(paths.memoryDir, 'MEMORY.md'), '- [About me](owner-profile.md)\n- [Mornings](notes/m.md)\n');
    await mkdir(join(paths.memoryDir, 'notes'));
    await writeFile(join(paths.memoryDir, 'notes', 'm.md'), '---\ntype: feedback\n---\n# Mornings\nbody');
    await writeFile(join(paths.memoryDir, '.panel-state-x.json'), '{}');
    await mkdir(join(paths.resourcesDir, 'docs'), { recursive: true });
    await writeFile(join(paths.resourcesDir, 'docs', 'plan.txt'), 'week');
    await writeFile(paths.instructions, 'Be brief.');
    const snapshot = await store.client.snapshot(AGENT);
    const memory = assistantPanelCollection(snapshot, 'memory');
    expect(memory.state).toBe('ready');
    expect(memory.items.map((item) => [item.resource_key, item.data.title, item.data.kind])).toEqual([
      ['MEMORY.md', expect.any(String), expect.any(String)], ['notes/m.md', 'Mornings', 'feedback'], ['owner-profile.md', 'About me', 'user'],
    ]);
    expect(assistantPanelCollection(snapshot, 'files').items.map((item) => [item.resource_key, item.data.kind, item.data.sizeBytes ?? null]))
      .toEqual([['docs', 'directory', null], ['docs/plan.txt', 'file', 4]]);
    expect(assistantPanelCollection(snapshot, 'personality').items[0]!.data).toEqual({ text: 'Be brief.' });
    const plan = await store.client.resource(AGENT, 'files', 'docs/plan.txt');
    expect(new TextDecoder().decode(await store.readBody(plan!))).toBe('week');
    expect(await store.client.resource(AGENT, 'memory', 'nothing.md')).toBeNull();
  });

  it('hears an external edit in a nested home folder through the workspace feed', async () => {
    const { paths, store } = open();
    const nested = join(paths.memoryDir, 'notes');
    await mkdir(nested);
    const file = join(nested, 'morning.md');
    await writeFile(file, 'before');
    const lifetime = new AbortController();
    const heard = vi.fn();
    try {
      await store.watch(lifetime.signal, heard);
      await writeFile(file, 'after');
      await vi.waitFor(() => expect(heard).toHaveBeenCalled());
      const item = await store.client.resource(AGENT, 'memory', 'notes/morning.md');
      expect(new TextDecoder().decode(await store.readBody(item!))).toBe('after');
    } finally {
      lifetime.abort();
    }
  });

  it('refuses another assistant, and a path out of the home', async () => {
    const { store } = open();
    await expect(store.client.snapshot('agent-2')).rejects.toMatchObject({ code: '42501' });
    await expect(store.client.commit(AGENT, { operationId: 'op-1', domain: 'files', key: '../escape.txt', expectedRevision: '0', operation: 'save',
      data: { path: '../escape.txt', kind: 'file' }, body: await store.upload('x', new TextEncoder().encode('x')) })).rejects.toThrow();
    expect(await readdir(root)).toEqual(['assistant']);
  });
});

describe('changing the home', () => {
  it('saves at the revision read, answers the same receipt for the same operation, and refuses a stale revision', async () => {
    const { paths, store } = open();
    const bytes = new TextEncoder().encode('# Tea\nGreen');
    const body = await store.upload('tea.md', bytes);
    const receipt = await store.client.commit(AGENT, { operationId: 'op-1', domain: 'memory', key: 'tea.md', expectedRevision: '0', operation: 'save',
      data: { relativePath: 'tea.md' }, body });
    expect(receipt).toMatchObject({ operationId: 'op-1', status: 'applied' });
    expect(await readFile(join(paths.memoryDir, 'tea.md'), 'utf8')).toBe('# Tea\nGreen');
    expect(changed).toHaveBeenCalledOnce();
    expect(await store.client.commit(AGENT, { operationId: 'op-1', domain: 'memory', key: 'tea.md', expectedRevision: '0', operation: 'save',
      data: { relativePath: 'tea.md' }, body })).toEqual(receipt);
    const stale = store.client.commit(AGENT, { operationId: 'op-2', domain: 'memory', key: 'tea.md', expectedRevision: '0', operation: 'save',
      data: { relativePath: 'tea.md' }, body: await store.upload('tea.md', new TextEncoder().encode('other')) });
    await expect(stale).rejects.toMatchObject({ code: 'PT409' });
    expect(await readFile(join(paths.memoryDir, 'tea.md'), 'utf8')).toBe('# Tea\nGreen');
  });

  it('detects edits with identical length and mtime in resources and snapshots, and refuses the old revision', async () => {
    const { paths, store } = open();
    const path = join(paths.memoryDir, 'note.md');
    const fixedTime = new Date('2025-01-01T00:00:00Z');
    await writeFile(path, 'old');
    await utimes(path, fixedTime, fixedTime);
    const before = await store.client.snapshot(AGENT);
    const note = assistantPanelCollection(before, 'memory').items[0]!;
    await writeFile(path, 'new');
    await utimes(path, fixedTime, fixedTime);
    const after = await store.client.snapshot(AGENT);
    const edited = assistantPanelCollection(after, 'memory').items[0]!;
    expect(edited.updated_at).toBe(note.updated_at);
    expect(edited.revision).not.toBe(note.revision);
    expect(after.revision).not.toBe(before.revision);
    expect((await store.client.snapshot(AGENT)).revision).toBe(after.revision);
    await expect(store.client.commit(AGENT, { operationId: 'old-note', domain: 'memory', key: 'note.md',
      expectedRevision: note.revision, operation: 'remove' })).rejects.toMatchObject({ code: 'PT409' });
    expect(await readFile(path, 'utf8')).toBe('new');
    await rm(path);
    expect((await store.client.snapshot(AGENT)).revision).not.toBe(after.revision);
  });

  it('removes a memory and its line in MEMORY.md; saves the personality into its part of the instructions', async () => {
    const { paths, store } = open();
    await writeFile(join(paths.memoryDir, 'tea.md'), '# Tea');
    await writeFile(join(paths.memoryDir, 'MEMORY.md'), '- [Tea](tea.md)\n- [Other](other.md)\n');
    const tea = await store.client.resource(AGENT, 'memory', 'tea.md');
    await store.client.commit(AGENT, { operationId: 'op-3', domain: 'memory', key: 'tea.md', expectedRevision: tea!.revision, operation: 'remove', data: {} });
    expect(await readdir(paths.memoryDir)).toEqual(['MEMORY.md']);
    expect(await readFile(join(paths.memoryDir, 'MEMORY.md'), 'utf8')).toBe('- [Other](other.md)\n');
    const personality = await store.client.resource(AGENT, 'personality', 'instructions');
    await store.client.commit(AGENT, { operationId: 'op-4', domain: 'personality', key: 'instructions', expectedRevision: personality!.revision, operation: 'save', data: { text: 'Be kind.' } });
    expect((await store.client.resource(AGENT, 'personality', 'instructions'))!.data).toEqual({ text: 'Be kind.' });
  });

  it('the assistant pages\' own file view works over it: new folder, write, rename a folder with its files, remove', async () => {
    const { paths, store } = open();
    const view = files(store);
    await view.mkdir('给助理的资料/docs');
    await view.write('给助理的资料/docs/a.txt', new TextEncoder().encode('A'), 'text/plain');
    await view.rename('给助理的资料/docs', 'papers');
    expect(await readdir(paths.resourcesDir)).toEqual(['papers']);
    expect(await readFile(join(paths.resourcesDir, 'papers', 'a.txt'), 'utf8')).toBe('A');
    await files(store).remove('给助理的资料/papers', true);
    expect(await readdir(paths.resourcesDir)).toEqual([]);
  });
});
