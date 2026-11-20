import { err, ok, type Result } from '@gugu/session-shared';
import type { GitHubApiAuthContext } from '@main/core/github/services/github-api-auth-service';
import type { ProjectSettingsProvider } from '@main/core/projects/settings/provider';

export type ProjectGitHubAuthContextError =
  | {
      type: 'project_not_found';
      projectId: string;
      message: string;
    }
  | {
      type: 'unconfigured';
      projectId: string;
      message: string;
    }
  | {
      type: 'disabled';
      projectId: string;
      message: string;
    }
  | {
      type: 'account_selection_failed';
      projectId: string;
      message: string;
    };

type ProjectGitHubAuthContextProject = {
  settings: Pick<ProjectSettingsProvider, 'get'>;
};

type ProjectLookup = {
  getProject(projectId: string): ProjectGitHubAuthContextProject | undefined;
};

type WarningLogger = {
  warn(message: string, context: Record<string, unknown>): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProjectGitHubAuthContextResolver {
  constructor(
    private readonly deps: {
      projects: ProjectLookup;
      logger: WarningLogger;
    }
  ) {}

  async resolve(
    projectId: string
  ): Promise<Result<GitHubApiAuthContext, ProjectGitHubAuthContextError>> {
    const project = this.deps.projects.getProject(projectId);
    if (!project) {
      return err({
        type: 'project_not_found',
        projectId,
        message: `Project ${projectId} is not mounted.`,
      });
    }

    try {
      const settings = await project.settings.get();
      // null is the person's 「不用 GitHub」 for this project. Otherwise its account is the password vault's grant to it
      // (`host:github:project:<id>`), else the connector's current one: resolved per request (GitHubApiAuthService).
      if (settings.githubAccountId === null) {
        return err({
          type: 'disabled',
          projectId,
          message: 'GitHub API is disabled for this project.',
        });
      }
      return ok({ projectId });
    } catch (error) {
      const message = errorMessage(error);
      this.deps.logger.warn('Failed to resolve project GitHub account selection', {
        projectId,
        error: message,
      });
      return err({
        type: 'account_selection_failed',
        projectId,
        message,
      });
    }
  }
}
