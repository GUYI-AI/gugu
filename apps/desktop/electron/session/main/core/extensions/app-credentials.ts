import { log } from '@main/lib/logger';
import { networkHostAllowed } from '@shared/extensions/network-host';
import { APP_CREDENTIAL_HINT_MAX, type AppCredentialChooseAsk, type AppCredentialDeclaration } from '@shared/extensions/app-credentials';

/**
 * An App's use of the person's saved credentials (`permissions.credentials`, App API 61). Which one it uses on a website
 * is the person's pick on this device (`.credential-choices.json`), else the one behind the connector's default account
 * there, else the only one saved for it. The host reads the value and sends one https request with it in the declared
 * header; the App gets the answer, never the value.
 */
export interface SavedCredential { id: string; name: string; origin: string; account?: string; maskedAccount: string }
export interface CredentialChoice { id: string; label: string; detail: string }
export interface AppCredentialState { site: string; chosen: CredentialChoice | null; picked: boolean; choices: CredentialChoice[] }
export interface CredentialAnswer { status: number; data: unknown; headers: Record<string, string> }

export interface AppCredentialDeps {
  declarations(extensionId: string): readonly AppCredentialDeclaration[];
  grantedHosts(extensionId: string): readonly string[];
  picked(extensionId: string, site: string): string | null;
  pick(extensionId: string, site: string, credentialId: string | null): void;
  /** The vault's credentials that serve `site`; their values only through `secret`. */
  saved(site: string): Promise<SavedCredential[]>;
  secret(credentialId: string): Promise<string | null>;
  /** A new credential into the vault, as Settings › Passwords adds one; its id. */
  save(input: { origin: string; name: string; account: string; password: string }): Promise<string>;
  /** `gugu.credentials.choose`: the host's dialog in the window that draws the page; resolves once it closes. */
  ask(page: { embedderId: number | null }, ask: AppCredentialChooseAsk): Promise<void>;
  connectorDefault(site: string): Promise<string | null>;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual' }): Promise<Response>;
}

const fail = (code: 'invalid' | 'unavailable', message: string) => Object.assign(new Error(message), { code });
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
/** Plain headers a page may add (an Accept, an API version); never the credential's own. */
const PLAIN_HEADERS = /^(?:accept|content-type|if-none-match|x-[a-z-]+-api-version)$/i;
/** Response headers handed back: what a client needs to page and to back off. */
const ANSWER_HEADERS = ['content-type', 'link', 'etag', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

/** The vault's own failure (no system key storage, signed out): its reason goes to the log, the App gets what to do. */
async function fromVault<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    log.warn('App credentials: the password vault could not be read', { code: (error as { code?: unknown }).code, error: error instanceof Error ? error.message : String(error) });
    throw fail('unavailable', 'Saved credentials cannot be read on this computer now: see Settings › Passwords');
  }
}

const choiceOf = (item: SavedCredential): CredentialChoice => ({
  id: item.id, label: [item.name, item.account ?? item.maskedAccount].filter(Boolean).join(' · '), detail: new URL(item.origin).hostname,
});

