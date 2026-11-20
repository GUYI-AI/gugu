import { err, ok } from '@gugu/session-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '@shared/core/project-settings/project-settings';
import {
  ProjectGitHubAuthContextResolver,
  type ProjectGitHubAuthContextError,
} from './project-github-auth-context-resolver';

type FakeProject = {
  settings: { get(): Promise<ProjectSettings> };
};

class FakeProjectLookup {
  private readonly projects = new Map<string, FakeProject>();

  setProject(projectId: string, project: FakeProject): void {
    this.projects.set(projectId, project);
  }

  getProject(projectId: string): FakeProject | undefined {
    return this.projects.get(projectId);
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

describe('ProjectGitHubAuthContextResolver', () => {
  let projects: FakeProjectLookup;
  let logger: FakeLogger;
  let resolver: ProjectGitHubAuthContextResolver;

  beforeEach(() => {
    projects = new FakeProjectLookup();
    logger = new FakeLogger();
    resolver = new ProjectGitHubAuthContextResolver({
      projects,
      logger,
    });
  });

  it('resolves to the project: its own pick in the password vault, else the connector\'s current account', async () => {
    projects.setProject('project-1', makeProject({}));
    projects.setProject('project-2', makeProject({ githubAccountId: 'github.com:42' }));

    await expect(resolver.resolve('project-1')).resolves.toEqual(ok({ projectId: 'project-1' }));
    // A pick from before the vault is moved into it when the project mounts; it does not choose here.
    await expect(resolver.resolve('project-2')).resolves.toEqual(ok({ projectId: 'project-2' }));
  });

  it('reports disabled when the project settings explicitly clear the selected GitHub account', async () => {
    projects.setProject('project-1', makeProject({ githubAccountId: null }));

    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<ProjectGitHubAuthContextError>({
        type: 'disabled',
        projectId: 'project-1',
        message: 'GitHub API is disabled for this project.',
      })
    );
  });

  it('fails when the project is not mounted instead of silently falling back', async () => {
    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<ProjectGitHubAuthContextError>({
        type: 'project_not_found',
        projectId: 'project-1',
        message: 'Project project-1 is not mounted.',
      })
    );
  });

  it('fails when account selection cannot be resolved instead of silently falling back', async () => {
    const project = makeProject();
    vi.mocked(project.settings.get).mockRejectedValue(new Error('settings failed'));
    projects.setProject('project-1', project);

    await expect(resolver.resolve('project-1')).resolves.toEqual(
      err<ProjectGitHubAuthContextError>({
        type: 'account_selection_failed',
        projectId: 'project-1',
        message: 'settings failed',
      })
    );
    expect(logger.warn).toHaveBeenCalledWith('Failed to resolve project GitHub account selection', {
      projectId: 'project-1',
      error: 'settings failed',
    });
  });
});
