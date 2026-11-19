import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projectSettings, projects } from '@main/db/schema';
import { countProjectsUsingGithubAccount } from './count-projects-using-github-account';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';

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

describe('countProjectsUsingGithubAccount', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('counts only persisted projects pinned to the target account', async () => {
    await fixture.db.insert(projects).values([
      { id: 'project-match-1', name: 'Match 1', path: '/repo/match-1' as CanonicalPath },
      { id: 'project-match-2', name: 'Match 2', path: '/repo/match-2' as CanonicalPath },
      { id: 'project-null', name: 'Null', path: '/repo/null' as CanonicalPath },
      { id: 'project-other', name: 'Other', path: '/repo/other' as CanonicalPath },
      { id: 'project-unconfigured', name: 'Unconfigured', path: '/repo/unconfigured' as CanonicalPath },
    ]);
    await fixture.db.insert(projectSettings).values([
      {
        projectId: 'project-match-1',
        baseProjectSettingsJson: baseSettingsJson(TARGET_ACCOUNT_ID),
      },
      {
        projectId: 'project-match-2',
        baseProjectSettingsJson: baseSettingsJson(` ${TARGET_ACCOUNT_ID} `),
      },
      {
        projectId: 'project-null',
        baseProjectSettingsJson: baseSettingsJson(null),
      },
      {
        projectId: 'project-other',
        baseProjectSettingsJson: baseSettingsJson(OTHER_ACCOUNT_ID),
      },
      {
        projectId: 'project-unconfigured',
        baseProjectSettingsJson: baseSettingsJson(),
      },
    ]);

    await expect(countProjectsUsingGithubAccount(TARGET_ACCOUNT_ID)).resolves.toBe(2);
    await expect(countProjectsUsingGithubAccount(OTHER_ACCOUNT_ID)).resolves.toBe(1);
    await expect(countProjectsUsingGithubAccount('github.com:missing')).resolves.toBe(0);
  });

  it('skips malformed base settings JSON', async () => {
    await fixture.db.insert(projects).values([
      { id: 'project-malformed', name: 'Malformed', path: '/repo/malformed' as CanonicalPath },
      { id: 'project-valid', name: 'Valid', path: '/repo/valid' as CanonicalPath },
    ]);
    await fixture.db.insert(projectSettings).values([
      {
        projectId: 'project-malformed',
        baseProjectSettingsJson: '{not-json',
      },
      {
        projectId: 'project-valid',
        baseProjectSettingsJson: baseSettingsJson(TARGET_ACCOUNT_ID),
      },
    ]);

    await expect(countProjectsUsingGithubAccount(TARGET_ACCOUNT_ID)).resolves.toBe(1);
  });
});
