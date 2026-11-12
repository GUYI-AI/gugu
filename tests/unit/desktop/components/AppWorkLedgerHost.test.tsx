// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1925 (API 46) The shell's half of the assistant's 任务 list moved into an App. It reads the account ledger the built-in
 * list's way — the same store, the same agent presence, wherever the assistant lives — only while an enabled App declares
 * `work`, and hands main exactly what each row draws (plus the two ids main keeps). A task main let an App open is drawn with
 * the built-in task window in the cell the App's panel leaves (AppHostLayerHost), for the account it was opened for; another
 * account, leaving the session page, the App switched off or removed, or main naming its grant or choice as changed take it
 * away at once. The same layer draws the assistant's settings page (44 `gugu.assistant.open`, 46 the gear of the host's
 * row): one page at a time.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const DEVICE_HERE = '55000000-0000-4000-8000-000000000005';
const DEVICE_THERE = '56000000-0000-4000-8000-000000000006';
const COORDINATOR = 'coordinator-session-1';
const AGENT_A = '77000000-0000-4000-8000-000000000007';
const AGENT_B = '78000000-0000-4000-8000-000000000008';
const WORK_A = 'a1000000-0000-4000-8000-0000000000a1';
const WORK_B = 'b2000000-0000-4000-8000-0000000000b2';
const APP = 'assistant-tasks';

const reading = (id: string) => ({ id, version: '1.0.0', permissions: { bindings: [{ name: 'main', kind: 'conversation', actions: ['unread', 'surface', 'work'] }] }, contributes: {} });
const plain = (id: string) => ({ id, version: '1.0.0', permissions: {}, contributes: {} });
const state = vi.hoisted(() => ({
  owner: '' as string,
  inventory: [] as object[],
  disabled: [] as string[],
  inventoryNotes: new Set<(note: { extensionId?: string }) => void>(),
  windows: [] as Record<string, unknown>[],
  // The account and the inventory are observed in the app (auth context, mobx); here each render tells the host to look again.
  tick: 0,
  ticks: new Set<() => void>(),
}));
const pushed = vi.hoisted(() => vi.fn(async (_ledger: unknown) => ({ success: true as const })));
const reported = vi.hoisted(() => vi.fn(async (_report: unknown) => ({ success: true as const })));
vi.mock('@/store/auth', () => ({ useAuth: () => {
  useSyncExternalStore((listener) => { state.ticks.add(listener); return () => { state.ticks.delete(listener); }; }, () => state.tick);
  return { user: state.owner ? { id: state.owner } : null };
} }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/session/renderer/lib/ipc', () => ({
  rpc: { extensions: { workLedgerChanged: pushed, reportHostLayer: reported } },
  events: { on: (_channel: unknown, listener: (note: { extensionId?: string }) => void) => {
    state.inventoryNotes.add(listener);
    return () => { state.inventoryNotes.delete(listener); };
  } },
}));
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {
  get manifests() { return state.inventory; },
  isEnabled: (id: string) => !state.disabled.includes(id),
} }));
// The built-in task window, as far as this test needs it: which task, for whom, and its back control.
vi.mock('@/components/assistant/AssistantWorkTaskWindow', () => ({ AssistantWorkTaskWindow: (props: { ownerId: string; request: Record<string, unknown>; onClose?: () => void; appPanel?: boolean }) => {
  state.windows.push({ ...props, signedIn: state.owner } as never);
  return <section data-testid="task-window" data-owner={props.ownerId} data-work={String(props.request.workId)}><button type="button" data-testid="back" onClick={props.onClose}>back</button></section>;
} }));
// The built-in settings page: that it is the one drawn, as the built-in panel draws it.
vi.mock('@/components/assistant/AssistantSettingsPage', () => ({ AssistantSettingsPage: (props: { panelNavigation?: boolean }) => {
  state.windows.push({ settings: true, ...props, signedIn: state.owner } as never);
  return <section data-testid="settings-page" data-panel-navigation={String(props.panelNavigation)} />;
} }));

