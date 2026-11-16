import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { i18n, setLocalePreference } from '@/i18n';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@/mobile/phone-shell.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble');
  return { useAppSettingsKey: () => fakeAppSettings({}) };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const previousLanguage = i18n.language;
const previousClass = document.body.className;

afterEach(async () => {
  modalStore.closeModal();
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.body.className = previousClass;
  document.documentElement.removeAttribute('data-phone-shell');
  setLocalePreference(previousLanguage === 'zh-CN' ? 'zh-CN' : 'en-US');
});

async function mount(locale: 'zh-CN' | 'en-US', width: number, phone = false) {
  await page.viewport(width, 844);
  document.documentElement.toggleAttribute('data-phone-shell', phone);
  setLocalePreference(locale);
  document.body.classList.add('gugu-skin', 'emlight');
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  root.render(<QueryClientProvider client={new QueryClient()}>
    <SessionLocalizationProvider><ModalRenderer /></SessionLocalizationProvider>
  </QueryClientProvider>);
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')];
async function settled() {
  await until('dialog footer mounted', () => buttons().length === 2);
  await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  for (const action of ['save', 'discard'] as const) {
    it(`${locale}: focuses Save before an explicit ${action} and preserves the filename`, async () => {
      await mount(locale, 1100);
      const onSuccess = vi.fn();
      const fileName = '计划 <draft> & notes.md';
      showModal('unsavedChangesModal', { fileName, onSuccess });
      await settled();
      const [discard, save] = buttons();
      await until('safe initial focus', () => document.activeElement === save);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(locale === 'zh-CN' ? '未保存的更改' : 'Unsaved changes');
      expect(document.querySelector('[data-slot="dialog-content"] strong')?.textContent).toBe(fileName);
      expect(discard.textContent).toBe(locale === 'zh-CN' ? '不保存' : 'Discard');
      expect(save.textContent).toBe(locale === 'zh-CN' ? '保存' : 'Save');
      if (action === 'save') await userEvent.keyboard('{Enter}');
      else await userEvent.click(discard);
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(action);
      expect(modalStore.isOpen).toBe(false);
    });
  }
}

it.each([
  ['zh-CN', 1100, false],
  ['en-US', 1100, false],
  ['zh-CN', 390, true],
  ['en-US', 360, true],
] as const)('%s at %ipx: confirmation touch targets and shortcuts follow the shell', async (locale, width, phone) => {
  await mount(locale, width, phone);
  showModal('confirmActionModal', {
    title: translateSessionMessage('task.archiveTaskTitle'),
    description: translateSessionMessage('task.archiveSessionDescription'),
    confirmLabel: translateSessionMessage('task.archiveTaskConfirm'),
    variant: 'default',
  });
  await settled();
  expect(document.querySelector('[data-slot="dialog-content"]')?.textContent).toContain(locale === 'zh-CN'
    ? '智能体将从列表中隐藏并停止运行。不会删除任何内容。'
    : 'The agent is hidden from the list and stops running. Nothing is deleted.');
  for (const button of buttons()) {
    const rect = button.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBe(phone ? 44 : 32);
  }
  const keycaps = [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-footer"] [data-slot="kbd"]')];
  expect(keycaps.length).toBeGreaterThan(0);
  expect(keycaps.some(keycap => keycap.getClientRects().length > 0)).toBe(!phone);
});
