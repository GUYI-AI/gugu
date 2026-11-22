/**
 * An App's use of the person's saved credentials (App API 61, `permissions.credentials`): the website a credential is
 * for, and the one request header its password goes into when the host sends a request for the App. The App never sees
 * the value; which saved credential it uses is the person's pick on this device (app-credentials.ts in main).
 */
export const APP_CREDENTIALS_API_VERSION = 61;
/** Headers a credential may go into; never one the platform owns (Cookie, Host) or that steers a request. */
export const APP_CREDENTIAL_HEADERS = ['Authorization', 'X-API-Key', 'Private-Token', 'X-Auth-Token'] as const;
export type AppCredentialHeader = (typeof APP_CREDENTIAL_HEADERS)[number];

export interface AppCredentialDeclaration {
  /** The website the credential is saved for (`github.com`): a bare lowercase hostname. */
  site: string;
  header: AppCredentialHeader;
  /** How the header reads; `{value}` once (`Bearer {value}`). */
  format: string;
}

/** Hosts of `network` that belong to `site` (the site itself or its subdomains): the only places its credential goes. */
export const siteHosts = (network: readonly string[], site: string) =>
  network.filter((host) => { const bare = host.replace(/^\*\./, ''); return bare === site || bare.endsWith(`.${site}`); });
