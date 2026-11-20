import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * API 60: an App's page asks the person to pick files of its chat (`files.pick`) or someone of its chat (`pickAgent({ include })`)
 * in the host's own sheet. Main lists what may be picked, as the person; the window draws it and says which; only what it was
 * handed counts, and the files picked open for that page with no capability until its document goes.
 */

const PAGE = 7;
const OTHER_PAGE = 8;
const CHECK = 9;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: id === CHECK ? undefined : { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });
const embedder = { id: 42, isDestroyed: () => false, send: vi.fn() };

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: {},
  webContents: { fromId: (id: number) => (id === 42 ? embedder : [PAGE, OTHER_PAGE, CHECK].includes(id) ? contentsOf(id) : undefined) },
}));
const capabilities = new Set<string>();
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'tree', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => [...capabilities],
    hasCapability: (_id: string, capability: string) => capabilities.has(capability),
    get: () => ({ manifest: { name: 'Tree', apiVersion: 60, contributes: { tabs: [] } } }),
    origins: () => ({}),
  }),
  extensionDataRoot: () => '/data/tree',
}));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => new Map() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const CHAT = '0b000000-0000-4000-8000-000000000060';
const ME = 'user:0a000000-0000-4000-8000-000000000001';
const THEIRS = 'user:0a000000-0000-4000-8000-000000000002';
const BOT = 'user:0a000000-0000-4000-8000-000000000003';
const entry = (id: string, path: string, updatedAt: string, more: Record<string, unknown> = {}) =>
  ({ id, chat: CHAT, path, name: path.split('/').pop(), suffix: `.${path.split('.').pop()}`, contentType: 'text/plain', type: 'text', appState: false, updatedAt, size: 3, ...more });
const OLD = entry('0c000000-0000-4000-8000-000000000001', '数据/ctDNA.csv', '2026-11-19T10:00:00Z');
const NEW = entry('0c000000-0000-4000-8000-000000000002', 'plan.md', '2026-11-20T10:00:00Z');
const FOLDER = entry('0c000000-0000-4000-8000-000000000003', '数据', '2026-11-20T11:00:00Z', { type: 'folder' });
const UPLOADED = entry('0c000000-0000-4000-8000-000000000004', 'scan.png', '2026-11-20T12:00:00Z');
const files = {
  resourceChatOf: vi.fn(async (id: string) => id),
  surfaceChatOf: vi.fn(async (id: string) => ({ id, name: '研究组' })),
  changedGroupFiles: vi.fn(async () => ({ entries: [], gone: [] })),
  listAppFiles: vi.fn(async () => [OLD, NEW, FOLDER]),
  openAppFile: vi.fn(async () => ({ entry: NEW })),
  pickFilesToUpload: vi.fn(async () => [{ name: 'scan.png', contentType: 'image/png', bytes: new ArrayBuffer(1) }]),
  uploadAppFiles: vi.fn(async () => [UPLOADED]),
  chatMembersOf: vi.fn(async () => [
    { id: ME, name: 'Ann', kind: 'human' },
    { id: THEIRS, name: 'Bo', kind: 'human' },
    { id: BOT, name: 'Helper', kind: 'agent' },
  ]),
};
vi.mock('@main/core/extensions/app-files', () => files);
const relay = {
  invokeInEmbedder: vi.fn(async (_embedder: number | null, _method: string, _ask: unknown): Promise<unknown> => null),
  pickDispatchTarget: vi.fn(async (_embedder: number | null, _ask: unknown): Promise<unknown> => null),
  actInWindow: async () => undefined,
  listedSessionProject: async () => null,
};
vi.mock('@main/core/extensions/extension-bridge-relay', () => relay);
vi.mock('@main/core/extensions/extension-send', () => ({ cloudForApp: { write: vi.fn(async () => 'written') } }));

const { bindExtensionSurface, registerExtensionBridge, unbindExtensionSurface } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown> = {}, gesture = true) =>
  handle({ sender: { id: sender, session: {} } }, { method, args, gesture }) as Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;

beforeEach(async () => {
  capabilities.clear();
  for (const fn of [...Object.values(files), relay.invokeInEmbedder, relay.pickDispatchTarget]) fn.mockClear();
  for (const id of [PAGE, OTHER_PAGE, CHECK]) unbindExtensionSurface(id);
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'tree', tabId: 'slot', tabKind: 'tree.main', conversation: CHAT });
  await bindExtensionSurface({ webContentsId: OTHER_PAGE, extensionId: 'tree', tabId: 'slot-2', tabKind: 'tree.main', conversation: CHAT });
});

