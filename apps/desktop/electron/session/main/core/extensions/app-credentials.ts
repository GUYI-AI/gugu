import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appKey } from '@shared/extensions/app-identity';
import type { AppCredentialDeclaration } from '@shared/extensions/app-credentials';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { passwordVaultForHost, type SiteCredential } from '../../../../password-vault/beta-host';
import { VaultError } from '../../../../password-vault/contracts';
import { CONNECTOR_SUBJECT } from '../github/github-credential';

/**
 * An App's saved credentials (`permissions.credentials`, App API 61). Which one an App uses on a website is one thing only:
 * the password vault's grant to `app:<publisher>/<id>` on that credential, carrying the fingerprint of the App code the
 * person confirmed (`assignSiteGrant` keeps it to one per website). Nothing here stores a choice of its own, and no value
 * ever passes through: the request goes out from the vault's request sink.
 */
const fail = (code: 'invalid' | 'unavailable' | 'denied', message: string) => Object.assign(new Error(message), { code });

function declaration(extensionId: string, site: string): AppCredentialDeclaration {
  const found = extensionsService().get(extensionId).manifest.permissions?.credentials?.find((entry) => entry.site === site);
  if (!found) throw fail('invalid', `This App declares no credential for ${site} (permissions.credentials)`);
  return found;
}

/** `app:<publisher>/<id>`; an App without a recorded publisher cannot be named across devices, nor granted anything. */
export function appCredentialSubject(extensionId: string): string {
  const identity = extensionsService().identityOf(extensionId);
  if (!identity) throw fail('unavailable', 'This App has no recorded publisher; install it again (from the market or a chat card) to use saved credentials');
  return `app:${appKey(identity)}`;
}