const { AppWorkLedgerHost } = await import('../../../../apps/desktop/src/components/appSlot/AppWorkLedgerHost');
const { AppHostLayerHost } = await import('../../../../apps/desktop/src/components/appSlot/AppHostLayerHost');
const { forgetPushedWorkForTest, pushedRowsOf } = await import('../../../../apps/desktop/src/components/appSlot/appWorkLedger');
const { forgetReportedHostLayersForTest } = await import('../../../../apps/desktop/src/components/appSlot/appHostLayer');
const { readShellSlots } = await import('../../../../apps/desktop/src/lib/shellSlots');
const { appHostLayerSlotKey, readAppHostLayerBridge, resetAppHostLayersForTest } = await import('../../../../apps/desktop/src/lib/appHostLayerBridge');
const { installAssistantShellBridge, publishAssistantShell } = await import('../../../../apps/desktop/src/lib/assistantShellBridge');
const { installIdentityDirectoryBridge, publishIdentityDirectory } = await import('../../../../apps/desktop/src/lib/identityDirectoryBridge');
const { assistantPanelTaskChat } = await import('../../../../apps/desktop/src/components/assistant/assistant-panel-tasks');
installAssistantShellBridge();
installIdentityDirectoryBridge();

/** The account's ledger as the cloud answers it (core `assistantWork` rows). */
const work = (over: Record<string, unknown> = {}) => ({
  owner_user_id: OWNER, assistant_user_id: 'x', work_id: WORK_A, created_seq: '1', title: 'Compare three flights',
  coordinator_session_id: COORDINATOR, coordinator_device_id: DEVICE_HERE,
  executors: [{ session_id: 'exec-a', device_id: DEVICE_THERE, agent_user_id: AGENT_A }],
  source_link: 'gugu://chat/33000000-0000-4000-8000-000000000003/message/1', outcome: 'active', executor_outcomes: {},
  terminal_version: '0', created_at: '2026-11-11T07:00:00.000Z', updated_at: '2026-11-11T08:00:00.000Z', ...over,
});
const ledger = vi.hoisted(() => ({ list: vi.fn(async (_assistant: string): Promise<unknown[]> => []), presence: {} as Record<string, unknown>, refresh: [] as (() => void)[] }));
let assistantSerial = 0;
let assistantId = '';
const home = { kind: 'computer', deviceId: DEVICE_HERE, thisDevice: true, label: null, online: true, known: true } as const;
function showAssistant(owner = OWNER, place: unknown = home, id = assistantId) {
  publishAssistantShell({ cloudAvailable: true, canHostHere: true, cloud: null, loadError: null, ownerName: 'Me', ownerId: owner, chatId: 'chat-x',
    assistant: { id, display_name: 'Dot', avatar: null, created_at: null }, assistantState: 'found', home: place as never, setup: null, member: true, preparing: false, deviceCount: 1 });
}
let root: Root;
let host: HTMLDivElement;
let cell: HTMLDivElement;
const render = async (visible = true) => act(async () => {
  state.tick += 1;
  for (const listener of state.ticks) listener();
  root.render(<><AppWorkLedgerHost /><AppHostLayerHost visible={visible} /></>);
});
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
const lastPushed = () => pushed.mock.calls.at(-1)?.[0] as { ownerId: string | null; assistantId: string | null; state: string; rows: Record<string, unknown>[] } | undefined;
const chats = () => readAppHostLayerBridge()!.getSnapshot();
const openTask = (target: { ownerId?: string; workId?: string; sessionId?: string } = {}) =>
  act(async () => readAppHostLayerBridge()!.open(APP, { kind: 'work', ownerId: OWNER, workId: WORK_A, sessionId: 'exec-a', ...target }));
const note = (extensionId?: string) => act(async () => { for (const listener of state.inventoryNotes) listener({ extensionId }); });

