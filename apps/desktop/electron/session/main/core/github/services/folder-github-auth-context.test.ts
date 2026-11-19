import { err, ok } from '@gugu/session-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '@shared/core/project-settings/project-settings';
import {
  FolderGitHubAuthContextResolver,
  type FolderGitHubAuthContextError,
} from './folder-github-auth-context-resolver';

type FakeProject = {
  settings: { get(): Promise<ProjectSettings> };
};

class FakeProjectLookup {
  private readonly projects = new Map<string, FakeProject>();

  setProject(folderId: string, project: FakeProject): void {
    this.projects.set(folderId, project);
  }

  getProject(folderId: string): FakeProject | undefined {
    return this.projects.get(folderId);
  }
}

class FakeLogger {
  warn = vi.fn();
}

function makeProject(settings: ProjectSettings = {}): FakeProject {
  return {
    settings: { get: vi.fn().mockResolvedValue(settings) },
  };
}

describe('FolderGitHubAuthContextResolver', () => {
  let projects: FakeProjectLookup;
  let logger: FakeLogger;
  let resolver: FolderGitHubAuthContextResolver;

  beforeEach(() => {
    projects = new FakeProjectLookup();
    logger = new FakeLogger();
    resolver = new FolderGitHubAuthContextResolver({
      openFolder: async (folderId) => projects.getProject(folderId),
      logger,
    });
  });

  it('resolves the selected account from project settings for a mounted project', async () => {
    const project = makeProject({ githubAccountId: ' github.com:42 ' });
    projects.setProject('project-1', project);

    await expect(resolver.resolve('project-1')).resolves.toEqual(
      ok({ accountId: 'github.com:42' })
    );
  });

  it('reports unconfigured when the project settings have no selected GitHub account', async () => {
    projects.setProject('project-1', makeProject({}));

    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<FolderGitHubAuthContextError>({
        type: 'unconfigured',
        folderId: 'project-1',
        message: 'No GitHub account is configured for this folder.',
      })
    );
  });

  it('reports disabled when the project settings explicitly clear the selected GitHub account', async () => {
    projects.setProject('project-1', makeProject({ githubAccountId: null }));

    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<FolderGitHubAuthContextError>({
        type: 'disabled',
        folderId: 'project-1',
        message: 'GitHub API is disabled for this folder.',
      })
    );
  });

  it('fails when the folder cannot be opened instead of silently falling back', async () => {
    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<FolderGitHubAuthContextError>({
        type: 'folder_not_found',
        folderId: 'project-1',
        message: 'Folder project-1 could not be opened.',
      })
    );
  });

  it('fails when account selection cannot be resolved instead of silently falling back', async () => {
    const project = makeProject();
    vi.mocked(project.settings.get).mockRejectedValue(new Error('settings failed'));
    projects.setProject('project-1', project);

    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<FolderGitHubAuthContextError>({
        type: 'account_selection_failed',
        folderId: 'project-1',
        message: 'settings failed',
      })
    );
    expect(logger.warn).toHaveBeenCalledWith('Failed to resolve folder GitHub account selection', {
      folderId: 'project-1',
      error: 'settings failed',
    });
  });
});
