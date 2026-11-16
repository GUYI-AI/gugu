import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHostActionResult } from '@shared/extensions/host-actions';

/**
 * G1 (看板 10-19): `files.openWith(file, { peek: true })` opens beside the page that asked — told to the slot that page is
 * drawn in (`peek`), the page left as it is. A chat file nobody here opens shows in the host's preview there, so it is not
 * refused for want of an App; a folder's file on this computer goes as its workspace and path. Without `peek`, as before.
 */

const PAGE = 7;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: { id }, once: () => undefined, on: () => undefined, send: vi.fn() });
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => contentsOf(id) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: (session: { id: number }) => session.id === 8 ? 'pdf' : 'kanban', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => [], hasCapability: () => true, get: () => ({ manifest: { name: 'Kanban' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const CHAT = '0b000000-0000-4000-8000-0000000000a1';
const file = { document: false, contentType: 'application/pdf', version: 3, size: 1024 };
const local = { kind: 'folder', place: { workspace: 'project:p-1' }, projectId: 'p-1', workspaceId: 'w-1', path: 'docs/plan.html', absolutePath: '/repo/docs/plan.html', name: 'plan.html', ask: false };
const pdfApp = { extensionId: 'pdf', tabKind: 'pdf.viewer', tabTitle: 'PDF', app: { name: 'PDF' }, onlyTab: true, suffix: '.pdf' };
const chooser = vi.hoisted(() => ({ kind: 'none' as string }));
// Where the file is and who opens it are app-files' (their own tests); here, what the bridge does with the answer.
vi.mock('@main/core/extensions/app-files', async () => ({
  AppFileError: (await vi.importActual<typeof import('@shared/extensions/app-files-core')>('@shared/extensions/app-files-core')).AppFileError,
  resourceChatOf: vi.fn(async (chatId: string) => chatId),
  openWithTarget: vi.fn(async (_page: unknown, args: { ref: { workspace?: string } }) =>
    args.ref.workspace ? { kind: 'peek', target: local } : { kind: 'chat', target: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file } }),
  openerChoice: () => (chooser.kind === 'none' ? { kind: 'none' } : { kind: 'one', candidate: pdfApp }),
}));

const { bindExtensionSurface, unbindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { openWithTarget, resourceChatOf, AppFileError } = await import('./app-files');
const { fileSync } = await import('./file-sync');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const openWith = (args: Record<string, unknown>) =>
  handle({ sender: { id: PAGE, session: {} } }, { method: 'filesOpenWith', args, gesture: true }) as Promise<{ ok: boolean; value?: unknown; code?: string }>;
const deliver = vi.fn<(_origin: unknown, _action: unknown) => Promise<ExtensionHostActionResult>>(() => Promise.resolve());
const actions = () => deliver.mock.calls.map(([, action]) => action);

beforeEach(async () => {
  deliver.mockClear();
  chooser.kind = 'none';
  setExtensionBridgeHost({ deliver, selfGuguNumber: () => undefined, presentation: () => ({ locale: 'en', themeMode: 'light' as const, fullscreen: false, windowFocused: true }) });
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'kanban', tabId: 'dock', tabKind: 'kanban.board' });
  vi.mocked(resourceChatOf).mockClear();
});

describe('an already-open live file is shown before metadata validation', () => {
  beforeEach(async () => {
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'kanban', tabId: 'folder', tabKind: 'kanban.board', conversation: CHAT });
    await bindExtensionSurface({ webContentsId: 8, extensionId: 'pdf', tabId: 'file-tab', tabKind: 'pdf.viewer', conversation: CHAT, itemId: 'item-1' });
    vi.spyOn(fileSync, 'openCount').mockImplementation((id) => id === 8 ? 1 : 0);
    vi.mocked(openWithTarget).mockClear();
  });
  afterEach(() => { unbindExtensionSurface(8); vi.restoreAllMocks(); });

  it('does no metadata read until the existing tab has presented, then refreshes without activation', async () => {
    let presented!: (value: ExtensionHostActionResult) => void;
    deliver.mockImplementationOnce(() => new Promise((resolve) => { presented = resolve; }));
    const pending = openWith({ ref: { chat: CHAT, id: 'item-1' } });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.anything(), { kind: 'openChatFile', chatId: CHAT, itemId: 'item-1', onlyIfOpen: 'pdf.viewer', intent: 'navigate' }));
    expect(openWithTarget).not.toHaveBeenCalled();
    presented({ chat: CHAT });
    expect(await pending).toMatchObject({ ok: true });
    expect(openWithTarget).toHaveBeenCalledTimes(1);
    expect(actions().at(-1)).toMatchObject({ kind: 'openWith', detail: { background: true } });
    // Brought forward already: no waiting page was put up for it.
    expect(actions().some((action) => (action as { kind: string }).kind === 'openingChatFile')).toBe(false);
  });

  it('uses the ordinary opener when the tab was closed but its native page is still idle', async () => {
    deliver.mockResolvedValueOnce(undefined);
    expect(await openWith({ ref: { chat: CHAT, id: 'item-1' } })).toMatchObject({ ok: true });
    expect(openWithTarget).toHaveBeenCalledTimes(1);
    expect(actions().at(-1)).toMatchObject({ kind: 'openWith' });
    expect((actions().at(-1) as { detail: object }).detail).not.toHaveProperty('background');
  });

  it('revokes only that live file when background validation denies it', async () => {
    deliver.mockResolvedValueOnce({ chat: CHAT });
    vi.mocked(openWithTarget).mockRejectedValueOnce(new AppFileError('not-found', 'No such file'));
    const revoke = vi.spyOn(fileSync, 'revoke').mockResolvedValue();
    expect(await openWith({ ref: { chat: CHAT, id: 'item-1' } })).toMatchObject({ ok: false, code: 'not-found' });
    expect(revoke).toHaveBeenCalledWith(8, 'removed-from-group', expect.any(Function));
    const predicate = revoke.mock.calls[0]![2]!;
    expect(predicate({ itemId: 'item-1' } as never)).toBe(true);
    expect(predicate({ itemId: 'other-file' } as never)).toBe(false);
  });

  it('keeps explicit Open with selection on the ordinary resolution path', async () => {
    expect(await openWith({ ref: { chat: CHAT, id: 'item-1' }, ask: true })).toMatchObject({ ok: true });
    expect(actions().some((action) => (action as { kind: string }).kind === 'openChatFile')).toBe(false);
  });

  it('does not revoke a live document for a transient metadata failure', async () => {
    deliver.mockResolvedValueOnce({ chat: CHAT });
    vi.mocked(openWithTarget).mockRejectedValueOnce(new AppFileError('failed', 'Service unavailable'));
    const revoke = vi.spyOn(fileSync, 'revoke').mockResolvedValue();
    expect(await openWith({ ref: { chat: CHAT, id: 'item-1' } })).toMatchObject({ ok: false, code: 'failed' });
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('files.openWith(file, { peek: true }): beside the page that asked (G1)', () => {
  it('uses the page binding without resolving its parameter’s resource scope', async () => {
    expect(await openWith({ ref: { chat: CHAT, id: 'item-1' } })).toMatchObject({ ok: true });
    expect(resourceChatOf).not.toHaveBeenCalled();
    expect(openWithTarget).toHaveBeenCalledWith(expect.objectContaining({ pageId: PAGE }), expect.objectContaining({ ref: { chat: CHAT, id: 'item-1' } }));
  });

  // The window is told before it is resolved (it places no wait here: this page is in no chat's panel); nothing opens.
  it('still refuses an unreadable file before opening a tab', async () => {
    vi.mocked(openWithTarget).mockRejectedValueOnce(Object.assign(new Error('No such file in a chat you are in'), { code: 'not-found' }));
    expect(await openWith({ ref: { chat: CHAT, id: 'item-1' } })).toMatchObject({ ok: false, code: 'not-found' });
    // Its waiting page was asked for (this open's id), and is taken back by the same id: nothing is opened.
    const [begun, withdrawn] = actions() as { kind: string; openId: string }[];
    expect(begun).toEqual({ kind: 'openingChatFile', openId: expect.any(String), itemId: 'item-1', intent: 'navigate' });
    expect(withdrawn).toEqual({ kind: 'openingChatFile', openId: begun!.openId, withdrawn: true });
    expect(actions()).toHaveLength(2);
    expect(resourceChatOf).not.toHaveBeenCalled();
  });

  it('a chat file nobody here opens: to the page\'s slot, for the host\'s preview — not refused', async () => {
    expect(await openWith({ ref: { id: 'item-1' }, peek: true })).toEqual({ ok: true, value: undefined });
    expect(deliver.mock.calls[0]![0]).toMatchObject({ sessionId: null, tabId: 'dock' });
    expect(actions()).toEqual([
      { kind: 'peek', target: { kind: 'chat', detail: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file, choice: { kind: 'none' }, intent: 'navigate' } } },
    ]);
  });

  it('a chat file an App opens: that App, beside the page', async () => {
    chooser.kind = 'one';
    expect(await openWith({ ref: { id: 'item-1' }, peek: true })).toMatchObject({ ok: true });
    expect(actions()).toEqual([{ kind: 'peek', target: expect.objectContaining({ kind: 'chat', detail: expect.objectContaining({ choice: { kind: 'one', candidate: pdfApp } }) }) }]);
  });

  it("a project's file: its workspace and path, beside the page", async () => {
    expect(await openWith({ ref: { workspace: 'project:p-1', id: 'docs/plan.html' } })).toMatchObject({ ok: true });
    expect(actions()).toEqual([{ kind: 'peek', target: local }]);
  });

  it('without peek: the chat previews the same unclaimed file, without refusing the caller', async () => {
    expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: true });
    expect(actions()).toEqual([{ kind: 'openWith', detail: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file, choice: { kind: 'none' }, intent: 'navigate' } }]);
  });
});

