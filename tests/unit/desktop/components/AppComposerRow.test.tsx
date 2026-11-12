// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Real window (verify-pass1 11-b vs verify-env b-assistant-with-app): above the built-in assistant's composer sat
 * 「自定义咕咕 ›」 with its × on the left and 「灵感」 on the right; beside the App both were gone. The row above the composer
 * of the own assistant chat beside its App has them again: the host's hint, read from the very record the built-in page
 * kept on this computer (so a hint dismissed there stays gone), its opening told to the App's page as `customize`; and the
 * App's `chip` entry as the capsule, hidden where the person hid the built-in's 「灵感」 and while a voice note records.
 * Control (the parent commit): the column had no row above its composer at all.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const ASSISTANT = 'assistant-1';
const state = vi.hoisted(() => ({ recording: false, opened: [] as unknown[] }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@/components/assistant/useVoiceNoteHandler', () => ({ useVoiceNoteHandler: () => ({ handler: null, recording: state.recording }) }));
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpc: { extensions: { conversationCustomizeOpened: async (args: unknown) => { state.opened.push(args); return { success: true, data: { told: true } }; } } },
}));

const { AppComposerRow } = await import('../../../../apps/desktop/src/components/appSlot/AppComposerRow');
const { composerChip } = await import('../../../../apps/desktop/src/components/appSlot/appComposerActions');

let root: Root;
let element: HTMLDivElement;
const ran: string[] = [];
const VIEWS = [
  { id: 'ideas', label: { zh: '获取灵感', en: 'Get ideas' }, icon: 'sparkles' as const, kind: 'page-intent' as const, chip: { zh: '灵感', en: 'Ideas' } },
  { id: 'voice-note', label: { zh: '录制语音笔记', en: 'Record a voice note' }, icon: 'mic' as const, kind: 'voice-note' as const },
];
const chip = composerChip(VIEWS, { zh: true, run: (id) => ran.push(id) });
const render = (withChip = true) => act(async () => root.render(
  <AppComposerRow ownerId={OWNER} extensionId="gugu-assistant" assistant={{ id: ASSISTANT, name: '咕咕' }} chip={withChip ? chip : null} />,
));
const find = (testId: string) => element.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
// The records the built-in page kept on this computer (lib/assistantSetupState.ts, lib/assistantIdeas.ts).
const OFFER = `gugu.assistant.offerCustomize:${OWNER}`;
const IDEAS_HIDDEN = `gugu.assistant.ideasEntry:${ASSISTANT}`;

beforeEach(() => {
  localStorage.clear();
  Object.assign(state, { recording: false, opened: [] });
  ran.length = 0;
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

describe('the row above the own assistant chat\'s composer beside its App', () => {
  it('the App\'s chip entry is the capsule: its shorter label, its icon, the entry run on a click', async () => {
    expect(chip).toMatchObject({ id: 'app-ideas', label: '灵感' });
    expect(composerChip(VIEWS, { zh: false, run: () => undefined })?.label).toBe('Ideas');
    expect(composerChip([VIEWS[1]!], { zh: true, run: () => undefined })).toBeNull();
    await render();
    const capsule = find('assistant-ideas-entry')!;
    expect(capsule.className).toBe('ta-ideas-pill');
    expect(capsule.textContent).toBe('灵感');
    expect(capsule.querySelector('svg')).not.toBeNull();
    await act(async () => capsule.click());
    expect(ran).toEqual(['ideas']);
    // Where it sits: the built-in row, capsule at its end.
    expect(find('app-composer-entries')!.className).toBe('ta-composer-entries');
  });

  it('the capsule stays hidden where the person hid the built-in 「灵感」 here, and gives way while a voice note records', async () => {
    localStorage.setItem(IDEAS_HIDDEN, 'hidden');
    await render();
    expect(find('assistant-ideas-entry')).toBeNull();
    expect(find('app-composer-entries')).toBeNull();
    localStorage.removeItem(IDEAS_HIDDEN);
    state.recording = true;
    await render();
    expect(find('assistant-ideas-entry')).toBeNull();
  });

  it('the 自定义 hint, offered after setup: opened, it is retired and the App\'s page is told; dismissed, it is retired', async () => {
    localStorage.setItem(OFFER, '1');
    await render(false);
    const open = find('assistant-customize-card-open')!;
    expect(open.textContent).toContain('自定义咕咕');
    await act(async () => open.click());
    await settle();
    expect(state.opened).toEqual([{ ownerId: OWNER, extensionId: 'gugu-assistant' }]);
    expect(localStorage.getItem(OFFER)).toBeNull();
    expect(find('assistant-customize-card')).toBeNull();

    localStorage.setItem(OFFER, '1');
    await render();
    // Hint left, capsule right, in one row.
    expect([...find('app-composer-entries')!.children].map((child) => child.className)).toEqual(['ta-customize-card', 'ta-ideas-pill']);
    await act(async () => find('assistant-customize-card-dismiss')!.click());
    expect(localStorage.getItem(OFFER)).toBeNull();
    expect(find('assistant-customize-card')).toBeNull();
    expect(state.opened).toHaveLength(1);
  });

  it('a hint already opened or dismissed on the built-in page (its record gone) is not offered again', async () => {
    await render();
    expect(find('assistant-customize-card')).toBeNull();
    expect(find('assistant-ideas-entry')).not.toBeNull();
  });
});
