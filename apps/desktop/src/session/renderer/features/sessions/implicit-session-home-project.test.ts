import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureTaskHome: vi.fn<(machine: string | null) => Promise<string>>(),
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ ensureTaskHome: mocks.ensureTaskHome }),
}));

const { ensureImplicitSessionHomeProjectId, ImplicitSessionHomeProjectError } =
  await import('./implicit-session-home-project');

describe('ensureImplicitSessionHomeProjectId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is this computer’s task home, as its host records it', async () => {
    mocks.ensureTaskHome.mockResolvedValue('task-home-here');

    await expect(ensureImplicitSessionHomeProjectId()).resolves.toBe('task-home-here');

    expect(mocks.ensureTaskHome).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('fails with a stable reason and the host’s own diagnostic', async () => {
    mocks.ensureTaskHome.mockRejectedValue(new Error('disk full'));

    const failure = await ensureImplicitSessionHomeProjectId().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImplicitSessionHomeProjectError);
    expect(failure).toMatchObject({ reason: 'open-failed', detail: 'disk full' });
  });
});