beforeEach(async () => {
  resetAppHostLayersForTest();
  forgetPushedWorkForTest();
  forgetReportedHostLayersForTest();
  assistantId = `44000000-0000-4000-8000-${String(++assistantSerial).padStart(12, '0')}`;
  Object.assign(state, { owner: OWNER, inventory: [reading(APP), plain('notes')], disabled: [], windows: [] });
  pushed.mockClear();
  reported.mockClear();
  ledger.list.mockReset();
  ledger.list.mockImplementation(async () => [
    work({ assistant_user_id: assistantId }),
    work({ assistant_user_id: assistantId, work_id: WORK_B, title: 'Draft the weekly note', outcome: 'completed', updated_at: '2026-11-10T09:00:00.000Z',
      executors: [{ session_id: 'exec-b', device_id: DEVICE_HERE, agent_user_id: AGENT_B }] }),
  ]);
  ledger.presence = { [AGENT_A]: { reading: { status: 'working', detail: 'running', running: true, background: null }, payload: { agentType: 'codex' }, local: { unseen: false } } };
  (window as unknown as Record<string, unknown>).__GUGU_ASSISTANT_PANEL__ = {
    accountId: () => state.owner || null,
    subscribeAccount: () => () => undefined,
    work: {
      client: { listAll: (assistant: string) => ledger.list(assistant), get: vi.fn(), historyAll: vi.fn() },
      watch: (_owner: string, _assistant: string, refresh: () => void) => { ledger.refresh.push(refresh); return () => undefined; },
      presence: (agent: string) => ledger.presence[agent] ?? null,
      subscribePresence: () => () => undefined,
    },
  };
  publishIdentityDirectory({}, () => undefined);
  showAssistant();
  host = document.createElement('div');
  cell = document.createElement('div');
  document.body.append(host, cell);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  readShellSlots()?.setSlot(appHostLayerSlotKey(APP), null);
  host.remove();
  cell.remove();
});

