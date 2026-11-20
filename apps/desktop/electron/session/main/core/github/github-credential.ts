import { isGitHubDotComHost, normalizeRepositoryHost } from '@shared/repository-ref';
import { passwordVaultForHost, type SiteCredential } from '../../../../password-vault/beta-host';

/**
 * The GitHub connector's use of the password vault. Its accounts are the vault's GitHub credentials; which one the host's
 * GitHub features use is the vault's grant — `host:connector:github` (the connector's current one) or
 * `host:github:project:<id>` (one project's own pick) — one per website, like an App's choice. Requests go out through the
 * vault's request sink with that credential in the Authorization header; no token is ever read out of the vault.
 */
export const CONNECTOR_SUBJECT = 'host:connector:github';
export const projectSubject = (projectId: string) => `host:github:project:${projectId}`;
/** Non-secret values kept with a connected GitHub credential, by name. */
export const GITHUB_ID_FIELD = 'GitHub ID';
export const GITHUB_AVATAR_FIELD = 'Avatar';
export const GITHUB_SOURCE_FIELD = 'Connected by';

/** The website a GitHub host's credentials are saved for: github.com, or the Enterprise host itself. */
export const githubSite = (host: string) => normalizeRepositoryHost(host) || 'github.com';
const apiHostOf = (host: string) => (isGitHubDotComHost(githubSite(host)) ? 'api.github.com' : githubSite(host));

const hostOfCredential = (credential: Pick<SiteCredential, 'origin'>) => new URL(credential.origin).hostname;
/** A GitHub credential: connected here (it carries a GitHub id), or saved for github.com. */
export const isGitHubCredential = (credential: SiteCredential) =>
  credential.fields[GITHUB_ID_FIELD] !== undefined || isGitHubDotComHost(hostOfCredential(credential));

/** Every GitHub credential in the vault (all hosts), with this device's choices on it — once old accounts moved in. */
export async function githubCredentials(): Promise<SiteCredential[]> {
  const { migrateLegacyGitHubAccounts } = await import('./github-migration');
  await migrateLegacyGitHubAccounts();
  return rawGitHubCredentials();
}
/** The same list without waiting for the move from the old store: for that move itself (and what it calls). */
export async function rawGitHubCredentials(): Promise<SiteCredential[]> {
  return (await passwordVaultForHost.credentials()).filter(isGitHubCredential);
}

const PLAIN = /^(?:accept|content-type|if-none-match|x-[a-z-]+-api-version)$/i;
/**
 * A `fetch` for one GitHub host that sends each request through the vault's request sink: as `subject` (its granted
 * credential) or, for a screen where the person is picking one right now, as that `credentialId`. What GitHub answered
 * comes back as a Response; the credential never does.
 */
export function vaultGitHubFetch(host: string, who: { subject: string } | { credentialId: string }): typeof fetch {
  const site = githubSite(host), apiHost = apiHostOf(host);
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { if (PLAIN.test(name)) headers[name] = value; });
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    const method = (init.method ?? 'GET').toUpperCase() as 'GET';
    const answer = await passwordVaultForHost.request('subject' in who ? who.subject : CONNECTOR_SUBJECT, site, undefined, {
      method, url, hosts: [apiHost], header: 'Authorization', format: 'Bearer {value}', value: 'password', headers, ...(body === undefined ? {} : { body }),
    }, init.signal ?? undefined, 'credentialId' in who ? who.credentialId : undefined);
    const text = typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data);
    return new Response(answer.status === 204 || answer.status === 304 ? null : text, { status: answer.status, headers: answer.headers });
  };
}

/** Which GitHub credential `subject` uses on `host`, if any. */
export async function grantedCredential(host: string, subject: string): Promise<SiteCredential | undefined> {
  return (await passwordVaultForHost.siteCredentials(githubSite(host))).find((item) => item.users.some((user) => user.subject === subject));
}


/** The GitHub credential a project uses: its own pick, else the connector's current one; null with none at all. */
export async function projectGitHubCredentialId(host: string, projectId: string): Promise<string | null> {
  return (await grantedCredential(host, projectSubject(projectId)))?.id ?? (await grantedCredential(host, CONNECTOR_SUBJECT))?.id ?? null;
}
/** A project picks one of the GitHub credentials (null: back to the connector's current one). */
export async function chooseProjectGitHubCredential(projectId: string, credentialId: string | null, host = 'github.com'): Promise<void> {
  await passwordVaultForHost.assign(projectSubject(projectId), githubSite(host), credentialId);
}
