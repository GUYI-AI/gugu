// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settlement } from '@gugu/session-core/session-record/contract';
import { i18n } from '@/i18n';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { useHostAskBand, useSessionHostAsk } from './use-session-host-ask';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), respond: vi.fn(), toast: vi.fn(), sheet: vi.fn(),
  machineId: null as string | null,
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sessionTimeline: { sessionRespond: mocks.respond } },
  rpcOn: () => ({ sessionTimeline: {
    sessionSnapshot: mocks.snapshot, sessionSubscribe: mocks.subscribe, sessionUnsubscribe: mocks.unsubscribe,
  } }),
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => mocks.machineId } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => ({ label: 'Build desktop' }) } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: translateSessionMessage }) }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./install-consent', () => ({ askInShell: mocks.sheet, installConsentPrompt: () => ({ title: 'Install Reader?' }) }));
vi.mock('@shared/extensions/manifest', async (original) => ({
  ...await original<typeof import('@shared/extensions/manifest')>(),
  safeParseExtensionManifest: (manifest: unknown) => ({ ok: true, manifest }),
}));

const ask: Settlement = {
  itemId: 'ask-1', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null,
  options: [{ optionId: 'install', name: 'Install' }, { optionId: 'decline', name: 'Decline' }],
  origin: { source: 'app-install', payload: { request: {
    requestId: 'ask-1', sourceDir: '/tmp/reader', manifest: { id: 'reader', name: 'Reader' },
    manifestDigest: 'reader-digest', revokedPermissions: [], given: { first: true },
  } } },
};
let root: Root;
let container: HTMLDivElement;
let band: ReturnType<typeof useHostAskBand>;
function Probe() {
  band = useHostAskBand('session-1', { status: 'needs_user', detail: 'approval' });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.machineId = null;
  await i18n.changeLanguage('en-US');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.snapshot.mockResolvedValue({ ok: true, value: { settlements: [ask], cursor: {} } });
  mocks.subscribe.mockResolvedValue(undefined);
  mocks.unsubscribe.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(band).not.toBeNull();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('session approval band response feedback', () => {
  it('shows the host message when the answer is refused', async () => {
    const code = 'host_ask_refused';
    const message = 'The host refused this install answer';
    mocks.respond.mockResolvedValue({ ok: false, error: { code, message } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.respond).toHaveBeenCalledWith({
      conversationId: 'session-1', itemId: 'ask-1', kind: 'permission', by: 'desktop', optionId: 'decline',
    });
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: message, variant: 'destructive' });
  });

  it.each([
    ['en-US', null, 'This computer no longer has this task'],
    ['en-US', 'remote-machine', 'Build desktop no longer has this task'],
    ['zh-CN', null, '本机 上已不存在此会话'],
  ])('uses the viewing locale %s and device %s for a missing session', async (locale, machineId, title) => {
    await i18n.changeLanguage(locale);
    mocks.machineId = machineId;
    await act(async () => root.render(<Probe />));
    mocks.respond.mockResolvedValue({ ok: false, error: {
      code: 'session_not_found', message: '这台机器上没有会话 session-private-id',
    } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title, variant: 'destructive' });
  });

  it.each([true, false])('keeps a resolved answer silent (accepted=%s)', async (accepted) => {
    mocks.respond.mockResolvedValue({ ok: true, value: { accepted, settlement: { ...ask, state: 'resolved' } } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('keeps the no-longer-waiting notice for a withdrawn ask', async () => {
    mocks.respond.mockResolvedValue({ ok: true, value: { accepted: false, settlement: { ...ask, state: 'cancelled' } } });
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: 'This request has ended. Nothing was installed.' });
  });

  it('keeps transport errors on the same destructive toast path', async () => {
    mocks.respond.mockRejectedValue(new Error('Host disconnected'));
    await act(async () => band!.resolve('decline'));
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: 'Host disconnected', variant: 'destructive' });
  });

  it('closing the install sheet sends no answer and shows no error', async () => {
    mocks.sheet.mockResolvedValue({ outcome: 'dismissed' });
    await act(async () => band!.resolve('install'));
    expect(mocks.respond).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe('an ask the page already follows', () => {
  it('reads the agent question off the settlements it is given and follows nothing more on the machine', async () => {
    const question = {
      ...ask, itemId: 'question-1', kind: 'question', origin: { source: 'agent-question', payload: {} },
      questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ optionId: 'a', label: 'A' }] }],
    } as unknown as Settlement;
    let held: Settlement | null = null;
    function HeldProbe({ settlements }: { settlements: Record<string, Settlement> }) {
      held = useSessionHostAsk('session-2', ['agent-question'], true, settlements);
      return null;
    }
    mocks.snapshot.mockClear();
    mocks.subscribe.mockClear();
    const heldRoot = createRoot(document.createElement('div'));
    await act(async () => heldRoot.render(<HeldProbe settlements={{ [question.itemId]: question }} />));
    expect(held).toMatchObject({ itemId: 'question-1' });
    await act(async () => heldRoot.render(<HeldProbe settlements={{}} />));
    expect(held).toBeNull();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    act(() => heldRoot.unmount());
  });

  it('shows the App install the feed holds before the status says it waits, and follows nothing more on the machine', async () => {
    let held: ReturnType<typeof useHostAskBand> = null;
    function HeldBand({ settlements }: { settlements: Record<string, Settlement> }) {
      held = useHostAskBand('session-2', { status: 'working', detail: null }, settlements);
      return null;
    }
    mocks.snapshot.mockClear();
    mocks.subscribe.mockClear();
    const heldRoot = createRoot(document.createElement('div'));
    await act(async () => heldRoot.render(<HeldBand settlements={{ [ask.itemId]: ask }} />));
    expect(held).toMatchObject({ request: { requestId: 'ask-1' } });
    await act(async () => heldRoot.render(<HeldBand settlements={{ [ask.itemId]: { ...ask, state: 'resolved', optionId: 'decline' } }} />));
    expect(held).toBeNull();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    act(() => heldRoot.unmount());
  });
});
