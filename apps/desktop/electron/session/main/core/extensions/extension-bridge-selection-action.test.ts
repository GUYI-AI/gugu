import { beforeEach, describe, expect, it, vi } from 'vitest';
import { groupFileLink } from '@gugu/core/shared/ui/guguLink';
import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';

/**
 * API 60 through the real bridge: an opened file carries its selection menu (the page's conversation, and whether the file
 * can be named for it); Cite or Send pressed on it (`filesSelectionAction`, in the person's gesture) reaches the window as
 * the conversation, the file named where it lives (a chat folder's by its link, read as the person; a computer's by its
 * path there) and the pick. The database here is a fake; the checks are real. Nothing comes back to the page.
 */

const GROUP = '44444444-4444-4444-8444-444444444444';
const OTHER_GROUP = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';
const ITEM_ELSEWHERE = '99999999-9999-4999-8999-999999999999';
const FOLDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const items = new Map([
  [ITEM, { id: ITEM, chat_id: GROUP, filename: 'proof.md', version: 7 }],
  [FOLDER, { id: FOLDER, chat_id: GROUP, kind: 'folder', filename: '合同', version: 1 }],
  [ITEM_ELSEWHERE, { id: ITEM_ELSEWHERE, chat_id: OTHER_GROUP, filename: 'other.md', version: 1 }],
]);
function query(table: string) {
  const filters = new Map<string, unknown>();
  const q = {
    select: () => q,
    eq: (key: string, value: unknown) => (filters.set(key, value), q),
    in: async (_key: string, ids: string[]) => ({ data: ids.flatMap((id) => (items.has(id) ? [items.get(id)] : [])), error: null }),
    // The person is in GROUP only.
    maybeSingle: async () => ({ data: table === 'chats' && filters.get('id') === GROUP ? { id: GROUP } : null, error: null }),
  };
  return q;
}
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ from: query }) }));
vi.mock('@main/core/extensions/extension-send', async () => {
  const { chatSelectionPills } = await import('@shared/extensions/app-send-core');
  return { chatSelectionPillsForApp: (chatId: string, refs: unknown) => chatSelectionPills({ account: async () => ({ token: 'person', userId: 'person' }) }, chatId, refs) };
});
// This computer's folders: the task's working copy, and the group's folder (`folder:`) the owner's local file is in.
const ROOTS: Record<string, string> = { 'session:bound-task': '/home/me/task', 'folder:dev-1/ws-1': '/home/me/work' };
vi.mock('./app-files', async (original) => ({
  ...await original<object>(),
  openAppFile: async (_page: unknown, args: { ref: Record<string, unknown> }) => ({ entry: { ...args.ref, name: 'a.md' }, docName: 'doc', access: 'rw', self: { userId: 'me', name: 'Me' } }),
  localRootOf: async ({ workspace }: { workspace: string }) => {
    if (!ROOTS[workspace]) throw Object.assign(new Error('not here'), { code: 'not-found' });
    return { workspaceRoot: ROOTS[workspace], projectId: 'p-1', workspaceId: null };
  },
}));

const state = vi.hoisted(() => ({ origin: 'preinstalled' as string | undefined, invoke: null as unknown as import('vitest').Mock }));
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(name, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: vi.fn(), on: vi.fn(), send: vi.fn() }) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({
  grantedCapabilities: () => [],
  hasCapability: () => false,
  isEnabled: () => true,
  origins: () => ({ workspace: state.origin }),
  get: () => ({ manifest: { name: 'Files' } }),
}) }));
vi.mock('@main/core/extensions/extension-bridge-relay', async (original) => {
  state.invoke = vi.fn(async (): Promise<unknown> => undefined);
  return { ...(await original<object>()), invokeInEmbedder: (...args: unknown[]) => state.invoke(...args) };
});
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { bindExtensionSurface, unbindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();

const place = { rect: { x: 10, y: 20, width: 100, height: 18 }, viewport: { width: 800, height: 600 } };
const raw = (method: string, args: unknown, gesture: boolean) => handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: { id: 7, session: {} } }, { method, args, gesture });
const press = (args: Record<string, unknown>, gesture = true) => raw('filesSelectionAction', { action: 'cite', places: [{ at: { lines: '3-4' } }], text: 'words', ...place, ...args }, gesture);
const bind = (more: Record<string, unknown>) => bindExtensionSurface({ webContentsId: 7, extensionId: 'workspace', tabId: 'files-tab', tabKind: 'workspace.files', ...more });
const asked = () => state.invoke.mock.calls.at(-1)?.[2] as Record<string, unknown>;
const menuOf = async (ref: Record<string, unknown>) => ((await raw('filesOpen', { ref }, false)) as { value: { selectionMenu: { id: string }[] } }).value.selectionMenu.map(item => item.id);

beforeEach(async () => {
  state.origin = 'market';
  state.invoke.mockClear();
  unbindExtensionSurface(7);
  setExtensionBridgeHost({ deliver: vi.fn(), selfGuguNumber: () => undefined, presentation: () => ({ locale: 'zh-CN', themeMode: 'light', fullscreen: false, windowFocused: true }) });
});