describe('files.pick', () => {
  it('offers the chat’s files, newest first, in the window that draws the page; answers only what it offered', async () => {
    relay.invokeInEmbedder.mockResolvedValueOnce({ ids: [NEW.id, 'not-offered'] });
    const answer = await call(PAGE, 'filesPick', { place: { chat: CHAT }, title: '挂一个群文件', upload: true });
    expect(answer).toEqual({ ok: true, value: [NEW] });
    expect(files.listAppFiles).toHaveBeenCalledWith(expect.objectContaining({ pageId: PAGE }), { place: { chat: CHAT } });
    // No files:write: no 「从电脑添加…」, whatever the call said.
    expect(relay.invokeInEmbedder).toHaveBeenCalledWith(42, 'extensions.pickChatFiles', { files: [NEW, OLD], multiple: false, title: '挂一个群文件', upload: false });
  });

  it('needs no capability, but the person’s gesture; a page an agent works hands it back, the window untouched', async () => {
    expect(await call(PAGE, 'filesPick', { place: { chat: CHAT } }, false)).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('gesture') });
    await bindExtensionSurface({ webContentsId: CHECK, extensionId: 'tree', tabId: 'extension-check:9', tabKind: 'tree.main', conversation: CHAT, operator: { kind: 'agent', id: BOT } });
    expect(await call(CHECK, 'filesPick', { place: { chat: CHAT } })).toEqual({ ok: true, value: [] });
    expect(relay.invokeInEmbedder).not.toHaveBeenCalled();
    expect(await call(PAGE, 'filesPick', { place: { workspace: 'x' } })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('the picked files are handed to that page — not to another — until its document goes', async () => {
    relay.invokeInEmbedder.mockResolvedValueOnce({ ids: [NEW.id] });
    await call(PAGE, 'filesPick', { place: { chat: CHAT } });
    await call(PAGE, 'filesOpen', { ref: { chat: CHAT, id: NEW.id } });
    expect(files.openAppFile).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: PAGE, picked: new Set([NEW.id]) }), expect.anything());
    await call(OTHER_PAGE, 'filesOpen', { ref: { chat: CHAT, id: NEW.id } });
    expect(files.openAppFile).toHaveBeenLastCalledWith(expect.not.objectContaining({ picked: expect.anything() }), expect.anything());
    unbindExtensionSurface(PAGE);
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'tree', tabId: 'slot', tabKind: 'tree.main', conversation: CHAT });
    await call(PAGE, 'filesOpen', { ref: { chat: CHAT, id: NEW.id } });
    expect(files.openAppFile).toHaveBeenLastCalledWith(expect.not.objectContaining({ picked: expect.anything() }), expect.anything());
  });

  it('with files:write, 「从电脑添加…」 uploads through the one picker and answers the new file, handed too', async () => {
    capabilities.add('files:write');
    relay.invokeInEmbedder.mockResolvedValueOnce({ upload: true });
    expect(await call(PAGE, 'filesPick', { place: { chat: CHAT }, suffixes: ['.png', '.csv'], upload: true })).toEqual({ ok: true, value: [UPLOADED] });
    expect(relay.invokeInEmbedder).toHaveBeenCalledWith(42, 'extensions.pickChatFiles', expect.objectContaining({ files: [OLD], upload: true }));
    expect(files.pickFilesToUpload).toHaveBeenCalledWith(embedder);
    expect(files.uploadAppFiles).toHaveBeenCalledWith(expect.objectContaining({ pageId: PAGE }), { chat: CHAT }, expect.any(Array));
    await call(PAGE, 'filesOpen', { ref: { chat: CHAT, id: UPLOADED.id } });
    expect(files.openAppFile).toHaveBeenLastCalledWith(expect.objectContaining({ picked: new Set([UPLOADED.id]) }), expect.anything());
  });

  it('cancelled: [] and nothing handed', async () => {
    expect(await call(PAGE, 'filesPick', { place: { chat: CHAT }, multiple: true })).toEqual({ ok: true, value: [] });
    await call(PAGE, 'filesOpen', { ref: { chat: CHAT, id: NEW.id } });
    expect(files.openAppFile).toHaveBeenLastCalledWith(expect.not.objectContaining({ picked: expect.anything() }), expect.anything());
  });
});

describe('pickAgent({ include })', () => {
  const words = { title: '交给谁', subject: 's', body: 'b', action: '选', search: '搜', empty: '空' };

  it('by default offers the person’s own agents only, and reads no members', async () => {
    relay.pickDispatchTarget.mockResolvedValueOnce({ to: { agent: BOT }, visible: false, text: '' });
    expect(await call(PAGE, 'pickAgent', words)).toEqual({ ok: true, value: { agent: BOT } });
    expect(relay.pickDispatchTarget).toHaveBeenCalledWith(42, expect.objectContaining({ offers: ['my-agent'], chat: null }));
    expect(files.chatMembersOf).not.toHaveBeenCalled();
  });

  it('people: the chat’s agents and people, the person among them; a person answers { member }, an agent { agent }', async () => {
    relay.pickDispatchTarget.mockResolvedValueOnce({ to: { chat: CHAT, member: THEIRS }, visible: false, text: '' });
    expect(await call(PAGE, 'pickAgent', { ...words, include: 'people' })).toEqual({ ok: true, value: { member: THEIRS } });
    expect(relay.pickDispatchTarget).toHaveBeenCalledWith(42, expect.objectContaining({
      offers: ['agent-in-chat', 'person-in-chat'],
      chat: expect.objectContaining({ id: CHAT, members: expect.arrayContaining([expect.objectContaining({ id: ME })]) }),
      pick: expect.objectContaining({ title: '交给谁' }),
    }));
    relay.pickDispatchTarget.mockResolvedValueOnce({ to: { chat: CHAT, member: BOT }, visible: false, text: '' });
    expect(await call(PAGE, 'pickAgent', { ...words, include: 'all', write: { name: 'assign', args: { node: 'n1' }, agent: 'owner' } }))
      .toEqual({ ok: true, value: { agent: BOT, written: 'written' } });
    expect(relay.pickDispatchTarget).toHaveBeenLastCalledWith(42, expect.objectContaining({ offers: ['agent-in-chat', 'person-in-chat', 'my-agent'] }));
    const { cloudForApp } = await import('@main/core/extensions/extension-send');
    expect(cloudForApp.write).toHaveBeenCalledWith(expect.anything(), 'assign', { node: 'n1', owner: BOT.replace(/^user:/, '') });
  });

  it('an include it does not know is invalid', async () => {
    expect(await call(PAGE, 'pickAgent', { ...words, include: 'everyone' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});
