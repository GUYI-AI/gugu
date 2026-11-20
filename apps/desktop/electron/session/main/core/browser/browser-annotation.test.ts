import { beforeEach, expect, it, vi } from 'vitest';
import { inspectBrowserAnnotation } from './browser-annotation';

const state = vi.hoisted(() => ({ lookup: vi.fn(), capture: vi.fn(), execute: vi.fn(), destroyed: vi.fn(() => false) }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: { browserForConversation: state.lookup } }));
vi.mock('./browser-page-views', () => ({ snapshotBrowserPage: state.capture }));
const query = { x: 0.2, y: 0.3, width: 0, height: 0 };
const target = { url: 'https://example.org/', selector: '#intro', targetPath: 'main > p', text: 'Original page text',
  rect: { x: 20, y: 30, width: 100, height: 20 }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 } };
const page = { executeJavaScript: state.execute, isDestroyed: state.destroyed, getURL: () => target.url };
beforeEach(() => { vi.clearAllMocks(); state.lookup.mockReturnValue(page); state.execute.mockResolvedValue(target); state.capture.mockResolvedValue('data:image/png;base64,AAAA') });

it.each([{ kind: 'chat' as const, chatId: 'group' }, { kind: 'session' as const, sessionId: 'task' }])('captures the selected $kind page through the same conversation boundary', async conversation => {
  const actual = await inspectBrowserAnnotation({ browserId: 'page', conversation, query, capture: true });
  expect(actual).toEqual({ target, screenshot: 'data:image/png;base64,AAAA' });
  expect(state.lookup).toHaveBeenCalledWith('page', conversation);
  expect(state.execute).toHaveBeenCalledOnce();
  expect(state.capture).toHaveBeenCalledExactlyOnceWith('page');
});
it('does not execute or capture a page from a different conversation', async () => {
  state.lookup.mockReturnValue(undefined);
  await expect(inspectBrowserAnnotation({ browserId: 'other', conversation: { kind: 'chat', chatId: 'group' }, query, capture: true })).rejects.toThrow('no selected browser');
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.capture).not.toHaveBeenCalled();
});
it('rejects a page moved to a different conversation while inspection was pending', async () => {
  state.lookup.mockReturnValueOnce(page).mockReturnValue(undefined);
  await expect(inspectBrowserAnnotation({ browserId: 'page', conversation: { kind: 'chat', chatId: 'group' }, query, capture: true })).rejects.toThrow('changed conversations');
  expect(state.capture).not.toHaveBeenCalled();
});
