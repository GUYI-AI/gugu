import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ pageFor: vi.fn(), existingPage: vi.fn() }));
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, dialog: {} }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: { isRegistered: () => true, unregisterSession: vi.fn() } }));
vi.mock('./remote-task-page', () => ({ watchTaskPageConnection: vi.fn() }));
vi.mock('./task-page-screen', () => ({ connectTaskPageScreen: vi.fn() }));
vi.mock('../settings/settings-service', () => ({ appSettingsService: { get: async () => ({ profiles: [], relaxCorsForLocalhost: false }) } }));
vi.mock('./standalone-kernel-service', () => ({ standaloneKernelService: () => ({ pool: { pageFor: m.pageFor, existingPage: m.existingPage, reserveTab: vi.fn(), closeTab: vi.fn() } }) }));
import { browserKernelBindings, measureStandalonePage } from './standalone-page-runtime';

/**
 * A Chrome page that lays itself out at the width of the viewport it has: Chrome's own window width until Gugu sizes the
 * viewport to the pane, then the pane's. The layout width a page without a viewport meta reports is that width.
 */
function page() {
  let width = 800;
  let sized!: () => void;
  const firstSize = new Promise<void>(resolve => { sized = resolve; });
  const fake = Object.assign(new EventEmitter(), {
    state: () => ({ url: 'http://site.test/', title: '', isLoading: false, canGoBack: false, canGoForward: false }),
    sized: () => firstSize,
    resize(paneWidth: number) { width = paneWidth; sized(); },
    hostCommand: vi.fn(async () => ({ result: { value: JSON.stringify({ layoutWidthPx: width, viewportWidthPx: width, hasViewportMeta: false }) } })),
  });
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  browserKernelBindings.delete('tab');
  browserKernelBindings.bind({ browserId: 'tab', partition: 'persist:gugu-browser-profile-shared' }, 'standalone');
});

describe('measuring the width a standalone page lays out at', () => {
  it('waits until the page has been given the size of its pane, so a page loaded before that is not mistaken for a wide one', async () => {
    const fake = page();
    m.pageFor.mockResolvedValue(fake);
    m.existingPage.mockResolvedValue(fake);
    const measuring = measureStandalonePage('tab');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.hostCommand).not.toHaveBeenCalled(); // Chrome's own 800px window is not the pane.
    fake.resize(370);
    const layout = await measuring;
    expect(layout?.layoutWidthPx).toBe(370);
    expect(fake.hostCommand).toHaveBeenCalledOnce();
  });

  it('measures at once for a page that already has its size', async () => {
    const fake = page();
    fake.resize(424);
    m.pageFor.mockResolvedValue(fake);
    m.existingPage.mockResolvedValue(fake);
    expect((await measureStandalonePage('tab'))?.layoutWidthPx).toBe(424);
  });
});