describe('the ledger, read as the built-in list reads it', () => {
  it('reads through the built-in list\'s own store and hands main what each row draws, and nothing else', async () => {
    await render();
    await settle();
    expect(ledger.list).toHaveBeenCalledWith(assistantId);
    const last = lastPushed()!;
    expect(last).toMatchObject({ ownerId: OWNER, assistantId, state: 'ready' });
    expect(last.rows).toEqual([
      { workId: WORK_A, sessionId: 'exec-a', title: 'Compare three flights', naming: false, status: { status: 'working', detail: 'running' }, unseen: false, updatedAt: '2026-11-11T08:00:00.000Z' },
      { workId: WORK_B, sessionId: 'exec-b', title: 'Draft the weekly note', naming: false, status: { status: 'idle', detail: 'done' }, unseen: false, updatedAt: '2026-11-10T09:00:00.000Z' },
    ]);
    // Never a device, agent, coordinator, account or chat id, nor the source link.
    for (const secret of [DEVICE_HERE, DEVICE_THERE, AGENT_A, AGENT_B, COORDINATOR, 'gugu://', OWNER.slice(1)]) {
      expect(JSON.stringify(last.rows)).not.toContain(secret);
    }
  });

  it('wherever the assistant lives — the cloud, another computer, a server — the same rows, executors offline or not', async () => {
    await render();
    await settle();
    const here = lastPushed()!.rows;
    ledger.presence = {};
    for (const place of [{ kind: 'cloud', deviceId: DEVICE_THERE }, { ...home, thisDevice: false, online: false, deviceId: DEVICE_THERE }, { ...home, thisDevice: false, hostKind: 'server' }]) {
      await act(async () => showAssistant(OWNER, place));
      await render();
      await settle();
      expect(lastPushed()).toMatchObject({ ownerId: OWNER, assistantId, state: 'ready' });
      expect(lastPushed()!.rows.map((row) => [row.workId, row.sessionId, row.title])).toEqual(here.map((row) => [row.workId, row.sessionId, row.title]));
    }
    // An active task whose agent is not heard from has no indicator: never a made-up one.
    expect(lastPushed()!.rows[0]).toMatchObject({ status: null });
  });

  it('"naming…" while a new agent keeps its default name, as the built-in row shows it — until its deadline', () => {
    const task = { key: 'k', workId: WORK_A, id: 'exec-a', title: 'Codex 3', deviceId: DEVICE_THERE, agentId: AGENT_A, lastInteractedAt: '2026-11-11T08:00:00.000Z',
      // The projection's type has no 'active' (its `??` drops the work's own outcome), though its rows carry it.
      outcome: 'active' as never, assistants: [], status: null, harness: 'codex' as never, unseen: false };
    const created = '2026-11-11T08:00:00.000Z';
    const at = Date.parse(created);
    expect(pushedRowsOf([task], () => created, at + 1_000)).toEqual({ rows: [expect.objectContaining({ title: 'Codex 3', naming: true })], namingUntil: at + 60_000 });
    expect(pushedRowsOf([task], () => created, at + 61_000)).toEqual({ rows: [expect.objectContaining({ naming: false })], namingUntil: null });
    expect(pushedRowsOf([{ ...task, title: 'Compare flights' }], () => created, at + 1_000).rows[0]).toMatchObject({ naming: false });
    // A word the build does not know is no indicator.
    expect(pushedRowsOf([{ ...task, status: { status: 'sleeping' as never, detail: null } }], () => undefined, at).rows[0]).toMatchObject({ status: null });
  });

  it('a failed read with nothing kept is failed; with rows kept, stale', async () => {
    ledger.list.mockRejectedValue(new Error('offline'));
    await render();
    await settle();
    expect(lastPushed()).toMatchObject({ state: 'failed', rows: [] });
    await act(async () => root.unmount());
    root = createRoot(host);
    assistantId = `${assistantId.slice(0, -1)}f`;
    showAssistant();
    ledger.list.mockImplementation(async () => [work({ assistant_user_id: assistantId })]);
    ledger.refresh = [];
    await render();
    await settle();
    expect(lastPushed()).toMatchObject({ state: 'ready', rows: [expect.objectContaining({ workId: WORK_A })] });
    ledger.list.mockRejectedValue(new Error('offline'));
    await act(async () => { for (const refresh of ledger.refresh) refresh(); });
    await settle();
    expect(lastPushed()).toMatchObject({ state: 'stale', rows: [expect.objectContaining({ workId: WORK_A })] });
  });

  // Owner 11-12 (fresh account): the list was read while setup was finishing, the cloud said the assistant is not available
  // to this account yet (42501: its provision not ready), and the list said 「任务列表没读到 · 系统会自动再读」 for good.
  it('during setup the cloud has no list yet: an empty list, not a failure; read again as the assistant\'s setup moves on', async () => {
    ledger.list.mockRejectedValue(Object.assign(new Error('Assistant is not available to this account'), { code: '42501' }));
    await act(async () => showAssistant(OWNER, null));
    await render();
    await settle();
    expect(lastPushed()).toMatchObject({ ownerId: OWNER, assistantId, state: 'ready', rows: [] });
    // Setup done (where it lives known): read again at once, and the rows come.
    ledger.list.mockImplementation(async () => [work({ assistant_user_id: assistantId })]);
    const before = ledger.list.mock.calls.length;
    await act(async () => showAssistant(OWNER, home));
    await render();
    await settle();
    expect(ledger.list.mock.calls.length).toBeGreaterThan(before);
    expect(lastPushed()).toMatchObject({ state: 'ready', rows: [expect.objectContaining({ workId: WORK_A })] });
  });

  it('a failed read is read again by itself, sooner first, while the list is shown: 「系统会自动再读」 is true', async () => {
    const { WORK_RETRY_MS } = await import('../../../../apps/desktop/src/components/assistant/assistant-work-records');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      ledger.list.mockRejectedValue(new Error('offline'));
      await render();
      await settle();
      expect(lastPushed()).toMatchObject({ state: 'failed' });
      const reads = ledger.list.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(WORK_RETRY_MS[0] - 1); });
      expect(ledger.list.mock.calls.length).toBe(reads);
      await act(async () => { vi.advanceTimersByTime(1); });
      await settle();
      expect(ledger.list.mock.calls.length).toBe(reads + 1);
      // Then a longer wait; once it reads, the rows come and no more is asked.
      ledger.list.mockImplementation(async () => [work({ assistant_user_id: assistantId })]);
      await act(async () => { vi.advanceTimersByTime(WORK_RETRY_MS[1]); });
      await settle();
      expect(lastPushed()).toMatchObject({ state: 'ready', rows: [expect.objectContaining({ workId: WORK_A })] });
      const done = ledger.list.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(WORK_RETRY_MS.at(-1)! * 3); });
      expect(ledger.list.mock.calls.length).toBe(done);
      // Nobody shows the list: no read is left waiting.
      ledger.list.mockRejectedValue(new Error('offline'));
      await act(async () => { for (const refresh of ledger.refresh) refresh(); });
      await settle();
      await act(async () => root.unmount());
      root = createRoot(host);
      const after = ledger.list.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(WORK_RETRY_MS.at(-1)! * 3); });
      expect(ledger.list.mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads nothing, and tells main nothing, while no enabled App declares work; and says so when the last one goes', async () => {
    state.inventory = [plain('notes')];
    await render();
    await settle();
    expect(ledger.list).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
    state.inventory = [reading(APP)];
    await render();
    await settle();
    expect(lastPushed()).toMatchObject({ ownerId: OWNER, state: 'ready' });
    state.disabled = [APP];
    await render();
    await settle();
    expect(lastPushed()).toEqual({ ownerId: null, assistantId: null, state: 'none', rows: [] });
  });

  it('another account\'s shell is not this account\'s: nothing is read for it', async () => {
    // The shell still shows the account before (its own assistant), while this one is signed in.
    showAssistant(OTHER, home, '45000000-0000-4000-8000-000000000045');
    await render();
    await settle();
    expect(ledger.list).not.toHaveBeenCalled();
  });
});

