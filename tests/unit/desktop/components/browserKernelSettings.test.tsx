// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness';
import { BrowserKernelSettings } from '../../../../apps/desktop/src/session/renderer/features/settings/components/BrowserKernelSettings';
import type { BrowserKernelStatus } from '../../../../apps/desktop/src/session/shared/browser-kernel';

vi.mock('../../../../apps/desktop/src/session/renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, values: Record<string, unknown> = {}) => {
    const labels: Record<string, string> = {
      'browserSettings.kernel': '内核', 'browserSettings.kernelBuiltin': '内置',
      'browserSettings.kernelStandalone': '独立', 'browserSettings.kernelStandaloneRow': '独立内核',
      'browserSettings.kernelConfirmTitle': '换成独立内核？', 'browserSettings.kernelLater': '先不用',
      'browserSettings.kernelDownloadAndSwitch': '下载并切换', 'browserSettings.kernelCancel': '取消',
      'browserSettings.kernelCheckUpdate': '检查更新', 'browserSettings.delete': '删除',
      'browserSettings.kernelConfirmDescription': '下载约 {size}',
      'browserSettings.kernelDownloading': '正在下载 {percent}%',
      'browserSettings.kernelInstalled': '版本 {version}，占 {size}',
    };
    return (labels[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => String(values[name]));
  } }),
}));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); });
afterEach(() => harness.cleanup());
const idle: BrowserKernelStatus = { supported: true, selected: 'builtin', phase: 'idle',
  asset: { version: '158.0.1.1', downloadBytes: 200_339_070 }, installation: null,
  receivedBytes: 0, totalBytes: 200_339_070, error: null };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!;
async function draw(status = idle) {
  const action = vi.fn(async () => {}), onError = vi.fn();
  await harness.render(createNode(BrowserKernelSettings, { status, action, onError }));
  return action;
}

describe('standalone kernel installation consent', () => {
  it('only downloads after the nearby confirmation, using actual archive size', async () => {
    const action = await draw();
    await clickElement(button('独立'));
    expect(action).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('换成独立内核？');
    expect(document.body.textContent).toContain('200 MB');
    expect(button('内置').getAttribute('aria-pressed')).toBe('true');
    await clickElement(button('下载并切换'));
    expect(action).toHaveBeenCalledExactlyOnceWith('download-and-switch');
  });

  it('dismissing the question leaves both the selection and download untouched', async () => {
    const action = await draw();
    await clickElement(button('独立'));
    await clickElement(button('先不用'));
    expect(action).not.toHaveBeenCalled();
    expect(button('内置').getAttribute('aria-pressed')).toBe('true');
    expect(button('独立').getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the measured byte progress in the inline row and cancels that operation', async () => {
    const action = await draw({ ...idle, selected: 'standalone', phase: 'downloading', receivedBytes: 420, totalBytes: 1000 });
    expect(harness.container.textContent).toContain('正在下载 42%');
    const progress = harness.container.querySelector('progress')!;
    expect(progress.value).toBe(420);
    expect(progress.max).toBe(1000);
    await clickElement(button('取消'));
    expect(action).toHaveBeenCalledExactlyOnceWith('cancel');
  });

  it('reports actual installed version and occupancy without another download question', async () => {
    const action = await draw({ ...idle, installation: { version: '158.0.1.1', installedBytes: 386_711_260 } });
    expect(harness.container.textContent).toContain('版本 158.0.1.1，占 387 MB');
    await clickElement(button('独立'));
    expect(action).toHaveBeenCalledExactlyOnceWith('download-and-switch');
    expect(document.body.textContent).not.toContain('换成独立内核？');
  });
});
