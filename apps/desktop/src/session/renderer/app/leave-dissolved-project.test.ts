// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// #2548 a project whose group was dissolved: real navigation, screen layout and screen actions.
import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { ensureScreenLayoutSync, leaveDissolvedProject, showBesideOnScreen, showOnScreen } from '@renderer/app/screen-layout-actions';

beforeAll(() => {
  // jsdom has no CSS.escape; placing a block beside measures the focused block's element by its id.
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  for (const view of ['home', 'project', 'session', 'chat', 'screen'] as const) appState.navigation.registerView(view);
  ensureScreenLayoutSync();
});

afterEach(() => {
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  appState.navigation.navigate('home');
});

describe('leaving a project whose group was dissolved', () => {
  it('takes its block off the screen and goes home when it was the project being looked at', () => {
    showOnScreen({ kind: 'project', projectId: 'dissolved' });
    expect(appState.navigation.currentViewId).toBe('project');

    leaveDissolvedProject('dissolved');

    expect([...screenLayout.blocks.values()]).toEqual([]);
    // Not left on the project's page with a blank block (its first tab was the group).
    expect(appState.navigation.currentViewId).toBe('home');
  });

  it('follows the block left on screen instead of going home', () => {
    showOnScreen({ kind: 'chat', chatId: 'other-chat' });
    showBesideOnScreen({ kind: 'project', projectId: 'dissolved' });
    expect(appState.navigation.currentViewId).toBe('project');

    leaveDissolvedProject('dissolved');

    expect([...screenLayout.blocks.values()]).toEqual([{ kind: 'chat', chatId: 'other-chat' }]);
    expect(appState.navigation.currentViewId).toBe('chat');
  });

  it('leaves the project being looked at alone when another project was dissolved', () => {
    showOnScreen({ kind: 'project', projectId: 'kept' });

    leaveDissolvedProject('dissolved');

    expect([...screenLayout.blocks.values()]).toEqual([{ kind: 'project', projectId: 'kept' }]);
    expect(appState.navigation.currentViewId).toBe('project');
    expect((appState.navigation.viewParamsStore.project as { projectId?: string }).projectId).toBe('kept');
  });
});