describe('a task drawn in the App\'s panel', () => {
  const ready = async () => {
    await render();
    await settle();
    readShellSlots()!.setSlot(appHostLayerSlotKey(APP), cell);
    await settle();
  };

  it('is the built-in task window, opened as a row of the built-in list opens it, in the App\'s cell; its back control closes it', async () => {
    await ready();
    await openTask();
    await settle();
    const drawn = cell.querySelector('[data-testid="task-window"]')!;
    expect(drawn.getAttribute('data-owner')).toBe(OWNER);
    const opened = state.windows.at(-1)!;
    // owner 11-12: drawn as a layer of the App's panel — its surface, its top row, the chat composer (AssistantTaskChatWindow).
    expect((opened as { appPanel?: boolean }).appPanel).toBe(true);
    expect(opened.request).toEqual({ ...assistantPanelTaskChat({ assistantId }, {
      workId: WORK_A, id: 'exec-a', title: 'Compare three flights', outcome: 'active' as never, agentId: AGENT_A, deviceId: DEVICE_THERE,
      assistants: [{ deviceId: DEVICE_HERE, sessionId: COORDINATOR }], key: `${WORK_A}:exec-a`, lastInteractedAt: '2026-11-11T08:00:00.000Z',
    }), workId: WORK_A });
    expect(reported).toHaveBeenLastCalledWith({ extensionId: APP, layer: { kind: 'work', ownerId: OWNER, workId: WORK_A, sessionId: 'exec-a' } });
    await act(async () => (cell.querySelector('[data-testid="back"]') as HTMLButtonElement).click());
    await settle();
    expect(cell.querySelector('[data-testid="task-window"]')).toBeNull();
    expect(chats()).toEqual({});
    expect(reported).toHaveBeenLastCalledWith({ extensionId: APP, layer: null });
  });

  it('refuses another account, a row it has not read, and any open before it read the ledger', async () => {
    readShellSlots()!.setSlot(appHostLayerSlotKey(APP), cell);
    expect(() => readAppHostLayerBridge()!.open(APP, { kind: 'work', ownerId: OWNER, workId: WORK_A, sessionId: 'exec-a' })).toThrow();
    await ready();
    expect(() => readAppHostLayerBridge()!.open(APP, { kind: 'work', ownerId: OTHER, workId: WORK_A, sessionId: 'exec-a' })).toThrow(/account/);
    expect(() => readAppHostLayerBridge()!.open(APP, { kind: 'work', ownerId: OWNER, workId: WORK_A, sessionId: 'exec-b' })).toThrow(/not in the work list/);
    expect(chats()).toEqual({});
    expect(cell.childElementCount).toBe(0);
  });

  it('another account signing in takes it away at once — not drawn in that render, and closed', async () => {
    await ready();
    await openTask();
    await settle();
    state.owner = OTHER;
    // The render that sees the new account draws nothing of the old one's task.
    await render();
    expect(cell.querySelector('[data-testid="task-window"]')).toBeNull();
    expect(state.windows.filter((window) => window.signedIn !== OWNER)).toEqual([]);
    expect(chats()).toEqual({});
    expect(reported).toHaveBeenLastCalledWith({ extensionId: APP, layer: null });
  });

  it('leaving the session page, the App switched off, removed or no longer reading work, or main naming it changed: closed', async () => {
    for (const leave of [
      () => render(false),
      async () => { state.disabled = [APP]; await render(); },
      async () => { state.inventory = [plain('notes')]; await render(); },
      async () => { state.inventory = [{ ...reading(APP), permissions: { bindings: [{ name: 'main', kind: 'conversation', actions: ['unread'] }] } }]; await render(); },
      () => note(APP),
      () => note(undefined),
    ]) {
      Object.assign(state, { inventory: [reading(APP), plain('notes')], disabled: [] });
      await ready();
      await openTask();
      expect(Object.keys(chats())).toEqual([APP]);
      await leave();
      await settle();
      expect(chats()).toEqual({});
      expect(cell.querySelector('[data-testid="task-window"]')).toBeNull();
    }
  });

  it('another App\'s change leaves it open; the closeWork path takes it away; closing nothing changes nothing', async () => {
    await ready();
    await openTask();
    await note('notes');
    expect(Object.keys(chats())).toEqual([APP]);
    await act(async () => readAppHostLayerBridge()!.close(APP, 'work'));
    expect(chats()).toEqual({});
    const before = chats();
    await act(async () => readAppHostLayerBridge()!.close(APP, 'work'));
    expect(chats()).toBe(before);
  });
});

