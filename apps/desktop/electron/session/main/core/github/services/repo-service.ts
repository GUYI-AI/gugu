import type { Octokit } from '@octokit/rest';
import type { GitHubApiAuthContext } from './github-api-auth-service';
import { GitHubApiAuthErrorException, getOctokit } from './octokit-provider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubOwner {
  login: string;
  type: 'User' | 'Organization';
}

export interface GitHubRepositoryService {
  getOwners(authContext?: GitHubApiAuthContext): Promise<GitHubOwner[]>;
  createRepository(params: {
    name: string;
    description?: string;
    owner: string;
    isPrivate: boolean;
    authContext?: GitHubApiAuthContext;
  }): Promise<{ url: string; cloneUrl: string; defaultBranch: string; nameWithOwner: string }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GitHubRepositoryServiceImpl implements GitHubRepositoryService {
  constructor(
    private readonly getOctokit: (
      host: string,
      authContext?: GitHubApiAuthContext
    ) => Promise<Octokit>
  ) {}

  async getOwners(authContext: GitHubApiAuthContext = {}): Promise<GitHubOwner[]> {
    const octokit = await this.getOctokit(this.hostForAuthContext(authContext), authContext);
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const owners: GitHubOwner[] = [{ login: user.login, type: 'User' }];

    try {
      const { data: orgs } = await octokit.rest.orgs.listForAuthenticatedUser();
      for (const org of orgs) {
        owners.push({ login: org.login, type: 'Organization' });
      }
    } catch {}

    return owners;
  }

  async createRepository(params: {
    name: string;
    description?: string;
    owner: string;
    isPrivate: boolean;
    authContext?: GitHubApiAuthContext;
  }): Promise<{ url: string; cloneUrl: string; defaultBranch: string; nameWithOwner: string }> {
    const octokit = await this.getOctokit(
      this.hostForAuthContext(params.authContext ?? {}),
      params.authContext
    );
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const isCurrentUser = params.owner === user.login;

    const createParams = {
      name: params.name,
      description: params.description,
      private: params.isPrivate,
    };

    const { data } = isCurrentUser
      ? await octokit.rest.repos.createForAuthenticatedUser(createParams)
      : await octokit.rest.repos.createInOrg({ ...createParams, org: params.owner });

    return {
      url: data.html_url,
      cloneUrl: data.clone_url,
      defaultBranch: data.default_branch || 'main',
      nameWithOwner: data.full_name,
    };
  }

  private hostForAuthContext(authContext: GitHubApiAuthContext): string {
    const accountId = authContext.accountId?.trim();
    if (!accountId) return 'github.com';
    return accountId.split(':')[0] || 'github.com';
  }
}

export const repoService = new GitHubRepositoryServiceImpl(async (host, authContext = {}) => {
  const octokit = await getOctokit(host, authContext);
  if (!octokit.success) throw new GitHubApiAuthErrorException(octokit.error);
  return octokit.data;
});
