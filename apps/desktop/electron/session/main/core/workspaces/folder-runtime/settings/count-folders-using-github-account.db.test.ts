import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { workspaceSettings } from '@main/db/schema';
import { countFoldersUsingGithubAccount } from './count-folders-using-github-account';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const TARGET_ACCOUNT_ID = 'github.com:42';
const OTHER_ACCOUNT_ID = 'github.com:99';

function baseSettingsJson(githubAccountId?: string | null): string {
  const settings: Record<string, unknown> = {
    defaultBranch: 'main',
    baseRemote: 'origin',
  };
  if (githubAccountId !== undefined) {
    settings.githubAccountId = githubAccountId;
  }
  return JSON.stringify(settings);
}

describe('countFoldersUsingGithubAccount', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('counts only folders pinned to the target account', async () => {
    await fixture.db.insert(workspaceSettings).values([
      {
        workspaceId: 'folder-match-1',
        baseSettingsJson: baseSettingsJson(TARGET_ACCOUNT_ID),
      },
      {
        workspaceId: 'folder-match-2',
        baseSettingsJson: baseSettingsJson(` ${TARGET_ACCOUNT_ID} `),
      },
      {
        workspaceId: 'folder-null',
        baseSettingsJson: baseSettingsJson(null),
      },
      {
        workspaceId: 'folder-other',
        baseSettingsJson: baseSettingsJson(OTHER_ACCOUNT_ID),
      },
      {
        workspaceId: 'folder-unconfigured',
        baseSettingsJson: baseSettingsJson(),
      },
    ]);

    await expect(countFoldersUsingGithubAccount(TARGET_ACCOUNT_ID)).resolves.toBe(2);
    await expect(countFoldersUsingGithubAccount(OTHER_ACCOUNT_ID)).resolves.toBe(1);
    await expect(countFoldersUsingGithubAccount('github.com:missing')).resolves.toBe(0);
  });

  it('skips malformed base settings JSON', async () => {
    await fixture.db.insert(workspaceSettings).values([
      {
        workspaceId: 'folder-malformed',
        baseSettingsJson: '{not-json',
      },
      {
        workspaceId: 'folder-valid',
        baseSettingsJson: baseSettingsJson(TARGET_ACCOUNT_ID),
      },
    ]);

    await expect(countFoldersUsingGithubAccount(TARGET_ACCOUNT_ID)).resolves.toBe(1);
  });
});
