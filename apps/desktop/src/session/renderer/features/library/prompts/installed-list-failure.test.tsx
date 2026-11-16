// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * What is installed could not be read (review C-6): the surfaces that wait on it say so with a retry, ❌ a placeholder
 * for ever. The prompt library still draws the person's own prompts; an App's page in its own window says the failure.
 */
const failure = new Error('installed list unreadable');
vi.mock('@renderer/features/extensions/installed-extensions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useInstalledApps: () => ({ state: 'error', error: failure }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn(), showModal: vi.fn() }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('./use-prompt-library', () => ({
  usePromptLibrary: () => ({ value: [], overrides: {}, isLoading: false, isSaving: false, error: null, hasData: true, reload: vi.fn() }),
  deletePrompt: vi.fn(), overridePrompt: vi.fn(), savePrompt: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function probe<T>(hook: () => T): T {
  let seen: T | undefined;
  const Probe = () => { seen = hook(); return null; };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return seen as T;
}

describe('the installed list could not be read', () => {
  it('the prompt library knows the Apps\' prompts failed (❌ waits for them for ever)', async () => {
    const { usePromptLibraryActions } = await import('./use-prompt-library-actions');
    const actions = probe(() => usePromptLibraryActions());
    expect(actions.appPrompts).toBeNull();
    expect(actions.appPromptsFailed).toBe(failure);
  });

  it('an App page tab reports the failure with its unknown contribution', async () => {
    const { useAppPageTab } = await import('@renderer/features/extensions/extension-tab-provider');
    const tab = probe(() => useAppPageTab({ title: null } as never, 'ext:app/main'));
    expect(tab).toMatchObject({ contribution: null, failed: failure });
  });
});
