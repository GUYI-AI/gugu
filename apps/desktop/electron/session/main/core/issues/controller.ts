import { err } from '@gugu/session-shared';
import { checkSourceConnection as checkProviderConnection } from '@main/core/integrations/connection-statuses';
import { openFolder } from '@main/core/workspaces/folder-runtime/folder-runtimes';
import type {
  IssueContextResult,
  IssueListResult,
  IssueProviderType,
} from '@shared/issue-providers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { IssueContextOpts, IssueQueryOpts, IssueSearchOpts } from './issue-provider';
import { getIssueProvider } from './registry';

const DEFAULT_CAPABILITIES = {
  requiresProjectPath: false,
  requiresRepositoryUrl: false,
  supportsIssueContext: false,
} as const;

async function withResolvedRemote<T extends IssueQueryOpts>(opts: T): Promise<T> {
  if (!opts.folderId) return opts;
  const opened = await openFolder(opts.folderId);
  if (!opened.success) return opts;
  // A directory without Git has no remote: nothing to resolve.
  const repository = (await opened.data.git.open())?.repository;
  if (!repository) return opts;

  const remote = await repository.getBaseRemote().catch(() => undefined);
  const selectedRemote = opts.remote?.trim() || remote;
  const providedRepositoryUrl = opts.repositoryUrl?.trim();

  const remoteRepositoryUrl =
    !providedRepositoryUrl && selectedRemote
      ? (await repository.getRemotes().catch(() => [])).find(
          (candidate) => candidate.name === selectedRemote
        )?.url
      : undefined;
  const repositoryUrl = providedRepositoryUrl ?? remoteRepositoryUrl;

  return { ...opts, remote: selectedRemote, repositoryUrl };
}

export const issueController = createRPCController({
  checkConnection: async (provider: IssueProviderType) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return {
        connected: false,
        error: `Unknown provider: ${provider}`,
        capabilities: DEFAULT_CAPABILITIES,
      };
    }

    return checkProviderConnection(issueProvider);
  },

  searchIssues: async (
    provider: IssueProviderType,
    opts: IssueSearchOpts
  ): Promise<IssueListResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    return issueProvider.searchIssues(await withResolvedRemote(opts));
  },

  getIssueContext: async (
    provider: IssueProviderType,
    opts: IssueContextOpts
  ): Promise<IssueContextResult> => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return err({ type: 'generic', message: `Unknown provider: ${provider}` });
    }

    if (!issueProvider.getIssueContext) {
      return err({ type: 'generic', message: `${provider} does not support issue context.` });
    }

    return issueProvider.getIssueContext(await withResolvedRemote(opts));
  },
});
