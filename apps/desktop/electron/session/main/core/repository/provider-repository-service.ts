import { err, Result } from '@gugu/session-shared/result';
import { match } from 'ts-pattern';
import { githubRepositoryResolver } from '@main/core/github/services/github-repository-resolver';
import { openFolder } from '@main/core/workspaces/folder-runtime/folder-runtimes';
import type { ProviderRepositoryResult } from '@shared/provider-repository';

export class ProviderRepositoryService {
  async resolveFolder(folderId: string): Promise<ProviderRepositoryResult> {
    const opened = await openFolder(folderId);
    if (!opened.success) return err({ type: 'no_remote' });
    const folder = opened.data;

    const remoteState = await folder.getRemoteState();
    if (!remoteState.hasRemote) return err({ type: 'no_remote' });
    if (!remoteState.selectedRemoteUrl) return err({ type: 'invalid_remote' });

    return Result.fromAsync(githubRepositoryResolver.resolve(remoteState.selectedRemoteUrl))
      .map((repo) => ({
        provider: 'github' as const,
        host: repo.host,
        repositoryUrl: repo.repositoryUrl,
        nameWithOwner: repo.nameWithOwner,
        capabilities: { pullRequests: true, issues: true },
      }))
      .mapErr((e) =>
        match(e)
          .with({ type: 'not_parseable' }, () => ({ type: 'invalid_remote' as const }))
          .with({ type: 'not_github' }, (x) => ({
            type: 'unsupported_provider' as const,
            host: x.host,
            reason: x.reason,
          }))
          .with({ type: 'host_unreachable' }, (x) => ({
            type: 'host_unreachable' as const,
            host: x.host,
            reason: x.reason,
          }))
          .with({ type: 'host_error' }, (x) => ({
            type: 'host_error' as const,
            host: x.host,
            reason: x.reason,
          }))
          .exhaustive()
      );
  }
}

export const providerRepositoryService = new ProviderRepositoryService();
