import { err, ok, type Result } from '@gugu/session-shared';
import { Octokit } from '@octokit/rest';
import { parseCredentials } from '../../helpers/credentials';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { toGitHubIntegrationError } from './error';
import {
  type GitHubClient,
  type GitHubCredentials,
  gitHubCredentialsSchema,
  gitHubTokenCredentialsSchema,
  type GitHubVerifiedConnection,
} from './types';

const VERIFY_TIMEOUT_MS = 10_000;

/** A token is required unless the host sends the credential it keeps (`hostFetch`). */
export function readGitHubCredentials(
  credentials: IntegrationCredentials,
  hostFetch?: typeof fetch
): Result<GitHubCredentials, IntegrationError> {
  return parseCredentials(hostFetch ? gitHubCredentialsSchema : gitHubTokenCredentialsSchema, credentials);
}

/** With the host's `fetch` (it sends the credential it keeps), or else with the token read by `readGitHubCredentials`. */
export function createGitHubClient(credentials: GitHubCredentials, hostFetch?: typeof fetch): GitHubClient {
  return hostFetch
    ? new Octokit({ baseUrl: credentials.apiBaseUrl, request: { fetch: hostFetch } })
    : new Octokit({ auth: credentials.accessToken, baseUrl: credentials.apiBaseUrl });
}

export async function verifyGitHubCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<GitHubVerifiedConnection, IntegrationError>> {
  const credentials = readGitHubCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const octokit = createGitHubClient(credentials.data);
  try {
    const { data } = await octokit.rest.users.getAuthenticated({
      request: { timeout: VERIFY_TIMEOUT_MS },
    });

    const host = new URL(credentials.data.apiBaseUrl).host;

    return ok({
      account: {
        id: String(data.id),
        login: data.login,
        ...(data.avatar_url ? { avatarUrl: data.avatar_url } : {}),
        host: host === 'api.github.com' ? 'github.com' : host,
      },
      displayName: data.name ?? data.login,
      credentials: credentials.data,
    });
  } catch (error) {
    return err(toGitHubIntegrationError(error, 'Failed to verify GitHub credentials.'));
  }
}
