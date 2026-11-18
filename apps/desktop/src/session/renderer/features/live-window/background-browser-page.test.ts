import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceViewModel } from '../sessions/stores/workspace-view-model';
const mocks = vi.hoisted(() => ({ create: vi.fn(), dispose: vi.fn(), register: vi.fn(), ensure: vi.fn() }));
vi.mock('../browser/browser-tab-provider', () => ({ browserTabProvider: {
  onBeforeOpen: mocks.create,
  initialize: (entry: { state: { session: unknown } }) => ({ session: entry.state.session, dispose: mocks.dispose }),
} }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { browser: { registerSession: mocks.register, ensureAgentPage: mocks.ensure } } }));
import { backgroundBrowserPage, prepareBackgroundBrowserPage, releaseBackgroundBrowserPage } from './background-browser-page';
const view = { activePane: { ctx: { projectId: 'p', sessionId: 's' } }, paneLayout: { open: vi.fn() } } as unknown as WorkspaceViewModel;
const request = () => ({ createIfMissing: true, deadline: Date.now() + 9_000 });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue({ browserId: 'page', session: { browserId: 'page', partition: 'persist:test', sessionId: 's', currentUrl: 'https://example.test/' } });
  mocks.register.mockResolvedValue({ success: true }); mocks.ensure.mockResolvedValue({ success: true });
});
afterEach(() => releaseBackgroundBrowserPage(view));
it('prepares a real backing page once without opening a second visible pane', async () => {
  for (const created of [true, false]) {
    await expect(prepareBackgroundBrowserPage(view, 'https://example.test/', request(), new AbortController().signal)).resolves.toEqual({ browserId: 'page', created });
  }
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(view.paneLayout.open).not.toHaveBeenCalled();
  expect(mocks.register).toHaveBeenCalledWith({ browserId: 'page', partition: 'persist:test', sessionId: 's' });
  expect(mocks.ensure).toHaveBeenCalledWith({ browserId: 'page', partition: 'persist:test', url: 'https://example.test/' });
});
it('rolls back failed first navigation and can retry without retaining a broken page', async () => {
  mocks.ensure.mockResolvedValueOnce({ success: false, error: 'navigation refused' });
  await expect(prepareBackgroundBrowserPage(view, 'https://example.test/', request(), new AbortController().signal)).rejects.toThrow('navigation refused');
  expect(backgroundBrowserPage(view)).toBeUndefined(); expect(mocks.dispose).toHaveBeenCalledTimes(1);
  await expect(prepareBackgroundBrowserPage(view, 'https://example.test/', request(), new AbortController().signal)).resolves.toMatchObject({ created: true });
});
it('immediately releases a cancelled first preparation and never admits its late page mount', async () => {
  const pending = Promise.withResolvers<{ success: boolean }>(); mocks.register.mockReturnValueOnce(pending.promise);
  const controller = new AbortController();
  const operation = prepareBackgroundBrowserPage(view, 'https://example.test/', request(), controller.signal);
  await vi.waitFor(() => expect(mocks.register).toHaveBeenCalled());
  controller.abort(); expect(backgroundBrowserPage(view)).toBeUndefined();
  pending.resolve({ success: true }); await expect(operation).rejects.toThrow('aborted');
  expect(mocks.ensure).not.toHaveBeenCalled();
});
it('shares a concurrent preparation while only its first successful receipt claims creation', async () => {
  const pending = Promise.withResolvers<{ success: boolean }>(); mocks.register.mockReturnValueOnce(pending.promise);
  const a = new AbortController();
  const first = prepareBackgroundBrowserPage(view, 'https://example.test/', request(), a.signal);
  const second = prepareBackgroundBrowserPage(view, 'https://example.test/', request(), new AbortController().signal);
  await expect(second).resolves.toEqual({ browserId: 'page', created: true });
  a.abort(); pending.resolve({ success: true }); await expect(first).rejects.toThrow('aborted');
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.dispose).not.toHaveBeenCalled();
  expect(backgroundBrowserPage(view)).toBeDefined();
});
