// @vitest-environment jsdom
// The archive notice's 「会话历史」 is a link to 会话历史 (owner 2026-11-12: 「这个会话历史变成点击可跳转的吧」).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enUSSessionWorkflowMessages, zhCNSessionWorkflowMessages } from '@renderer/localization/messages-session-workflows';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.hoisted(() => vi.fn());
const sentence = vi.hoisted(() => ({ current: '' }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate } } }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: { link?: string }) =>
    key === 'task.archivedToastHint' ? sentence.current.replace('{link}', values?.link ?? '') : key === 'sidebar.sessionHistory' ? '会话历史' : key,
}));

const { ArchivedToastHint } = await import('./archived-toast-hint');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  navigate.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the archive notice\'s sentence', () => {
  it('reads as one sentence in each language, with exactly one place for the link', () => {
    for (const messages of [zhCNSessionWorkflowMessages, enUSSessionWorkflowMessages]) {
      expect(messages['task.archivedToastHint'].split('{link}')).toHaveLength(2);
    }
  });

  it('puts 会话历史 in the sentence as a link that opens 会话历史', async () => {
    sentence.current = zhCNSessionWorkflowMessages['task.archivedToastHint'];
    await act(async () => root.render(<ArchivedToastHint />));
    expect(host.textContent).toBe('在「会话历史」里可以找回。');
    const link = host.querySelector<HTMLButtonElement>('[data-archived-toast-history]');
    expect(link?.textContent).toBe('会话历史');
    await act(async () => link!.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith('session-history');
  });

  it('fails loud when a translation lost its link', async () => {
    sentence.current = '在会话历史里可以找回。';
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(act(async () => root.render(<ArchivedToastHint />))).rejects.toThrow('exactly one {link}');
    error.mockRestore();
  });
});
