import type { IFileSystem } from '@gugu/session-core/files';
import { ok } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { getEffectiveSessionSettings } from './effective-session-settings';
import type { ProjectSettingsProvider } from './provider';

function makeProjectSettings(settings: Awaited<ReturnType<ProjectSettingsProvider['get']>>) {
  return {
    get: vi.fn().mockResolvedValue(settings),
  } as unknown as ProjectSettingsProvider;
}

function makeSessionFs(config: unknown | null): Pick<IFileSystem, 'exists' | 'readText'> {
  return {
    exists: vi.fn(async () => ok(config !== null)),
    readText: vi.fn(async () =>
      ok({
        content: JSON.stringify(config),
        truncated: false,
        totalSize: 0,
      })
    ),
  };
}

describe('getEffectiveSessionSettings', () => {
  const sessionConfigPath = '/worktree/.emdash.json';

  it('merges shareable project settings by leaf with project settings winning', async () => {
    const sessionFs = makeSessionFs({
      scripts: { setup: 'pnpm install', run: 'npm run dev' },
      shellSetup: 'source .envrc',
      tmux: true,
      remote: 'upstream',
    });
    const settings = await getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({
        preservePatterns: ['.env.local'],
        scripts: { run: 'pnpm dev' },
      }),
      sessionFs,
      sessionConfigPath,
    });

    expect(sessionFs.exists).toHaveBeenCalledWith(sessionConfigPath);
    expect(sessionFs.readText).toHaveBeenCalledWith(sessionConfigPath);
    expect(settings).toMatchObject({
      preservePatterns: ['.env.local'],
      shellSetup: 'source .envrc',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
      },
    });
    expect(settings).not.toHaveProperty('tmux');
    expect(settings).not.toHaveProperty('remote');
    expect(settings).not.toHaveProperty('baseRemote');
  });

  it.each([
    ['broken JSON', ok({ content: '{', truncated: false, totalSize: 1 }), /Invalid session config \/worktree\/\.emdash\.json: .*JSON/],
    ['a wrong field type', ok({ content: '{"shellSetup":3}', truncated: false, totalSize: 16 }), /shellSetup/],
    ['a truncated read', ok({ content: '{"scripts":', truncated: true, totalSize: 204_801 }), /204801 bytes/],
    ['a failed read', { success: false, error: { type: 'fs-error', path: sessionConfigPath, message: 'EACCES' } }, /cannot read it \(EACCES\)/],
  ] as const)('reports %s in the task config instead of running without it', async (_label, read, message) => {
    await expect(getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({ shellSetup: 'nvm use' }),
      sessionFs: {
        exists: vi.fn(async () => ok(true)),
        readText: vi.fn(async () => read as never),
      },
      sessionConfigPath,
    })).rejects.toThrow(message);
  });

  it('uses defaults plus project settings when the task has no config file', async () => {
    const settings = await getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({ shellSetup: 'nvm use' }),
      sessionFs: makeSessionFs(null),
      sessionConfigPath,
    });
    expect(settings.preservePatterns).toContain('.env');
    expect(settings.shellSetup).toBe('nvm use');
  });
});