/** The App's code as installed: every file of its bundle, by path. What the person confirmed a credential for. */
export function appCodeFingerprint(rootDir: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []));
  for (const file of walk(rootDir).sort()) {
    hash.update(path.relative(rootDir, file).split(path.sep).join('/')).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

const codeOf = (extensionId: string) => appCodeFingerprint(extensionsService().get(extensionId).rootDir);

/** The person's picks in the install sheet, held for the install that follows (keyed by the manifest they agreed to). */
const staged = new Map<string, { at: number; choices: Record<string, string | null> }>();
const STAGED_MS = 15 * 60_000;
export function stageCredentialChoices(manifestDigest: string, choices: Record<string, string | null>): void {
  for (const [digest, entry] of staged) if (Date.now() - entry.at > STAGED_MS) staged.delete(digest);
  staged.set(manifestDigest, { at: Date.now(), choices: { ...choices } });
}

/**
 * After an install or update lands (extension-after-install.ts): the picks made in its sheet become the App's grants,
 * bound to this code. An update that asked nothing leaves the grant on the previous code: it answers `GRANT_STALE`
 * until the person confirms again in the App's permissions.
 */
export async function applyStagedCredentialChoices(installed: { manifest: { id: string; permissions?: { credentials?: AppCredentialDeclaration[] } }; manifestDigest: string; rootDir: string }): Promise<void> {
  const picks = staged.get(installed.manifestDigest);
  if (!picks) return;
  staged.delete(installed.manifestDigest);
  const subject = appCredentialSubject(installed.manifest.id), code = appCodeFingerprint(installed.rootDir);
  for (const { site } of installed.manifest.permissions?.credentials ?? []) {
    if (Object.hasOwn(picks.choices, site)) await passwordVaultForHost.assign(subject, site, picks.choices[site], picks.choices[site] ? code : undefined);
  }
}

export interface CredentialChoice { id: string; label: string; detail: string }
const choiceOf = (item: SiteCredential): CredentialChoice => ({
  id: item.id, label: [item.name, item.account ?? item.maskedAccount].filter(Boolean).join(' · '), detail: new URL(item.origin).hostname,
});

/** What a sheet or the App's permissions offer for a website: the saved credentials, and which one the connector uses. */
export async function credentialChoices(site: string): Promise<{ choices: CredentialChoice[]; connector: string | null }> {
  const items = await passwordVaultForHost.siteCredentials(site);
  return { choices: items.map(choiceOf), connector: items.find((item) => item.users.some((user) => user.subject === CONNECTOR_SUBJECT))?.id ?? null };
}

export interface AppCredentialState { site: string; chosen: CredentialChoice | null; stale: boolean; choices: CredentialChoice[]; connector: string | null }
/** The App's permissions page: per declared website, what it uses and whether its code changed since. */
export async function appCredentialStates(extensionId: string): Promise<AppCredentialState[]> {
  const installed = extensionsService().get(extensionId), subject = appCredentialSubject(extensionId), code = appCodeFingerprint(installed.rootDir);
  return Promise.all((installed.manifest.permissions?.credentials ?? []).map(async ({ site }) => {
    const items = await passwordVaultForHost.siteCredentials(site);
    const chosen = items.find((item) => item.users.some((user) => user.subject === subject));
    const grant = chosen?.users.find((user) => user.subject === subject);
    return { site, chosen: chosen ? choiceOf(chosen) : null, stale: !!grant && grant.code !== code, choices: items.map(choiceOf),
      connector: items.find((item) => item.users.some((user) => user.subject === CONNECTOR_SUBJECT))?.id ?? null };
  }));
}

/** The person picks (or confirms again, or clears) the credential the App uses on `site`, for the code installed now. */
export async function setAppCredential(extensionId: string, site: string, credentialId: string | null): Promise<void> {
  declaration(extensionId, site);
  await passwordVaultForHost.assign(appCredentialSubject(extensionId), site, credentialId, credentialId ? codeOf(extensionId) : undefined);
}

/** Uninstall: the App (named by `subject`, taken before its name goes) uses no saved credential any more. */
export async function clearAppCredentials(subject: string): Promise<void> {
  for (const item of await passwordVaultForHost.credentials()) {
    if (item.users.some((user) => user.subject === subject)) await passwordVaultForHost.assign(subject, new URL(item.origin).hostname, null);
  }
}

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** `gugu.credentials.read/write`: the request, sent by the vault with the App's chosen credential. */
export async function appCredentialRequest(extensionId: string, args: Record<string, unknown>, write: boolean): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  const site = typeof args.site === 'string' ? args.site : '';
  const declared = declaration(extensionId, site);
  const method = write ? (typeof args.method === 'string' ? args.method.toUpperCase() : '') : 'GET';
  if (write && !(METHODS as readonly string[]).includes(method)) throw fail('invalid', 'gugu.credentials.write(site, method, url, body?): method is POST, PUT, PATCH or DELETE');
  if (typeof args.url !== 'string') throw fail('invalid', 'gugu.credentials takes the full https URL of the request');
  const headers = args.headers && typeof args.headers === 'object' ? args.headers as Record<string, string> : undefined;
  const body = write && args.body !== undefined ? (typeof args.body === 'string' ? args.body : JSON.stringify(args.body)) : undefined;
  try {
    return await passwordVaultForHost.request(appCredentialSubject(extensionId), site, codeOf(extensionId), {
      method: method as 'GET', url: args.url, hosts: extensionsService().grantedHosts(extensionId), header: declared.header, format: declared.format,
      value: declared.value, ...(body === undefined ? {} : { body }),
      headers: { ...(body !== undefined && typeof args.body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    });
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    // The vault's own reason, in words the App can show; nothing falls back to a request without the credential.
    if (error.code === 'NOT_GRANTED') throw fail('unavailable', `No saved credential is chosen for ${site}: choose one in this App's permissions`);
    if (error.code === 'GRANT_STALE') throw fail('unavailable', `This App changed since its ${site} credential was confirmed: confirm it again in the App's permissions`);
    if (error.code === 'INVALID_INPUT') throw fail('invalid', `The request may only go over https to a host in permissions.network that the ${site} credential serves`);
    if (error.code === 'SYSTEM_STORAGE_UNAVAILABLE') throw fail('unavailable', 'This computer\'s system key storage is unavailable, so saved credentials cannot be used (see Settings › 密码)');
    throw fail('unavailable', `The password vault could not send it (${error.code})`);
  }
}
