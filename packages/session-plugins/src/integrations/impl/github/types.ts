import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import z from 'zod';
import { credentialString, optionalCredentialString } from '../../helpers/credentials';

export const GITHUB_DOTCOM_API_BASE_URL = 'https://api.github.com';

/** A token (checking one the person is about to save); a host that keeps the credential itself passes `fetch` instead. */
export const gitHubCredentialsSchema = z.object({
  accessToken: optionalCredentialString(),
  apiBaseUrl: optionalCredentialString().transform(
    (value) => value?.replace(/\/+$/, '') ?? GITHUB_DOTCOM_API_BASE_URL
  ),
});

export type GitHubCredentials = z.infer<typeof gitHubCredentialsSchema>;
/** Checking a token the person is about to save: then there is one. */
export const gitHubTokenCredentialsSchema = gitHubCredentialsSchema.extend({ accessToken: credentialString('GitHub access token is required.') });

export type GitHubClient = Octokit;

export type GitHubIssue =
  | RestEndpointMethodTypes['issues']['listForRepo']['response']['data'][number]
  | RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][number];

export type GitHubVerifiedConnection = {
  account: {
    id: string;
    login: string;
    avatarUrl?: string;
    host?: string;
  };
  displayName?: string;
  displayDetail?: string;
  credentials: GitHubCredentials;
};
