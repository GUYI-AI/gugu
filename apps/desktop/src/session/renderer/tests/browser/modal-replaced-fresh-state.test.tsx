/**
 * 一个弹窗还开着时又来一次请求(通讯录里先后点两个 agent 的「归档会话」),换上来的是一个新弹窗:勾选回到它自己的默认值。
 *
 * 从前内容组件不换 key,上一个弹窗里取消掉的「同时移出所有群和联系人」被带到下一个 agent 的确认框上。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  document.body.append(host);
  root = createRoot(host);
  modalStore.closeModal();
});

afterEach(() => {
  modalStore.closeModal();
  root.unmount();
  host.remove();
});

const optionBox = () => document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]');
const archive = (name: string, onSuccess: (result: { optionChecked: boolean }) => void) => showModal('confirmActionModal', {
  title: 'Archive session',
  description: `Archive ${name}?`,
  confirmLabel: 'Archive',
  variant: 'default',
  option: { label: 'Also remove from groups and contacts', defaultChecked: true },
  onSuccess,
});

it('a request that replaces an open dialog starts from its own defaults, and confirming acts for the one shown', async () => {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <ModalRenderer />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  const first = vi.fn();
  const second = vi.fn();
  archive('Bill', first);
  await until('the first dialog is open', () => optionBox()?.getAttribute('aria-checked') === 'true');
  await userEvent.click(optionBox()!);
  await until('the option is unticked', () => optionBox()?.getAttribute('aria-checked') === 'false');

  archive('Research', second);
  await until('the second dialog is shown', () => document.querySelector('[role="dialog"]')?.textContent?.includes('Archive Research?') === true);
  expect(optionBox()?.getAttribute('aria-checked')).toBe('true');

  const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((b) => b.textContent?.includes('Archive'));
  await userEvent.click(confirm!);
  await until('the modal is closed', () => !modalStore.isOpen);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith(expect.objectContaining({ optionChecked: true }));
});
