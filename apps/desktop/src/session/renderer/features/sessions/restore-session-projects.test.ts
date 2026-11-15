// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: { projectId: 'old', sessionId: 'assistant' },
  screen: null as unknown, update: vi.fn(), restore: vi.fn(), warn: vi.fn(),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: {
  currentViewId: 'library',
  get viewParamsStore() { return { session: state.session }; }, updateViewParams: state.update,
} } }));
vi.mock('@renderer/app/screen-layout', () => ({ screenLayout: { get snapshot() { return state.screen; }, restore: state.restore } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: state.warn } }));

import { restoreSavedScreenSessionLocations, savedScreenSessionIds, reconcileSessionProjectLocations } from './restore-session-projects';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { readSavedScreen, writeSavedScreen } from '@renderer/app/screen-layout-actions';

const locations = [{ conversationId: 'assistant', projectId: 'tasks' }];
const screen = () => ({ layout: { pane: 'first' }, focused: 'first', blocks: { first: { kind: 'session', sessionId: 'assistant', projectId: 'old' } } });
beforeEach(() => {
  localStorage.clear(); viewStateCache.forget('view:'); vi.clearAllMocks(); state.session = { projectId: 'old', sessionId: 'assistant' }; state.screen = screen();
});

it('collects saved layout IDs synchronously for the existing state-read request', () => {
  writeSavedScreen(screen() as never);
  expect(savedScreenSessionIds()).toEqual(['assistant']);
});

it('requests no session rows for a cold start without saved task references', () => {
  expect(savedScreenSessionIds()).toEqual([]);
});

it('repairs only the renderer-owned screen before cold restore', () => {
  writeSavedScreen(screen() as never);
  restoreSavedScreenSessionLocations(locations);
  expect((readSavedScreen()?.blocks as Record<string, { projectId: string }>).first.projectId).toBe('tasks');
});

it('updates remote session references without changing which non-task page the person is reading', () => {
  reconcileSessionProjectLocations(locations);
  expect(state.update).toHaveBeenCalledWith('session', { projectId: 'tasks', sessionId: 'assistant' });
  expect(state.restore).toHaveBeenCalledWith(expect.objectContaining({ blocks: { first: { kind: 'session', projectId: 'tasks', sessionId: 'assistant' } } }));
});
