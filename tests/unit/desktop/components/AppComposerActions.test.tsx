// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1927 (API 48) The composer 「+」 of an App's column beside the person's own assistant chat: the shell draws what main says
 * (the App's words in the person's language, the host's icon, the voice note greyed while one records) and, on a click,
 * hands main only the App, the column's authority and the entry's id. Main runs it; a draft comes back for this composer and
 * goes after what the person wrote. A refusal does nothing; nothing read for another account or column is drawn.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const state = vi.hoisted(() => ({
  language: 'zh-CN',
  recording: false,
  drafts: [] as [string, unknown][],
  notes: new Set<(note: { extensionId?: string }) => void>(),
}));
const list = vi.hoisted(() => vi.fn());
const run = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ i18n: { get language() { return state.language; } } }) }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/store/chatContext', () => ({ useChatStore: () => ({ writeDraft: (chatId: string, draft: unknown) => state.drafts.push([chatId, draft]) }) }));
vi.mock('@/components/assistant/useVoiceNoteHandler', () => ({ useVoiceNoteHandler: () => ({ handler: null, recording: state.recording }) }));
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpc: { extensions: { conversationComposerActions: list, runConversationComposerAction: run } },
  events: { on: (_channel: unknown, listener: (note: { extensionId?: string }) => void) => {
    state.notes.add(listener);
    return () => { state.notes.delete(listener); };
  } },
}));

const { useAppComposerActions } = await import('../../../../apps/desktop/src/components/appSlot/appComposerActions');
type Menu = ReturnType<typeof useAppComposerActions>;

const VIEWS = [
  { id: 'ideas', label: { zh: '获取灵感', en: 'Get ideas' }, icon: 'sparkles', kind: 'page-intent' },
  { id: 'voice-note', label: { zh: '录制语音笔记', en: 'Record a voice note' }, icon: 'mic', kind: 'voice-note' },
  { id: 'ask', label: { zh: '问问它', en: 'Ask it' }, icon: 'message', kind: 'draft' },
];
let root: Root;
let menu: Menu;
const column = { ownerId: 'owner-a', extensionId: 'assistant', authority: 'stamp-1', chatId: CHAT };
function Probe(props: typeof column) {
  menu = useAppComposerActions(props);
  return null;
}
const render = (props = column) => act(async () => root.render(<Probe {...props} />));
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (id: string) => {
  menu!.find((entry) => entry.id === `app-${id}`)!.onSelect();
  await settle();
};

beforeEach(() => {
  Object.assign(state, { language: 'zh-CN', recording: false, drafts: [] });
  state.notes.clear();
  list.mockReset().mockResolvedValue({ success: true, data: { actions: VIEWS } });
  run.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(async () => root.unmount()));

describe('the 「+」 entries of an App beside the person\'s own assistant chat', () => {
  it('what main says, in the person\'s language with the host\'s icons; the voice note greyed while one records', async () => {
    await render();
    await settle();
    expect(list).toHaveBeenCalledWith({ ownerId: 'owner-a', extensionId: 'assistant', authority: 'stamp-1' });
    expect(menu!.map((entry) => [entry.id, entry.label, entry.disabled])).toEqual([
      ['app-ideas', '获取灵感', false], ['app-voice-note', '录制语音笔记', false], ['app-ask', '问问它', false]]);
    expect(menu!.every((entry) => entry.icon)).toBe(true);
    state.language = 'en-US'; state.recording = true;
    await render();
    expect(menu!.map((entry) => [entry.label, entry.disabled])).toEqual([['Get ideas', false], ['Record a voice note', true], ['Ask it', false]]);
  });

  it('a click hands main only the App, the column and the id; a draft comes back for this composer, after what is there', async () => {
    await render();
    await settle();
    run.mockResolvedValueOnce({ success: true, data: { kind: 'draft', text: { zh: '帮我看看今天的安排。', en: 'Look at my day with me.' } } });
    await click('ask');
    expect(run).toHaveBeenCalledExactlyOnceWith({ ownerId: 'owner-a', extensionId: 'assistant', authority: 'stamp-1', actionId: 'ask' });
    expect(state.drafts).toEqual([[CHAT, { at: 'end', text: '帮我看看今天的安排。' }]]);
    run.mockResolvedValueOnce({ success: true, data: { kind: 'page-intent', delivered: true } });
    await click('ideas');
    run.mockResolvedValueOnce({ success: true, data: { kind: 'voice-note', outcome: 'started' } });
    await click('voice-note');
    expect(run.mock.calls.map(([args]) => args.actionId)).toEqual(['ask', 'ideas', 'voice-note']);
    expect(state.drafts).toHaveLength(1);
    // In the person's language when it lands.
    state.language = 'en-US';
    run.mockResolvedValueOnce({ success: true, data: { kind: 'draft', text: { zh: '帮我看看今天的安排。', en: 'Look at my day with me.' } } });
    await click('ask');
    expect(state.drafts.at(-1)).toEqual([CHAT, { at: 'end', text: 'Look at my day with me.' }]);
  });

  it('refused (the App switched off meanwhile, another account) or failed: nothing happens', async () => {
    await render();
    await settle();
    run.mockResolvedValueOnce({ success: false, error: 'This App is not on', code: 'denied' });
    await click('ask');
    run.mockRejectedValueOnce(new Error('ipc closed'));
    await click('ask');
    expect(state.drafts).toEqual([]);
  });

  it('none when main says none or cannot say; nothing read for another account or column is drawn; read again when the App changes', async () => {
    list.mockResolvedValueOnce({ success: true, data: { actions: [] } });
    await render();
    await settle();
    expect(menu).toBeUndefined();
    list.mockResolvedValueOnce({ success: false, error: 'Account changed' });
    await act(async () => { for (const note of state.notes) note({ extensionId: 'assistant' }); });
    await settle();
    expect(menu).toBeUndefined();
    await act(async () => { for (const note of state.notes) note({ extensionId: 'assistant' }); });
    await settle();
    expect(menu?.map((entry) => entry.id)).toEqual(['app-ideas', 'app-voice-note', 'app-ask']);
    // Another App changing: not read again.
    const asked = list.mock.calls.length;
    await act(async () => { for (const note of state.notes) note({ extensionId: 'other' }); });
    expect(list.mock.calls.length).toBe(asked);
    // A new authority (another account, or this App's choice changed): what was read before is not drawn while it is read.
    let answer!: (value: unknown) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await render({ ...column, authority: 'stamp-2' });
    expect(menu).toBeUndefined();
    await act(async () => answer({ success: true, data: { actions: VIEWS.slice(0, 1) } }));
    expect(menu?.map((entry) => entry.id)).toEqual(['app-ideas']);
  });
});