export function createAppCredentials(deps: AppCredentialDeps) {
  const declaration = (extensionId: string, site: unknown) => {
    const found = deps.declarations(extensionId).find((entry) => entry.site === site);
    if (!found) throw fail('invalid', `This App declares no credential for ${String(site)} (permissions.credentials)`);
    return found;
  };

  async function state(extensionId: string, site: string): Promise<AppCredentialState> {
    const saved = await fromVault(() => deps.saved(site));
    const pickedId = deps.picked(extensionId, site);
    const picked = saved.find((item) => item.id === pickedId);
    const connector = picked ? null : await deps.connectorDefault(site);
    const chosen = picked ?? saved.find((item) => item.id === connector) ?? (saved.length === 1 ? saved[0] : undefined);
    return { site, chosen: chosen ? choiceOf(chosen) : null, picked: !!picked, choices: saved.map(choiceOf) };
  }

  return {
    /** The App's permissions page: per declared website, what it uses and what else it could. */
    states: (extensionId: string) => Promise.all(deps.declarations(extensionId).map(({ site }) => state(extensionId, site))),

    pick(extensionId: string, site: string, credentialId: string | null): void {
      declaration(extensionId, site);
      deps.pick(extensionId, site, credentialId);
    },

    /** The dialog's 「保存」: a new credential for the declared website, kept in the vault and picked for the App. */
    async saveAndPick(extensionId: string, site: string, input: { name: string; value: string }): Promise<void> {
      declaration(extensionId, site);
      const name = input.name.trim(), value = input.value.trim();
      if (!name || !value || /[\r\n\0]/.test(value)) throw fail('invalid', 'A credential needs a name and a value on one line');
      const id = await fromVault(() => deps.save({ origin: `https://${site}`, name, account: '', password: value }));
      deps.pick(extensionId, site, id);
    },

    /** `gugu.credentials.choose(site)`: the host's dialog (pick a saved one, or save a new one); `{ chosen }` once it closes. */
    async choose(extensionId: string, appName: string, args: Record<string, unknown>, page: { embedderId: number | null }): Promise<{ chosen: boolean }> {
      const { site } = declaration(extensionId, args.site);
      const hint = typeof args.hint === 'string' ? args.hint.trim() : '', help = typeof args.help === 'string' ? args.help : '';
      if (hint.length > APP_CREDENTIAL_HINT_MAX) throw fail('invalid', `gugu.credentials.choose: hint is at most ${APP_CREDENTIAL_HINT_MAX} characters`);
      if (help && !/^https:\/\/[^\s]+$/.test(help)) throw fail('invalid', 'gugu.credentials.choose: help is an https URL');
      await deps.ask(page, { extensionId, appName, site, ...(hint ? { hint } : {}), ...(help ? { help } : {}) });
      return { chosen: !!(await state(extensionId, site)).chosen };
    },

    /** `gugu.credentials.read/write`: one request with the credential the App uses on that website. */
    async request(extensionId: string, args: Record<string, unknown>, write: boolean): Promise<CredentialAnswer> {
      const { site, header, format } = declaration(extensionId, args.site);
      const method = write ? String(args.method ?? '').toUpperCase() : 'GET';
      if (write && !METHODS.includes(method)) throw fail('invalid', 'gugu.credentials.write(site, method, url, body?): method is POST, PUT, PATCH or DELETE');
      let url: URL;
      try { url = new URL(String(args.url)); } catch { throw fail('invalid', 'gugu.credentials takes the full https URL of the request'); }
      const host = url.hostname;
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !(host === site || host.endsWith(`.${site}`))
        || !networkHostAllowed(deps.grantedHosts(extensionId), host)) {
        throw fail('invalid', `The request goes over https to a host of ${site} in this App's permissions.network`);
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((args.headers ?? {}) as Record<string, unknown>)) {
        if (!PLAIN_HEADERS.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw fail('invalid', `gugu.credentials does not send the header ${name}`);
        headers[name] = value;
      }
      const chosen = (await state(extensionId, site)).chosen;
      if (!chosen) throw fail('unavailable', `No saved credential is chosen for ${site}: choose one in this App's permissions`);
      const value = await fromVault(() => deps.secret(chosen.id));
      if (!value) throw fail('unavailable', `The saved credential for ${site} is gone: choose another in this App's permissions`);
      // A value that could end the header line would write more headers: refused, never trimmed.
      if (/[\r\n\0]/.test(value)) throw fail('unavailable', `The saved credential for ${site} cannot go into a header`);
      headers[header] = format.replace('{value}', value);
      const body = write && args.body !== undefined ? (typeof args.body === 'string' ? args.body : JSON.stringify(args.body)) : undefined;
      if (body !== undefined && typeof args.body !== 'string') headers['Content-Type'] ??= 'application/json';
      let response: Response;
      try {
        // `manual`: a redirect comes back as the answer, so the header never follows it elsewhere.
        response = await deps.fetch(url.toString(), { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body }) });
      } catch (error) {
        log.warn('App credentials: the request did not go through', { host, error: error instanceof Error ? error.message : String(error) });
        throw fail('unavailable', `The request to ${host} did not go through: try again`);
      }
      const text = await response.text();
      let data: unknown = text;
      if ((response.headers.get('content-type') ?? '').includes('json') && text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      const answer: Record<string, string> = {};
      for (const name of ANSWER_HEADERS) { const entry = response.headers.get(name); if (entry !== null) answer[name] = entry; }
      return { status: response.status, data, headers: answer };
    },
  };
}
