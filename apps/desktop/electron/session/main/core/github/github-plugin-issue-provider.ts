import type { IssuesPluginProvider } from '@gugu/session-plugins/issues';
import { err, ok, type Result } from '@gugu/session-shared';
import { match, P } from 'ts-pattern';
import { GITHUB_PROVIDER_ID } from '@main/core/github/accounts/github-accounts';
import { githubVaultAccountStore } from '@main/core/github/accounts/github-vault-accounts';
import type { GitHubApiAuthContext } from '@main/core/github/services/github-api-auth-service';
import { githubApiAuthService } from '@main/core/github/services/github-api-auth-service-instance';
import { githubApiBaseUrlForHost } from '@main/core/github/services/github-api-base-url';
import { githubRepositoryResolver } from '@main/core/github/services/github-repository-resolver';
import { resolveProjectGitHubAuthContext } from '@main/core/github/services/project-github-auth-context';
import {
  clampIssueProviderLimit,
  DEFAULT_SEARCH_LIMIT,
  toIssueProviderCapabilities,
  toLinkedIssue,
} from '@main/core/issues/plugin-issue-adapter';
import { log } from '@main/lib/logger';
import {
  type IssueListError,
  type IssueListResult,
  type IssueProviderCapabilities,
} from '@shared/issue-providers';
import type { RepositoryRef } from '@shared/repository-ref';
import type { IssueProvider, IssueSearchOpts } from '../issues/issue-provider';

async function resolveIssueAuthContext(
  projectId: string | undefined
): Promise<Result<GitHubApiAuthContext | undefined, IssueListError>> {
  if (!projectId) return ok(undefined);
  const authContext = await resolveProjectGitHubAuthContext(projectId);
  if (authContext.success) return ok(authContext.data);
  if (authContext.error.type === 'unconfigured') {
    return err({ type: 'no_account_selected', message: authContext.error.message });
  }
  if (authContext.error.type === 'disabled') {
    return err({ type: 'account_disabled', message: authContext.error.message });
  }
  return err({
    type: 'generic',
    message: `Unable to resolve GitHub account for project: ${authContext.error.message}`,
  });
}

async function resolveRepository(opts: {
  repositoryUrl?: string;
  remote?: string;
}): Promise<Result<RepositoryRef, IssueListError>> {
  const resolved = await githubRepositoryResolver.resolve(opts.repositoryUrl || opts.remote);
  if (resolved.success) return ok(resolved.data);

  const error = match(resolved.error)
    .returnType<IssueListError>()
    .with({ type: 'not_parseable' }, () => ({
      type: 'invalid_input',
      message: 'Repository URL is required.',
    }))
    .with({ type: 'not_github' }, (e) => ({
      type: 'unsupported_host',
      message: `Remote host "${e.host}" does not appear to be GitHub or GitHub Enterprise.`,
    }))
    .with(P.union({ type: 'host_unreachable' }, { type: 'host_error' }), (e) => ({
      type: 'host_unreachable',
      message: e.reason,
    }))
    .exhaustive();
  return err(error);
}

/** The plugin gets a `fetch` that the password vault answers with the chosen GitHub credential; never a token. */
async function resolveGitHubPluginCredentials(
  repository: RepositoryRef,
  authContext: GitHubApiAuthContext | undefined
): Promise<Result<{ fetch: typeof fetch; apiBaseUrl: string }, IssueListError>> {
  const auth = await githubApiAuthService.resolve(repository.host, authContext);
  if (!auth.success) return err(auth.error);
  return ok({ fetch: auth.data.fetch, apiBaseUrl: githubApiBaseUrlForHost(repository.host) });
}

async function getDefaultLinkedAccountConnection(capabilities: IssueProviderCapabilities) {
  const auth = await githubApiAuthService.resolve('github.com');
  if (!auth.success) return null;
  return {
    connected: true,
    displayName: auth.data.account.login,
    capabilities,
  };
}

export function createGitHubPluginIssueProvider(plugin: IssuesPluginProvider): IssueProvider {
  const capabilities = toIssueProviderCapabilities(plugin);
  const pluginLog = log.child({ integration: 'github' });

  async function search(opts: IssueSearchOpts): Promise<IssueListResult> {
    const repository = await resolveRepository(opts);
    if (!repository.success) return repository;

    const authContext = await resolveIssueAuthContext(opts.projectId);
    if (!authContext.success) return err(authContext.error);

    const credentials = await resolveGitHubPluginCredentials(repository.data, authContext.data);
    if (!credentials.success) return err(credentials.error);

    const host = { log: pluginLog, credentials: { apiBaseUrl: credentials.data.apiBaseUrl }, fetch: credentials.data.fetch };
    const behavior = plugin.behavior.issues;
    if (!behavior) throw new Error('github issues plugin has no issues behavior registered');
    const result = await behavior.searchIssues(host, {
      limit: clampIssueProviderLimit(opts.limit, DEFAULT_SEARCH_LIMIT),
      searchTerm: opts.searchTerm,
      repositoryUrl: repository.data.repositoryUrl,
    });

    if (!result.success) return err(result.error);

    return ok(result.data.map((issue) => toLinkedIssue('github', issue)));
  }

  return {
    type: 'github',
    capabilities,
    isConfigured: async () =>
      (await githubVaultAccountStore.listAccounts(GITHUB_PROVIDER_ID)).length > 0,
    checkConnection: async () => {
      const linkedAccountConnection = await getDefaultLinkedAccountConnection(capabilities);
      if (linkedAccountConnection) return linkedAccountConnection;
      return {
        connected: false,
        displayName: undefined,
        capabilities,
      };
    },
    searchIssues: (opts: IssueSearchOpts) => {
      if (!String(opts.searchTerm || '').trim()) return Promise.resolve(ok([]));
      return search(opts);
    },
  };
}
