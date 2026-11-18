// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The assistant App's page restored while the App is not here to draw it (verify-pass1 D9): one more route into the assistant, so it
// asks the one decision (lib/assistantEntry.ts) — but only once the installed Apps are read, so a good restore is not sent away.
const mocks = vi.hoisted(() => ({ target: { kind: 'chat' } as { kind: 'app' | 'chat' | 'setup' | 'wait' }, loaded: true, opened: 0 }));
vi.mock('@/lib/assistantEntry', () => ({ ASSISTANT_APP_ID: 'gugu-assistant', useAssistantEntryTarget: () => mocks.target, openAssistantEntry: () => { mocks.opened += 1; } }));
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { get isLoaded() { return mocks.loaded; } } }));

const { useAssistantPageNotHere } = await import('./assistant-page-not-here');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let answer: boolean | undefined;
function Page({ appId, drawn }: { appId: string | undefined; drawn: boolean }) {
  answer = useAssistantPageNotHere(appId, drawn);
  return null;
}
const show = (appId: string | undefined, drawn: boolean) => act(async () => { root.render(<Page appId={appId} drawn={drawn} />); });

beforeEach(() => {
  mocks.target = { kind: 'chat' }; mocks.loaded = true; mocks.opened = 0; answer = undefined;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('the assistant App\'s page while the App is not here', () => {
  it('is not here when the App is missing or switched off and the entry does not go to it: it asks the entry once, and says so', async () => {
    await show('gugu-assistant', false);
    expect(answer).toBe(true);
    expect(mocks.opened).toBe(1);
    // A render that changes nothing asks nothing more.
    await show('gugu-assistant', false);
    expect(mocks.opened).toBe(1);
  });

  it('waits until the installed Apps are read: "missing" may only mean "not read yet", a good restore is not sent away', async () => {
    mocks.loaded = false;
    await show('gugu-assistant', false);
    expect(answer).toBe(true);
    expect(mocks.opened).toBe(0);
  });

  it('asks again when the decision changes while the page waits (the assistant was still being read, then found)', async () => {
    mocks.target = { kind: 'wait' };
    await show('gugu-assistant', false);
    expect(mocks.opened).toBe(1);
    mocks.target = { kind: 'chat' };
    await show('gugu-assistant', false);
    expect(mocks.opened).toBe(2);
  });

  it.each([
    ['the App is drawn', 'gugu-assistant', true, 'chat'],
    ['the entry goes to the App', 'gugu-assistant', false, 'app'],
    ['it is another App', 'clock', false, 'chat'],
    ['it names no App', undefined, false, 'chat'],
  ] as const)('asks nothing and says nothing when %s', async (_why, appId, drawn, kind) => {
    mocks.target = { kind };
    await show(appId, drawn);
    expect(answer).toBe(false);
    expect(mocks.opened).toBe(0);
  });
});
