// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AcpStartProgress } from '@gugu/session-core/acp';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({
  progress: undefined as AcpStartProgress['preparation'],
  changed: () => {},
  dispose: vi.fn(),
}));
vi.mock('@renderer/lib/acp/running-sessions', () => ({
  watchRunningSession: async (_id: string, handlers: { onChange(): void }) => {
    state.changed = handlers.onChange;
    return { phase: () => 'starting', preparation: () => state.progress, dispose: state.dispose };
  },
}));
vi.mock('@renderer/localization/use-session-messages', async () => {
  const { zhCNMessages } = await import('@renderer/localization/messages');
  const table = zhCNMessages as Record<string, string>;
  return { useSessionMessages: () => ({ translate: (key: string) => table[key] }) };
});
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
const { CodexPreparationStatus } = await import('./codex-preparation-status');

it('shows 整理历史 with elapsed time during lease recovery and removes it after initialize succeeds', async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  state.progress = { phase: 'history', startedAt: Date.now() - 65_000, attempt: 2 };
  try {
    await act(async () => root.render(<CodexPreparationStatus sessionId="test-session" />));
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('正在整理历史');
    expect(host.textContent).toContain('1:05');
    await act(async () => { state.progress = undefined; state.changed(); });
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
  expect(state.dispose).toHaveBeenCalledTimes(1);
});
