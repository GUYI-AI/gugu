import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_TOAST_INTERVAL_MS, APP_TOAST_MAX } from '@shared/extensions/bridge-protocol';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';
import { appToast, forgetToastsForTest } from './app-toast';

/**
 * #1925 (API 44) `gugu.toast(text)`: the host's own toast, no capability — so only the person's page, on screen and focused
 * now, one short line of text, at a rate. Nothing reaches the window otherwise.
 */
const APP = 'assistant-app';
const page = (over: Partial<Parameters<typeof appToast>[0]> = {}) => ({ extensionId: APP, person: true, onScreen: true, focused: () => true, ...over });
let now = 1_000_000;
const clock = () => now;
const act = vi.fn(async (_action: ExtensionHostAction) => undefined);

beforeEach(() => {
  forgetToastsForTest();
  act.mockClear();
  now = 1_000_000;
});

describe('gugu.toast', () => {
  it('shows the text alone, trimmed, in the host\'s toast', async () => {
    await appToast(page(), { text: '  Changes saved ' }, act, clock);
    expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'toast', text: 'Changes saved' });
  });

  it('takes one short line of text and nothing more', async () => {
    for (const input of [
      { text: '' }, { text: '   ' }, { text: 'x'.repeat(APP_TOAST_MAX + 1) }, { text: 'two\nlines' }, { text: 'bell\u0007' }, { text: 'one\u2028two' },
      { text: 3 }, { text: ['Saved'] }, {}, { text: 'Saved', action: 'Undo' }, { text: 'Saved', href: 'https://example.com' }, 'Saved',
    ]) await expect(appToast(page(), input, act, clock)).rejects.toMatchObject({ code: 'invalid' });
    await appToast(page(), { text: 'x'.repeat(APP_TOAST_MAX) }, act, clock);
    expect(act).toHaveBeenCalledOnce();
  });

  it('only from the person\'s page, on screen and focused now', async () => {
    for (const over of [{ person: false }, { onScreen: false }, { focused: () => false }]) {
      await expect(appToast(page(over), { text: 'Saved' }, act, clock)).rejects.toMatchObject({ code: 'denied' });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('one every interval for each App; a refused one does not count', async () => {
    await appToast(page(), { text: 'one' }, act, clock);
    now += APP_TOAST_INTERVAL_MS - 1;
    await expect(appToast(page(), { text: 'two' }, act, clock)).rejects.toMatchObject({ code: 'rate-limited' });
    await appToast(page({ extensionId: 'another-app' }), { text: 'theirs' }, act, clock);
    now += 1;
    await expect(appToast(page({ focused: () => false }), { text: 'unseen' }, act, clock)).rejects.toMatchObject({ code: 'denied' });
    await appToast(page(), { text: 'three' }, act, clock);
    expect(act.mock.calls.map(([action]) => (action as { text: string }).text)).toEqual(['one', 'theirs', 'three']);
  });
});
