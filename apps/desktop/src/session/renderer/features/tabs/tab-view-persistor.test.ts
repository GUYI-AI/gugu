import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTabPersistor } from '@renderer/features/sessions/stores/session-tab-view-persistor';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import type { TabGroupsSnapshot } from '@shared/view-state';
import { TabViewPersistor } from './tab-view-persistor';

const write = vi.spyOn(viewStateCache, 'write');

const sessionCtx = {
  viewId: 'persist-test', projectId: 'p', workspaceId: 'w', sessionId: 'persist-test',
  modelRootPath: 'workspace:w', workspacePath: '/workspace',
};
const snapshot: TabGroupsSnapshot = {
  groups: [{ groupId: 'g', tabManager: {
    tabs: [{ kind: 'file-view', tabId: 'f', path: 'notes.md', history: { pages: [{ kind: 'file-view', state: { path: 'notes.md' } }], index: 0 } }],
    activeTabId: 'f',
  } }],
  activeGroupId: 'g', paneSizes: [100],
};

afterEach(() => {
  for (const key of ['session:persist-test', 'session:persist-test:tabs', 'chat:persist-test:tabs']) viewStateCache.write(key, undefined);
  write.mockClear();
});

describe('view-scoped tab persistence', () => {
  it.each(['session', 'chat'])('loads and registers the %s namespace without changing its snapshot', (kind) => {
    const key = `${kind}:persist-test:tabs`;
    const persistor = new TabViewPersistor(`${kind}:persist-test`);
    expect(persistor.load()).toBeNull();
    viewStateCache.write(key, snapshot);
    write.mockClear();
    const stop = persistor.start(() => snapshot);
    expect(persistor.load()).toBe(snapshot);
    expect(write).not.toHaveBeenCalled();
    stop();
    expect(viewStateCache.read(key), 'kept for the next start').toBe(snapshot);
  });

  it('does not interpret another host\'s aggregate as a task snapshot', () => {
    expect(new TabViewPersistor('chat:persist-test').load({ tabGroups: snapshot })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('retains the existing task key and normalizes file paths without changing return navigation', () => {
    viewStateCache.write('session:persist-test:tabs', snapshot);
    write.mockClear();
    const loaded = createSessionTabPersistor(sessionCtx).load();
    expect(loaded?.groups[0].tabManager.tabs[0]).toEqual({
      kind: 'file-view', tabId: 'f', path: '/workspace/notes.md', history: { pages: [{ kind: 'file-view', state: { path: 'notes.md' } }], index: 0 },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { tabGroups: snapshot },
    { tabManager: snapshot.groups[0].tabManager },
    { sessions: { tabOrder: ['s1'] } },
  ])('keeps the existing task aggregate migration %#', (aggregate) => {
    viewStateCache.write('session:persist-test', aggregate);
    write.mockClear();
    const loaded = createSessionTabPersistor(sessionCtx).load();
    expect(loaded?.groups).toHaveLength(1);
    expect(loaded?.groups[0].tabManager.tabs).toHaveLength(1);
    expect(write).toHaveBeenCalledWith('session:persist-test:tabs', viewStateCache.read('session:persist-test:tabs'));
  });

  it('prefers the dedicated task snapshot to a supplied legacy aggregate', () => {
    viewStateCache.write('session:persist-test:tabs', snapshot);
    write.mockClear();
    const loaded = createSessionTabPersistor(sessionCtx).load({ sessions: { tabOrder: ['old'] } });
    expect(loaded?.groups[0].tabManager.activeTabId).toBe('f');
    expect(write).not.toHaveBeenCalled();
  });
});
