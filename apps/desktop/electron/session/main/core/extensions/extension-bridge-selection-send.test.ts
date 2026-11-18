import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileCiteDraft } from '@gugu/session-shared/markdown';
import { groupFileLink } from '@gugu/core/shared/ui/guguLink';
import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';

/**
 * API 54 `gugu.files.sendSelection` through the real bridge: only the preinstalled Files App, on a real click, citing its
 * own session's working copy at a place on its page, opens the host's Send box; anything else opens nothing. What the
 * App learns back is one of two words, whatever the host's box answered.
 * API 55: on a page of a chat's folder, the box sends into that chat — the binding's, never one the call names — and only
 * files of that folder, named as the folder names them, read as the person (the database here is a fake; the checks are real).
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
  state.invoke = vi.fn(async (): Promise<unknown> => 'sent');
  return { ...(await original<object>()), invokeInEmbedder: (...args: unknown[]) => state.invoke(...args) };
});
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { bindExtensionSurface, unbindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();

const mine = { workspace: 'session:bound-task', id: 'docs/proof.md' };
const good = { text: '> 设 a 为偶数 则 a² 为偶数', refs: [{ file: mine, label: 'Lines 3–4' }], rect: { x: 10, y: 20, width: 100, height: 18 }, viewport: { width: 800, height: 600 } };
const call = (args: Record<string, unknown>, gesture = true) => handlers.get(EXTENSION_BRIDGE_CHANNEL)!(
  { sender: { id: 7, session: {} } }, { method: 'filesSendSelection', args, gesture });

beforeEach(async () => {
  state.origin = 'preinstalled';
  state.invoke.mockClear(); state.invoke.mockResolvedValue('sent');
  unbindExtensionSurface(7);
  setExtensionBridgeHost({ deliver: vi.fn(), selfGuguNumber: () => undefined, presentation: () => ({ locale: 'zh-CN', themeMode: 'light', fullscreen: false, windowFocused: true }) });
  await bindExtensionSurface({ webContentsId: 7, extensionId: 'workspace', tabId: 'files-tab', tabKind: 'workspace.files', workspace: sessionWorkspace('bound-task') });
});

it('opens nothing without a real click, for another App, for a file outside this working copy, or at no place on the page', async () => {
  expect(await call(good, false)).toMatchObject({ ok: false, code: 'denied' });
  state.origin = 'market';
  expect(await call(good)).toMatchObject({ ok: false, code: 'denied' });
  state.origin = 'preinstalled';
  expect(await call({ ...good, refs: [{ file: { workspace: 'session:other-task', id: 'docs/proof.md' } }] })).toMatchObject({ ok: false, code: 'denied' });
  expect(await call({ ...good, refs: [{ file: { chat: 'chat-1', name: 'proof.md' } }] })).toMatchObject({ ok: false });
  expect(await call({ ...good, refs: [] })).toMatchObject({ ok: false, code: 'invalid' });
  for (const rect of [{ ...good.rect, x: Number.NaN }, { ...good.rect, width: Number.POSITIVE_INFINITY }, { ...good.rect, x: 900 }, { ...good.rect, y: -200 }, undefined]) {
    expect(await call({ ...good, rect })).toMatchObject({ ok: false, code: 'invalid' });
  }
  expect(await call({ ...good, viewport: { width: 0, height: 600 } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(state.invoke).not.toHaveBeenCalled();
});

it('hands the host the cite as fileCiteDraft writes it, and the App only sent or cancelled', async () => {
  expect(await call(good)).toEqual({ ok: true, value: 'sent' });
  expect(state.invoke).toHaveBeenCalledExactlyOnceWith(42, 'extensions.selectionSend',
    { to: { session: 'bound-task' }, webContentsId: 7, open: expect.objectContaining({ draft: fileCiteDraft(good.text, good.refs) }) });
  // Whatever the host's box answers, nothing of it beyond the outcome reaches the page: no words, member or message id.
  for (const answer of ['cancelled', { body: 'words', members: ['user:x'], messageId: 'm-1' }, undefined, 'sent!']) {
    state.invoke.mockResolvedValueOnce(answer);
    expect(await call(good)).toEqual({ ok: true, value: 'cancelled' });
  }
});

describe('API 55 on a page of a chat\'s folder', () => {
  const entry = { chat: GROUP, id: ITEM, version: 7, name: 'payroll.xlsx' };
  const said = { text: '> 设 a 为偶数', refs: [{ file: entry, at: { lines: '3-4' }, label: '第 3–4 行' }], rect: good.rect, viewport: good.viewport };
  const bindChat = (chat: string) => bindExtensionSurface({ webContentsId: 7, extensionId: 'workspace', tabId: 'files-tab', tabKind: 'workspace.files', conversation: chat, resourceChat: chat });
  beforeEach(async () => { unbindExtensionSurface(7); await bindChat(GROUP); });

  it('sends into the page\'s chat what the box shows, word for word: the folder\'s name for the file, never the App\'s', async () => {
    expect(await call({ ...said, chat: OTHER_GROUP })).toEqual({ ok: true, value: 'sent' });
    const pill = `proof.md (第 3–4 行)`;
    const draft = `> 设 a 为偶数\n\n@[${pill}](${groupFileLink(ITEM, { version: 7, at: { lines: '3-4' } })})`;
    expect(state.invoke).toHaveBeenCalledExactlyOnceWith(42, 'extensions.selectionSend',
      { to: { chat: GROUP }, webContentsId: 7, open: { draft, quote: said.text, pills: [pill], rect: said.rect, viewport: said.viewport } });
    expect(JSON.stringify(state.invoke.mock.calls)).not.toContain('payroll');
  });

  it('opens nothing for a file of another chat, a ref naming another chat, a folder, a working-copy file, or a chat the person left', async () => {
    expect(await call({ ...said, refs: [{ file: { chat: OTHER_GROUP, id: ITEM } }] })).toMatchObject({ ok: false, code: 'denied' });
    expect(await call({ ...said, refs: [{ file: { id: ITEM_ELSEWHERE } }] })).toMatchObject({ ok: false, code: 'denied' });
    expect(await call({ ...said, refs: [{ file: { chat: GROUP, id: FOLDER } }] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call({ ...said, refs: [{ file: mine }] })).toMatchObject({ ok: false, code: 'invalid' });
    unbindExtensionSurface(7);
    await bindChat(OTHER_GROUP);
    expect(await call({ ...said, refs: [{ file: { id: ITEM_ELSEWHERE } }] })).toMatchObject({ ok: false, code: 'denied' });
    expect(state.invoke).not.toHaveBeenCalled();
  });
});
