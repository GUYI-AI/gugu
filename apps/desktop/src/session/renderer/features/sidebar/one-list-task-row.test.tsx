// @vitest-environment jsdom
// GUYI-AI/gugu#2548 a standalone task whose session has no 咕咕 identity, in the one list: the conversation row it would
// be, wearing the session's own avatar and status, opening the task as its sidebar row always did.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  nodeById: new Map([['pty-1', { item: { title: 'Fix the build', time: Date.parse('2026-11-10T09:00:00Z'), presentation: { tone: 'running' } } }]]),
  navigation: { currentViewId: 'session', viewParamsStore: { session: { projectId: 'workspace', sessionId: 'pty-1' } } as Record<string, unknown> },
  open: vi.fn(),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: state.navigation },
  sidebarStore: { placement: { nodeById: state.nodeById } },
}));
vi.mock('./sidebar-session-item', () => ({ openSidebarSession: state.open }));
vi.mock('@/mobile/agent-watch/StatusGlyph', () => ({
  SessionAvatar: ({ sessionId, presentation }: { sessionId: string; presentation: { tone: string } | null }) => (
    <span data-avatar={sessionId} data-tone={presentation?.tone} />
  ),
}));

const { OneListTaskRow } = await import('./one-list-task-row');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.open.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('is a two-line list row: the session\'s avatar and status, its title, when it was last used; open = selected', async () => {
  await act(async () => root.render(<OneListTaskRow projectId="workspace" sessionId="pty-1" />));
  const row = host.querySelector<HTMLElement>('[data-slot="list-row"]')!;
  expect(row.dataset.taskRow).toBe('pty-1');
  expect(row.dataset.selected).toBe('true');
  expect(row.querySelector('.gg-list-row-leading [data-avatar="pty-1"]')!.getAttribute('data-tone')).toBe('running');
  expect(row.querySelector('.gg-list-row-title')!.textContent).toBe('Fix the build');
  expect(row.querySelector('.gg-list-row-meta')!.textContent).not.toBe('');
  expect(row.querySelectorAll('.gg-list-row-line')).toHaveLength(2);
});

it('a click opens the task, a ⌘ click opens it beside', async () => {
  await act(async () => root.render(<OneListTaskRow projectId="workspace" sessionId="pty-1" />));
  const row = host.querySelector<HTMLElement>('[data-slot="list-row"]')!;
  await act(async () => row.click());
  await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })); });
  expect(state.open.mock.calls).toEqual([['workspace', 'pty-1', false], ['workspace', 'pty-1', true]]);
});

it('draws nothing once the sidebar no longer holds the session', async () => {
  await act(async () => root.render(<OneListTaskRow projectId="workspace" sessionId="gone" />));
  expect(host.querySelector('[data-slot="list-row"]')).toBeNull();
});
