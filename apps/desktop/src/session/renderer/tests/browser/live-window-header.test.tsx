import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { IconButton } from '@/components/ui/IconButton';
import { MoreHorizontal } from '@/lib/icons';
import { LiveWindowHeaderIcon } from '../../features/live-window/LiveWindowHeaderIcon';
import { LiveWindowModel } from '../../features/live-window/model';
import { DesktopLiveWindow } from '../../features/live-window/DesktopLiveWindow';
import { PhoneWatchWindow } from '@/mobile/agent-watch/PhoneWatchWindow';
import { PhoneLiveWindowTitle } from '@/mobile/agent-watch/PhoneLiveWindowTitle';
import { AgentWatchScreen } from '@/mobile/agent-watch/AgentWatchChrome';
import { LocalizationProvider } from '@/i18n';
import type { LiveWindowContext, LiveWindowSource } from '../../features/live-window/types';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@/mobile/phone-shell.css';
import '@/mobile/agent-watch/agent-watch.css';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
const context: LiveWindowContext = { conversationId: 'private', deviceId: 'host', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true };
const source = (kind: 'browser' | 'computer', activity: number, status: 'operating' | 'finished' = 'operating'): LiveWindowSource => ({
  id: kind, kind, activity, status, deviceId: 'host', sessionId: 'task', agentId: 'agent', title: kind, size: { width: 1280, height: 900 },
});

async function mount(platform: 'desktop' | 'phone') {
  await page.viewport(platform === 'phone' ? 390 : 1280, 844);
  const host = document.body.appendChild(document.createElement('div'));
  host.className = 'gugu-skin'; host.style.cssText = `position:relative;display:flex;flex-direction:column;width:${platform === 'phone' ? 390 : 1000}px;height:700px`;
  const root = createRoot(host), model = new LiveWindowModel(platform); model.activate(context);
  function View() {
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
    const sources = snapshot.sources.map(item => ({ ...item, picture: <div data-source={item.id}>Actual picture node</div> }));
    return <><div style={{ display: 'flex', height: 44, flex: 'none' }}><LiveWindowHeaderIcon snapshot={snapshot} dispatch={action => model.dispatch(action)} /></div>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {platform === 'phone' ? <PhoneWatchWindow sources={sources} selectedId={snapshot.source?.id ?? null} presentation={snapshot.presentation!}
          visible={snapshot.visible} connected={snapshot.connected} dispatch={action => model.dispatch(action)} onError={error => { throw error; }}>
          <div data-chat-viewport style={{ flex: 1 }} />
          <div data-chat-composer-placement style={{ height: 80, flex: 'none' }}><textarea aria-label="Reply" /></div>
        </PhoneWatchWindow> : snapshot.visible && snapshot.source ? <DesktopLiveWindow source={sources.find(item => item.id === snapshot.source!.id)!}
          sources={sources} state={snapshot.presentation!} connected={snapshot.connected} dispatch={action => model.dispatch(action)} /> : null}
      </div></>;
  }
  await act(async () => root.render(<View />));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  return { host, model };
}

describe.each(['desktop', 'phone'] as const)('%s active header', platform => {
  it('toggles directly, remains hidden across later activity and uses the actual active source', async () => {
    const { host, model } = await mount(platform);
    expect(host.querySelector('[data-live-window-toggle]')).toBeNull();
    await act(async () => model.observe(context, [source('browser', 1)]));
    const toggle = host.querySelector<HTMLButtonElement>('[data-live-window-toggle]')!;
    expect(toggle.dataset.kind).toBe('browser'); expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[role=menu]')).toBeNull();
    await page.elementLocator(toggle).click();
    expect(model.getSnapshot().visible).toBe(false);
    await act(async () => model.observe(context, [source('browser', 1), source('computer', 2)]));
    expect(toggle.dataset.kind).toBe('computer'); expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(model.getSnapshot().visible).toBe(false);
    await page.elementLocator(toggle).click();
    expect(model.getSnapshot()).toMatchObject({ visible: true, source: { kind: 'computer' } });
    await until('two sources share one window', () => host.querySelectorAll('[role=tab]').length === 2);
    expect(host.querySelectorAll(platform === 'phone' ? '[data-phone-watch-window]' : '[data-live-window]')).toHaveLength(1);
  });
  it('stops animation when done, keeps a disconnected picture and removes a truly closed source', async () => {
    const { host, model } = await mount(platform);
    await act(async () => model.observe(context, [source('browser', 1)]));
    const toggle = host.querySelector<HTMLButtonElement>('[data-live-window-toggle]')!;
    expect(toggle.dataset.running).toBe('true');
    await act(async () => model.observe(context, [source('browser', 1, 'finished')]));
    expect(toggle.hasAttribute('data-running')).toBe(false);
    expect(toggle.title).not.toMatch(/Using|正在用/);
    expect(model.getSnapshot().visible).toBe(platform === 'phone');
    if (platform === 'desktop') await page.elementLocator(toggle).click();
    await act(async () => model.activate({ ...context, connected: false }));
    expect(toggle.dataset.disconnected).toBe('true');
    expect(host.querySelector('[data-live-window-disconnected]')?.textContent).toMatch(/Computer disconnected|电脑已断开/);
    await act(async () => model.observe({ ...context, connected: false }, []));
    expect(host.querySelector('[data-live-window-toggle]')).toBeNull();
  });
});

it.each(['browser', 'computer'] as const)('keeps the centered phone %s toggle hittable beside a long title', async kind => {
  await page.viewport(360, 766);
  const host = document.body.appendChild(document.createElement('div'));
  host.className = 'gugu-skin'; host.setAttribute('data-phone-shell', '');
  host.style.cssText = 'width:360px;height:700px';
  const root = createRoot(host), model = new LiveWindowModel('phone'); model.activate(context); model.observe(context, [source(kind, 1)]);
  function View() {
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
    return <LocalizationProvider><AgentWatchScreen testId="header-fit" onBack={() => {}} centeredHeader
      title={<PhoneLiveWindowTitle name="Issue #2868 acceptance with a long agent name" live={{ ...snapshot, dispatch: action => model.dispatch(action) }} />}
      subtitle="产品讨论"
      actions={<IconButton aria-label="更多"><MoreHorizontal /></IconButton>}>
      <div />
    </AgentWatchScreen></LocalizationProvider>;
  }
  await act(async () => root.render(<View />));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  const header = host.querySelector<HTMLElement>('.gg-pane-header[data-centered]')!;
  const title = header.querySelector<HTMLElement>('.gg-pane-heading')!;
  const center = (node: HTMLElement) => node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2;
  expect(Math.abs(center(title) - center(header))).toBeLessThan(1);
  const toggle = host.querySelector<HTMLButtonElement>('[data-live-window-toggle]')!;
  expect(toggle.dataset.kind).toBe(kind);
  expect(toggle.dataset.running).toBe('true');
  expect(header.querySelector('.live-window-header-label')).toBeNull();
  const b = toggle.getBoundingClientRect();
  expect(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button'), JSON.stringify({
    toggle: b.toJSON(), viewport: [innerWidth, innerHeight], host: host.getBoundingClientRect().toJSON(),
    title: host.querySelector('.gg-pane-heading-title')?.getBoundingClientRect().toJSON(),
    copy: host.querySelector('.gg-aw-title-copy')?.getBoundingClientRect().toJSON(),
  })).toBe(toggle);
  await page.elementLocator(toggle).click();
  expect(model.getSnapshot().visible).toBe(false);
});