describe('an opened file\'s menu on this page', () => {
  it('Cite and Send where the page has a conversation and the file can be named; Copy alone otherwise', async () => {
    await bind({ workspace: sessionWorkspace('bound-task') });
    expect(await menuOf({ workspace: 'session:bound-task', id: 'docs/proof.md' })).toEqual(['copy', 'cite', 'send']);
    unbindExtensionSurface(7);
    await bind({ workspace: 'project:p-1', filePath: 'a.md' });
    expect(await menuOf({ workspace: 'project:p-1', id: 'a.md' })).toEqual(['copy']);
  });
});

describe('a press on Cite or Send', () => {
  it('a task page: its session, the file by its path on this computer, the pick as pressed', async () => {
    await bind({ workspace: sessionWorkspace('bound-task') });
    expect(await press({ file: { workspace: 'session:bound-task', id: 'docs/proof.md' }, text: 'a² 为偶数' })).toEqual({ ok: true, value: undefined });
    expect(state.invoke).toHaveBeenCalledExactlyOnceWith(42, 'extensions.fileSelection', {
      webContentsId: 7, action: 'cite', conversation: { kind: 'session', sessionId: 'bound-task' },
      file: { name: 'proof.md', target: '/home/me/task/docs/proof.md' }, pick: { places: [{ at: { lines: '3-4' } }], text: 'a² 为偶数' }, ...place,
    });
  });

  it('a group\'s folder page (the owner\'s local AGENTS.md): Send goes to the group, the file by its path; the window opens the person\'s own box', async () => {
    // Opened on the file, as the device path in its bar shows: the folder is the page's workspace for it.
    await bind({ workspace: 'folder:dev-1/ws-1', filePath: 'AGENTS.md', conversation: GROUP, resourceChat: GROUP });
    await press({ action: 'send', file: { workspace: 'folder:dev-1/ws-1', id: 'AGENTS.md' } });
    expect(asked()).toMatchObject({ action: 'send', conversation: { kind: 'chat', chatId: GROUP }, file: { name: 'AGENTS.md', target: '/home/me/work/AGENTS.md' } });
  });

  it('a chat folder\'s file: the chat, the file by its link, as the folder names it', async () => {
    await bind({ conversation: GROUP, resourceChat: GROUP });
    await press({ file: { chat: GROUP, id: ITEM, version: 7, name: 'payroll.xlsx' } });
    expect(asked()).toMatchObject({ conversation: { kind: 'chat', chatId: GROUP }, file: { name: 'proof.md', target: groupFileLink(ITEM, { version: 7 }) } });
    expect(JSON.stringify(state.invoke.mock.calls)).not.toContain('payroll');
  });

  it('a pick on the version the page shows points at that version, though a newer one came in since; no version, the file as it is now', async () => {
    await bind({ conversation: GROUP, resourceChat: GROUP });
    // The page opened v1 and still draws it; the file is at v7 now.
    await press({ file: { chat: GROUP, id: ITEM, version: 1 } });
    expect(asked()).toMatchObject({ file: { target: groupFileLink(ITEM, { version: 1 }) } });
    await press({ file: { chat: GROUP, id: ITEM } });
    expect(asked()).toMatchObject({ file: { target: groupFileLink(ITEM, { version: 7 }) } });
  });
});

it('refuses a press without the person\'s gesture, a malformed one, a file of a chat they are not in or of another place, a page with no conversation, and a page an agent works', async () => {
  await bind({ conversation: GROUP, resourceChat: GROUP });
  expect(await press({ file: { chat: GROUP, id: ITEM } }, false)).toMatchObject({ ok: false });
  expect(await press({ action: 'copy', file: { chat: GROUP, id: ITEM } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(await press({ file: { chat: GROUP, id: ITEM }, rect: { ...place.rect, x: Number.NaN } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(await press({ file: { id: ITEM_ELSEWHERE } })).toMatchObject({ ok: false, code: 'denied' });
  unbindExtensionSurface(7);
  await bind({ workspace: sessionWorkspace('bound-task') });
  expect(await press({ file: { workspace: 'folder:dev-1/ws-1', id: 'AGENTS.md' } })).toMatchObject({ ok: false, code: 'denied' });
  unbindExtensionSurface(7);
  await bind({ workspace: 'project:p-1', filePath: 'a.md' });
  expect(await press({ file: { workspace: 'project:p-1', id: 'a.md' } })).toMatchObject({ ok: false, code: 'denied' });
  unbindExtensionSurface(7);
  await bind({ workspace: sessionWorkspace('bound-task'), operator: { kind: 'agent', id: 'user:agent-1' } });
  expect(await press({ file: { workspace: 'session:bound-task', id: 'a.md' } })).toMatchObject({ ok: false, code: 'denied' });
  expect(state.invoke).not.toHaveBeenCalled();
});
