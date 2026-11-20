// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CodexPreparation } from '@gugu/core/local/codex-initialize.mjs';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key === 'transcript.historyPreparing' ? '正在整理历史' : '正在准备' }),
}));
const { useCodexPreparationNotice } = await import('./use-codex-preparation-notice');
function Notice({ preparation }: { preparation?: CodexPreparation }) {
  const notice = useCodexPreparationNotice(preparation);
  return notice ? <div role="status">{notice}</div> : null;
}
afterEach(() => vi.useRealTimers());

it('shows the native phase and elapsed time, then removes the notice at the terminal result', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(123_000);
  const host = document.createElement('div');
  const root = createRoot(host);
  const preparation: CodexPreparation = { phase: 'preparing', startedAt: 58_000, attempt: 1 };
  try {
    await act(async () => root.render(<Notice preparation={preparation} />));
    expect(host.textContent).toBe('正在准备 · 1:05');
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(host.textContent).toBe('正在准备 · 1:07');
    await act(async () => root.render(<Notice preparation={{ ...preparation, phase: 'history', attempt: 2 }} />));
    expect(host.textContent).toBe('正在整理历史 · 1:07');
    await act(async () => root.render(<Notice />));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally { await act(async () => root.unmount()); }
});
