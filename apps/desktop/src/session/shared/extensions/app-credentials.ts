/**
 * An App's use of the person's saved credentials (App API 61, `permissions.credentials`): the website a credential is for,
 * and how its value travels — one request header, in one format — when the host sends a request for the App. The App
 * never sees the value; which saved credential it uses is the person's choice (password vault grant `app:<publisher>/<id>`),
 * bound to the App's code: when the code changes the person confirms again.
 */
export const APP_CREDENTIALS_API_VERSION = 61;
/** Headers a credential may go into; never one the platform owns (Cookie, Host) or that steers a request. */
export const APP_CREDENTIAL_HEADERS = ['Authorization', 'X-API-Key', 'Private-Token', 'X-Auth-Token'] as const;
export type AppCredentialHeader = (typeof APP_CREDENTIAL_HEADERS)[number];

export interface AppCredentialDeclaration {
  /** The website the credential is saved for, as the vault keeps it (`github.com`): a bare lowercase hostname. */
  site: string;
  header: AppCredentialHeader;
  /** How the header reads; `{value}` once (`Bearer {value}`). */
  format: string;
  /** Which saved value: the password, the account, or a named field. */
  value: 'password' | 'account' | { field: string };
}

/** `credential:github.com`: how one declaration is named as a permission (consent, revocation). */
export const credentialPermissionKey = (site: string) => `credential:${site}`;
export const credentialSiteOf = (key: string) => (key.startsWith('credential:') ? key.slice('credential:'.length) : null);
