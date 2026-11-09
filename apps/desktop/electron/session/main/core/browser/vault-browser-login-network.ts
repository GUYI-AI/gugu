import type { Session } from 'electron';
import { assertCredentialWebsite } from './credential-website';
import { VaultBrowserLoginError } from './vault-browser-login-protocol';

type Request = { id: number; url: string; method: string; webContentsId?: number; resourceType: string;
  frame?: { processId: number; routingId: number; parent: unknown } | null; uploadData?: unknown[] };
type Surface = { id: number; origin: string; active: boolean; sensitive: boolean;
  armed?: { destination: string; frameId: string; assertCurrent(): void; person?: boolean }; requestId?: number; passwordSubmitted?: boolean };
type Policy = { requestHook: boolean; responseHook: boolean; surfaces: Map<number, Surface>; requests: Map<number, Surface> };
const policies = new WeakMap<Session, Policy>();
function policy(session: Session): Policy {
  let value = policies.get(session);
  if (!value) { value = { requestHook: false, responseHook: false, surfaces: new Map(), requests: new Map() }; policies.set(session, value); }
  return value;
}

/** Called by the existing browser profile's SINGLE request chain, never by a second listener. */
export function markVaultLoginNetworkInstalled(session: Session, hook: 'requests' | 'responses'): void {
  const p = policy(session);
  if (hook === 'requests') p.requestHook = true; else p.responseHook = true;
}

export function protectVaultLoginNetwork(session: Session, id: number, origin: string) {
  assertCredentialWebsite(origin, origin);
  const p = policy(session);
  if (!p.requestHook || !p.responseHook || p.surfaces.has(id) || [...p.surfaces.values()].some(value => value.active)) throw new VaultBrowserLoginError();
  const value: Surface = { id, origin, active: true, sensitive: false };
  p.surfaces.set(id, value);
  return Object.freeze({
    beginSensitive(): void { if (!value.active) throw new VaultBrowserLoginError(); value.sensitive = true; },
    arm(destination: string, frameId: string, assertCurrent: () => void): void {
      assertCredentialWebsite(destination, origin);
      if (!value.active || !value.sensitive || value.armed || value.requestId !== undefined) throw new VaultBrowserLoginError();
      value.armed = { destination, frameId, assertCurrent };
    },
    armPerson(destination: string, frameId: string, assertCurrent: () => void): void {
      assertCredentialWebsite(destination, origin);
      if (!value.active || !value.passwordSubmitted || value.armed) throw new VaultBrowserLoginError();
      value.armed = { destination, frameId, assertCurrent, person: true };
    },
    close(): void {
      // Retain an ID-only tombstone: a late redirect must never escape after contents destruction.
      value.active = false; value.armed = undefined;
    },
  });
}

export function vaultLoginRequestBlocked(session: Session, details: Request): boolean {
  const p = policies.get(session);
  if (!p) return false;
  const prior = p.requests.get(details.id);
  const surface = details.webContentsId === undefined ? undefined : p.surfaces.get(details.webContentsId);
  const hasBody = !!details.uploadData?.length || !['GET', 'HEAD', 'OPTIONS'].includes(details.method);
  // A worker request without an attributable contents may be a credential replay. Never guess its owner.
  if (!surface && !prior) return hasBody && (details.webContentsId === undefined || details.webContentsId <= 0)
    && [...p.surfaces.values()].some(value => value.active && value.sensitive);
  const owner = surface ?? prior!;
  if (!owner.active) return true;
  try { assertCredentialWebsite(details.url, owner.origin); } catch { return true; }
  if (details.resourceType === 'subFrame') return true;
  if (!hasBody) return false;
  // Every body request, including a redirect with the same request ID, needs the one transport reservation.
  const armed = owner.armed;
  if (prior || !armed || details.method !== 'POST' || details.resourceType !== 'mainFrame'
    || details.webContentsId !== owner.id || details.url !== armed.destination
    || !details.frame || details.frame.parent !== null
    || `${details.frame.processId}:${details.frame.routingId}` !== armed.frameId) return true;
  owner.armed = undefined; owner.requestId = details.id;
  p.requests.set(details.id, owner);
  try { armed.assertCurrent(); } catch { return true; }
  if (!armed.person) owner.passwordSubmitted = true;
  return false;
}

export function vaultLoginResponseBlocked(session: Session, details: { id: number; statusCode: number }): boolean {
  // A 307/308 preserves the password body, even on the SAME origin. It is a second submission.
  return !!policies.get(session)?.requests.has(details.id) && [307, 308].includes(details.statusCode);
}

export function vaultLoginResponseHeaders(session: Session, details: { webContentsId?: number; responseHeaders?: Record<string, string[]> }): Record<string, string[]> | null {
  if (details.webContentsId === undefined || !policies.get(session)?.surfaces.has(details.webContentsId)) return null;
  const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {})
    .filter(([name]) => !['cache-control', 'pragma', 'expires'].includes(name.toLowerCase())));
  return { ...headers, 'Cache-Control': ['no-store'], Pragma: ['no-cache'], Expires: ['0'] };
}

export function finishVaultLoginRequest(session: Session, id: number): void {
  policies.get(session)?.requests.delete(id);
}
