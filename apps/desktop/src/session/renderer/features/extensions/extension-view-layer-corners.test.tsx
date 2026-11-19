// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionViewStore, residentPageKey, residentPlace } from './extension-view-store';
import { ExtensionPage } from './extension-view-layer';
import { pageCorners } from './page-corners';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { browser: { focusHost: async () => ({ success: true }) }, extensions: { activate: async () => ({ success: true, data: { partition: 'test', entryUrl: 'about:blank' } }) } } }));
vi.mock('./installed-extensions-store', () => ({ installedExtensionsStore: { manifestFor: () => undefined } }));
vi.mock('./extension-surface-store', () => ({ extensionSurfaceStore: { setWebContentsId() {}, forgetShared() {} } }));
vi.mock('./app-settings-page', () => ({ AppSettingsPage: () => null }));

const radii = (r: string) => ({ borderTopLeftRadius: r, borderTopRightRadius: r, borderBottomRightRadius: r, borderBottomLeftRadius: r });
const corners = (r: ReturnType<typeof pageCorners>) => [r.borderTopLeftRadius, r.borderTopRightRadius, r.borderBottomRightRadius, r.borderBottomLeftRadius].join(' ');
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe('the corners an App page is drawn with', () => {
  it('are the place\'s own, each corner of it that is on screen', () => {
    expect(corners(pageCorners(radii('19px'), box(0, 0, 590, 830), box(0, 0, 590, 830)))).toBe('19px 19px 19px 19px');
    // Cut off at the bottom by a scrolling ancestor: the bottom corners show the middle of the page, square.
    expect(corners(pageCorners(radii('19px'), box(0, 0, 590, 830), box(0, 0, 590, 400)))).toBe('19px 19px 0px 0px');
    // Cut off at the left: the left corners square.
    expect(corners(pageCorners(radii('19px'), box(-20, 0, 590, 830), box(0, 0, 570, 830)))).toBe('0px 19px 19px 0px');
  });

  it('are square where the place is square (every other slot)', () => {
    expect(corners(pageCorners(radii('0px'), box(0, 0, 590, 830), box(0, 0, 590, 830)))).toBe('0px 0px 0px 0px');
  });
});

// Real window (verify-pass1 11-b): the App's page as the assistant panel sat square in the panel's rounded card — drawn in
// the root layer, outside the card's clip. Control (the parent commit): the page's box had no corners at all.
describe('the root layer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let slot: HTMLDivElement;
  const kind = 'gugu-assistant.main';
  const target = { tabId: 'dock' };
  let token: number;
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 590, 830));
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: () => true });
    host = document.createElement('div');
    slot = document.createElement('div');
    document.body.append(slot, host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    extensionViewStore.release(kind, token);
    host.remove();
    slot.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function pageBox() {
    token = extensionViewStore.claim(kind, { ...target, element: slot });
    const layer = createRef<HTMLDivElement>();
    layer.current = host;
    await act(async () => root.render(<ExtensionPage kind={kind} extensionId="gugu-assistant" layerRef={layer} pageKey={residentPageKey(kind, residentPlace(target))} />));
    const style = host.querySelector<HTMLElement>('[data-extension-view]')!.style;
    // jsdom writes a zero length as `0`.
    return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map((r) => (r === '0' ? '0px' : r)).join(' ');
  }

  it('draws the page with the corners of the slot that claims it', async () => {
    Object.assign(slot.style, radii('19px'));
    expect(await pageBox()).toBe('19px 19px 19px 19px');
  });

  it('draws it square in a square slot, as before', async () => {
    expect(await pageBox()).toBe('0px 0px 0px 0px');
  });
});
