import { err, ok, type Result } from '@gugu/session-shared';
import { Octokit } from '@octokit/rest';
import { log } from '@main/lib/logger';
import { normalizeRepositoryHost } from '@shared/repository-ref';
import type { GitHubApiAuthError } from './github-api-auth-errors';
import type { GitHubApiAuthContext } from './github-api-auth-service';
import { githubApiAuthService } from './github-api-auth-service-instance';
import { githubApiBaseUrlForHost } from './github-api-base-url';
import { getCachedOctokit, setCachedOctokit } from './octokit-cache';

export { clearOctokitCache } from './octokit-cache';

const octokitLog = {
  debug: (...input: unknown[]) => log.debug('Octokit:', ...input),
  info: (...input: unknown[]) => log.debug('Octokit:', ...input),
  warn: (...input: unknown[]) => log.warn('Octokit:', ...input),
  error: (...input: unknown[]) => log.debug('Octokit request failed:', ...input),
};

export class GitHubApiAuthErrorException extends Error {
  constructor(readonly authError: GitHubApiAuthError) {
    super(authError.message);
    this.name = 'GitHubApiAuthErrorException';
  }
}

/**
 * An Octokit whose every request is sent by the password vault with the chosen GitHub credential (`request.fetch`): no
 * `auth`, no token in this process. One per host and credential choice.
 */
export async function getOctokit(
  host: string,
  context: GitHubApiAuthContext = {}
): Promise<Result<Octokit, GitHubApiAuthError>> {
  const normalizedHost = normalizeRepositoryHost(host);
  const auth = await githubApiAuthService.resolve(normalizedHost, context);
  if (!auth.success) return err(auth.error);

  const cached = getCachedOctokit(auth.data.cacheKey);
  if (cached) return ok(cached);

  const octokit = new Octokit({
    baseUrl: githubApiBaseUrlForHost(normalizedHost),
    log: octokitLog,
    request: { fetch: auth.data.fetch },
  });

  setCachedOctokit(auth.data.cacheKey, octokit);
  return ok(octokit);
}