// A page's 「打开」 on its chat's file shows the file's waiting page before main resolves it (`openingChatFile`, an id for
// this open), as a file card's click does — never waited on: the window answers nothing. The answer carries the same id;
// every way that is not a page takes it back by that id. Where the page goes (this chat or another) is the window's to say.
describe('files.openWith on a chat file: the waiting page first', () => {
  const OTHER = '0b000000-0000-4000-8000-0000000000b2';
  beforeEach(async () => {
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'kanban', tabId: 'folder', tabKind: 'kanban.board', conversation: CHAT });
    vi.mocked(openWithTarget).mockClear();
  });
  const begun = () => actions()[0] as { kind: string; openId: string; fileName?: string };
  const opening = (extra: Record<string, unknown> = {}) => ({ kind: 'openingChatFile', openId: begun().openId, itemId: 'item-1', intent: 'navigate', ...extra });
  const withdrawn = () => ({ kind: 'openingChatFile', openId: begun().openId, withdrawn: true });

  it('said before it is resolved, with the name the page gave (its last segment); the answer carries the same open', async () => {
    let resolveTarget!: (value: unknown) => void;
    vi.mocked(openWithTarget).mockImplementationOnce(() => new Promise((resolve) => { resolveTarget = resolve; }) as never);
    const pending = openWith({ ref: { id: 'item-1' }, fileName: 'slides/deck.pdf' });
    // Said while the file is still being resolved: nothing waits for the window.
    await vi.waitFor(() => expect(actions()).toEqual([opening({ fileName: 'deck.pdf' })]));
    resolveTarget({ kind: 'chat', target: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file } });
    expect(await pending).toMatchObject({ ok: true });
    expect(actions()).toEqual([opening({ fileName: 'deck.pdf' }), expect.objectContaining({ kind: 'openWith', detail: expect.objectContaining({ itemId: 'item-1', openId: begun().openId }) })]);
  });

  it('no name given (a bare ref): none said — the window titles it with its own wording', async () => {
    expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: true });
    expect(begun()).not.toHaveProperty('fileName');
  });

  it('refused: the wait is taken back by its id, nothing opens', async () => {
    vi.mocked(openWithTarget).mockRejectedValueOnce(Object.assign(new Error('No such file in a chat you are in'), { code: 'not-found' }));
    expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: false, code: 'not-found' });
    expect(actions()).toEqual([opening(), withdrawn()]);
  });

  it('another chat\'s file: the answer goes with its id — the window takes the wait here back and hands that chat the file', async () => {
    vi.mocked(openWithTarget).mockResolvedValueOnce({ kind: 'chat', target: { chatId: OTHER, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file } } as never);
    expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: true });
    expect(actions()).toEqual([opening(), expect.objectContaining({ kind: 'openWith', detail: expect.objectContaining({ chatId: OTHER, openId: begun().openId }) })]);
  });

  it('a session\'s working-copy file: not a page of this chat — the wait is taken back', async () => {
    vi.mocked(openWithTarget).mockResolvedValueOnce({ kind: 'session', target: { sessionId: 's', projectId: null, deviceId: null, path: 'a.md', ask: false } } as never);
    expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: true });
    expect(actions()).toEqual([opening(), expect.objectContaining({ kind: 'openSessionFile' }), withdrawn()]);
  });

  it('handing the answer over fails: the wait is taken back', async () => {
    deliver.mockImplementation(async (_origin, action) => { if ((action as { kind: string }).kind === 'openWith') throw new Error('the window is gone'); });
    try {
      expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: false });
      expect(actions().at(-1)).toEqual(withdrawn());
    } finally { deliver.mockImplementation(() => Promise.resolve()); }
  });

  it.each([
    ['asked which App (ask)', { ref: { id: 'item-1' }, ask: true }],
    ['beside the page (peek)', { ref: { id: 'item-1' }, peek: true }],
    ['the page\'s own named tab', { ref: { id: 'item-1' }, tab: 'board' }],
    ['a working copy\'s file', { ref: { workspace: 'project:p-1', name: 'docs/plan.html' } }],
  ])('%s: no waiting page, and its answer carries no open', async (_name, args) => {
    await openWith(args);
    expect(actions().some((action) => (action as { kind: string }).kind === 'openingChatFile')).toBe(false);
    expect(actions().some((action) => !!(action as { detail?: { openId?: string } }).detail?.openId)).toBe(false);
  });

  it('a page worked by an agent, not the person: no waiting page', async () => {
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'kanban', tabId: 'folder', tabKind: 'kanban.board', conversation: CHAT, operator: { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000009' } });
    await openWith({ ref: { id: 'item-1' } });
    expect(actions().some((action) => (action as { kind: string }).kind === 'openingChatFile')).toBe(false);
  });

  it('a page in no chat, naming none: no waiting page', async () => {
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'kanban', tabId: 'dock', tabKind: 'kanban.board' });
    await openWith({ ref: { id: 'item-1' } });
    expect(actions().some((action) => (action as { kind: string }).kind === 'openingChatFile')).toBe(false);
  });
});
