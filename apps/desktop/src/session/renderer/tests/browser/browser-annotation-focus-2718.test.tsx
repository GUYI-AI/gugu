import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { browserAnnotationSpaceChannel } from '@shared/events/browserEvents';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { useBrowserAnnotations } from '@renderer/features/browser/browser-annotations';

const native = vi.hoisted(() => ({
  listeners: new Map<unknown, Set<(event: unknown) => void>>(),
  focusHost: vi.fn(async (_name: string) => ({ success: true })),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (channel: unknown, listener: (event: unknown) => void) => {
    const listeners = native.listeners.get(channel) ?? new Set();
    listeners.add(listener); native.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  } },
  rpc: { browser: { focusHost: native.focusHost } },
}));

let harness: ReturnType<typeof createReactHarness> | null = null;
afterEach(async () => {
  await act(async () => { await userEvent.keyboard('{/Space}'); });
  harness?.cleanup(); harness = null;
  native.listeners.clear(); native.focusHost.mockReset();
});

function Fixture() {
  const annotation = useBrowserAnnotations({ sessionId: 'focus-test', browserId: 'page', visible: true, available: true,
    inspect: async () => { throw new Error('This keyboard test does not inspect the page'); } });
  return <><input aria-label="Composer draft" defaultValue="Draft" />{annotation.toolbar}<div>{annotation.overlay}</div></>;
}

it('keeps the canvas ready for another Space browse after native focus returns, while letting the composer accept typing', async () => {
  await page.viewport(800, 600);
  harness = createReactHarness();
  await harness.render(<SessionLocalizationProvider><Fixture /></SessionLocalizationProvider>);
  const composer = harness.container.querySelector<HTMLInputElement>('input')!;
  composer.focus();
  await act(async () => { await userEvent.click(harness!.container.querySelector('button')!); });
  const canvas = () => harness!.container.querySelector<HTMLElement>('[data-browser-annotation-layer]');
  await until('entering annotation mode focuses its canvas', () => canvas() === document.activeElement);
  // On mac1 the host window restored the previously focused composer when the native guest released focus.
  native.focusHost.mockImplementation(async () => { composer.focus(); return { success: true }; });
  for (let i = 0; i < 2; i++) {
    await act(async () => { await userEvent.keyboard('{Space>}'); });
    await until('Space temporarily exposes the native page', () => canvas() === null);
    await act(async () => {
      for (const listener of native.listeners.get(browserAnnotationSpaceChannel) ?? []) listener({ browserId: 'page', pressed: false });
    });
    await until('the canvas regains focus after the native key release', () => canvas() === document.activeElement);
    await act(async () => { await userEvent.keyboard('{/Space}'); });
  }
  expect(composer.value).toBe('Draft');
  await userEvent.click(composer);
  await userEvent.keyboard(' ');
  expect(composer.value).toBe('Draft ');
  expect(canvas()).not.toBeNull();
});
