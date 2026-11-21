// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The task-name suggestion is a command (an LLM call whose answer fills an editable input), fired once per request from
 * an effect: ❌ a cached read keyed by the request. Until the setting is read nothing is asked.
 */
const io = vi.hoisted(() => ({
  settings: null as null | { autoGenerateName: boolean },
  generate: vi.fn(),
}));
vi.mock('@renderer/features/sessions/hooks/useSessionSettings', () => ({
  useSessionSettings: () => ({ settings: io.settings ? { state: 'value', value: io.settings, stale: false, error: null } : { state: 'unknown' }, reload: () => {} }),
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sessionCreate: { generateSessionName: (input: unknown) => io.generate(input) } } }));

import { notifyManager } from '@tanstack/react-query';
import { useCreateSessionState, type CreateSessionState } from './use-create-session-state';

notifyManager.setScheduler((callback) => callback());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: CreateSessionState | null = null;
function Probe({ require = false }: { require?: boolean }) {
  current = useCreateSessionState('project-1', 'workspace-1', undefined, null, { requireGeneratedName: require });
  return null;
}

let root: Root | null = null;
const render = async (node: React.ReactElement) => {
  await act(async () => { root!.render(node); });
};
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

beforeEach(() => {
  io.settings = null;
  io.generate.mockReset().mockResolvedValue('tidy-the-docs');
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useCreateSessionState — the name suggestion', () => {
  it('asks nothing while the setting is not read, and the name is pending meanwhile', async () => {
    await render(<Probe />);
    await settle();
    expect(io.generate).not.toHaveBeenCalled();
    expect(current!.sessionName.isPending).toBe(true);
    expect(current!.isValid).toBe(false);
  });

  it('asks once when the setting says so, fills the name, and does not ask again on a re-render', async () => {
    io.settings = { autoGenerateName: true };
    await render(<Probe />);
    await settle();
    await render(<Probe />);
    await settle();
    expect(io.generate).toHaveBeenCalledTimes(1);
    expect(io.generate).toHaveBeenCalledWith({});
    expect(current!.sessionName.isPending).toBe(false);
    expect(current!.sessionName.effectiveSessionName).toBe('tidy-the-docs');
  });

  it('a box without a name field always gets a generated name, whatever the setting', async () => {
    io.settings = { autoGenerateName: false };
    await render(<Probe require />);
    await settle();
    expect(io.generate).toHaveBeenCalledTimes(1);
    expect(current!.sessionName.effectiveSessionName).toBe('tidy-the-docs');
  });

  it('a failed suggestion leaves the name to fill (not pending forever)', async () => {
    io.settings = { autoGenerateName: true };
    io.generate.mockRejectedValue(new Error('model unavailable'));
    await render(<Probe />);
    await settle();
    expect(current!.sessionName.isPending).toBe(false);
    expect(current!.sessionName.effectiveSessionName).toBe('');
  });
});