describe('the assistant\'s settings page over the App\'s panel (gugu.assistant.open, or the gear of the host\'s row)', () => {
  const openSettings = (owner = OWNER) => act(async () => readAppHostLayerBridge()!.open(APP, { kind: 'assistant-settings', ownerId: owner }));
  const ready = async () => {
    await render();
    await settle();
    readShellSlots()!.setSlot(appHostLayerSlotKey(APP), cell);
    await settle();
  };

  it('is the built-in settings page with the panel\'s own navigation, in the App\'s cell; reported as that page, never more', async () => {
    await ready();
    await openSettings();
    await settle();
    expect(cell.querySelector('[data-testid="settings-page"]')?.getAttribute('data-panel-navigation')).toBe('true');
    expect(reported).toHaveBeenLastCalledWith({ extensionId: APP, layer: { kind: 'assistant-settings', ownerId: OWNER } });
    // One page at a time: a task opened over it takes its place, and the settings go.
    await openTask();
    await settle();
    expect(cell.querySelector('[data-testid="settings-page"]')).toBeNull();
    expect(cell.querySelector('[data-testid="task-window"]')).not.toBeNull();
    expect(reported).toHaveBeenLastCalledWith({ extensionId: APP, layer: { kind: 'work', ownerId: OWNER, workId: WORK_A, sessionId: 'exec-a' } });
    await openSettings();
    await settle();
    expect(cell.querySelector('[data-testid="task-window"]')).toBeNull();
    expect(cell.querySelector('[data-testid="settings-page"]')).not.toBeNull();
  });

  it('only for the account it was opened for: another account, or none signed in, opens nothing', async () => {
    await ready();
    expect(() => readAppHostLayerBridge()!.open(APP, { kind: 'assistant-settings', ownerId: OTHER })).toThrow(/account/);
    expect(chats()).toEqual({});
  });

  it('closed at once on another account, the App switched off or removed, or main naming it changed', async () => {
    for (const leave of [
      async () => { state.owner = OTHER; await render(); },
      async () => { state.disabled = [APP]; await render(); },
      async () => { state.inventory = [plain('notes')]; await render(); },
      () => note(APP),
      () => note(undefined),
    ]) {
      Object.assign(state, { owner: OWNER, inventory: [reading(APP), plain('notes')], disabled: [] });
      await ready();
      await openSettings();
      await settle();
      expect(Object.keys(chats())).toEqual([APP]);
      await leave();
      await settle();
      expect(chats()).toEqual({});
      expect(cell.querySelector('[data-testid="settings-page"]')).toBeNull();
      expect(reported).toHaveBeenLastCalledWith({ extensionId: APP, layer: null });
    }
  });

  it('the App no longer reading work, another App\'s change, or the session page set aside leave it; the closeWork path never takes it away', async () => {
    await ready();
    await openSettings();
    state.inventory = [{ ...reading(APP), permissions: { bindings: [{ name: 'main', kind: 'conversation', actions: ['unread'] }] } }, plain('notes')];
    await render();
    await note('notes');
    // Unlike a task: the panel's page stays while the session page is set aside (the session page closes it when its App
    // page goes, or its assistant: app-host-layer.tsx).
    await render(false);
    await settle();
    expect(Object.keys(chats())).toEqual([APP]);
    await act(async () => readAppHostLayerBridge()!.close(APP, 'work'));
    expect(Object.keys(chats())).toEqual([APP]);
  });
});
