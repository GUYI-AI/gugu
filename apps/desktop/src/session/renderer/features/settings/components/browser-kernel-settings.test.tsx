// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserKernelStatus } from '@shared/browser-kernel';
import { BrowserKernelSettings } from './BrowserKernelSettings';

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({
  translate: (key: string, args: Record<string, unknown> = {}) => `${key} ${Object.values(args).join(' ')}`.trim(),
}) }));
let root: Root, container: HTMLDivElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const harness = { render: async (node: import('react').ReactNode) => { await act(async () => { root.render(node); }); } };
const clickElement = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const button = (name: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const text = () => document.body.textContent ?? '';
const initial: BrowserKernelStatus = { supported: true, selected: 'builtin', phase: 'idle',
  asset: { version: '158.0.8127.36', downloadBytes: 200_339_070 }, installation: null,
  receivedBytes: 0, totalBytes: 200_339_070, error: null };

describe('standalone browser consent', () => {
  it('only starts a download after the nearby explicit consent, including after dismissing it once', async () => {
    const action = vi.fn(async () => {});
    await harness.render(<BrowserKernelSettings status={initial} action={action} onError={vi.fn()} />);
    await clickElement(button('browserSettings.kernelStandalone'));
    expect(action).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(text()).toContain('browserSettings.kernelConfirmDescription 200 MB'));
    await clickElement(button('browserSettings.kernelLater'));
    expect(action).not.toHaveBeenCalled();
    await clickElement(button('browserSettings.kernelStandalone'));
    await clickElement(button('browserSettings.kernelDownloadAndSwitch'));
    await vi.waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith('download-and-switch'));
  });

  it('shows actual bytes and cancellation during a transfer', async () => {
    const action = vi.fn(async () => {});
    await harness.render(<BrowserKernelSettings status={{ ...initial, selected: 'standalone', phase: 'downloading', receivedBytes: 84_142_409 }} action={action} onError={vi.fn()} />);
    const progress = document.querySelector('progress') as HTMLProgressElement;
    expect(progress.value).toBe(84_142_409);
    expect(progress.max).toBe(200_339_070);
    expect(text()).toContain('browserSettings.kernelDownloading 41');
    await clickElement(button('browserSettings.kernelCancel'));
    expect(action).toHaveBeenCalledWith('cancel');
  });

  it('reads the installed version and disk size, and uses the installed engine without another download prompt', async () => {
    const action = vi.fn(async () => {});
    await harness.render(<BrowserKernelSettings status={{ ...initial, installation: { version: '158.0.8127.36', installedBytes: 712_000_000 } }} action={action} onError={vi.fn()} />);
    expect(text()).toContain('browserSettings.kernelInstalled 158.0.8127.36 712 MB');
    await clickElement(button('browserSettings.kernelStandalone'));
    await vi.waitFor(() => expect(action).toHaveBeenCalledWith('download-and-switch'));
    expect(text()).not.toContain('browserSettings.kernelConfirmTitle');
  });
});
