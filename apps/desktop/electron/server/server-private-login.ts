import { assertCredentialWebsite } from '../session/main/core/browser/credential-website';

/**
 * A password login on a Gugu server (#2481 「本机送」): the person's desktop sent this one account and password,
 * sealed to this server. They are typed into a page in a browser context of its own (its own cookies, storage and
 * workers), which no task page shares and no Agent lease can reach: the page protocol lent to Agents refuses
 * `Target.*` by target and never auto-attaches to pages. Network is pinned to the site; the one request that may
 * carry a body is the form's own submission. Afterwards only the site's cookies move to the account's normal
 * context, where the Agent's page is, and the private context is disposed.
 */
export type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
export type CdpEvent = { method?: string; params?: Record<string, unknown>; sessionId?: string };
export interface CdpEvents {
  on(event: 'event', listener: (message: CdpEvent) => void): unknown;
  removeListener(event: 'event', listener: (message: CdpEvent) => void): unknown;
}
export interface LoginSelection { form: string; account: string; password: string; submitter?: string }
export interface PrivateLoginInput {
  url: string; origin: string; selection: LoginSelection; account: string; password: string; signal: AbortSignal;
  /** Tests only: a local site that is not https. */
  website?: (url: string, origin: string) => void;
  timeouts?: { loadMs?: number; confirmMs?: number };
}
export type PrivateLoginStatus = 'submitted_unconfirmed' | 'person_interaction_required';

type Paused = { requestId: string; request: { url: string; method: string; postData?: string; hasPostData?: boolean };
  resourceType?: string; frameId?: string; redirectedRequestId?: string };

/** What the pinned network lets through. Pure: the tests drive it without a browser. */
export function privateLoginRequestAllowed(paused: Paused, state: { mainFrame: string | null; submission: string | null; submitted: boolean },
  website: (url: string, origin: string) => void, origin: string): { allow: boolean; submits?: boolean } {
  try { website(paused.request.url, origin); } catch { return { allow: false }; }
  // A page of another frame inside the login page could watch the typing.
  if (paused.resourceType === 'Document' && state.mainFrame && paused.frameId !== state.mainFrame) return { allow: false };
  const body = !!paused.request.hasPostData || !!paused.request.postData || !['GET', 'HEAD', 'OPTIONS'].includes(paused.request.method);
  if (!body) return { allow: true };
  // One body: the form's own submission, once (a 307/308 replay of it is a second body).
  if (state.submitted || !state.submission || paused.request.method !== 'POST' || paused.resourceType !== 'Document'
    || paused.frameId !== state.mainFrame || paused.request.url !== state.submission) return { allow: false };
  return { allow: true, submits: true };
}

/** Values arrive as call arguments, never in script source. Returns where the form posts, not what was typed. */
const FILL = `function (selection, account, password) {
  const form = this.querySelector(selection.form);
  if (!(form instanceof HTMLFormElement)) return { error: 'form' };
  const user = form.querySelector(selection.account), secret = form.querySelector(selection.password);
  if (!(user instanceof HTMLInputElement) || !(secret instanceof HTMLInputElement) || secret.type !== 'password') return { error: 'fields' };
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [input, value] of [[user, account], [secret, password]]) {
    input.focus(); set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { action: form.action, method: (form.method || 'get').toUpperCase() };
}`;
const SUBMIT = `function (selection) {
  const form = this.querySelector(selection.form);
  const submitter = selection.submitter ? this.querySelector(selection.submitter) : null;
  form.requestSubmit(submitter && form.contains(submitter) ? submitter : undefined);
  return true;
}`;
const STATE = `({ url: location.href, passwords: document.querySelectorAll('input[type=password]').length })`;

export async function runPrivateLogin(send: Send, events: CdpEvents, input: PrivateLoginInput): Promise<{ status: PrivateLoginStatus; cookies: number }> {
  const website = input.website ?? assertCredentialWebsite;
  website(input.url, input.origin);
  const { signal } = input;
  signal.throwIfAborted();
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true }) as { browserContextId: string };
  const state = { mainFrame: null as string | null, submission: null as string | null, submitted: false, navigatedAfterSubmit: false };
  let session: string | undefined, loaded: (() => void) | undefined;
  const listener = (message: CdpEvent) => {
    if (!session || message.sessionId !== session) return;
    const params = message.params ?? {};
    if (message.method === 'Fetch.requestPaused') {
      const paused = params as unknown as Paused;
      const verdict = privateLoginRequestAllowed(paused, state, website, input.origin);
      if (verdict.submits) state.submitted = true;
      void (verdict.allow ? send('Fetch.continueRequest', { requestId: paused.requestId }, session)
        : send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' }, session)).catch(() => {});
    } else if (message.method === 'Page.frameNavigated') {
      const frame = params.frame as { id: string; parentId?: string } | undefined;
      if (frame && !frame.parentId && state.submitted) state.navigatedAfterSubmit = true;
    } else if (message.method === 'Page.loadEventFired') loaded?.();
  };
  events.on('event', listener);
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId }) as { targetId: string };
    session = (await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string }).sessionId;
    await send('Page.enable', {}, session);
    const tree = await send('Page.getFrameTree', {}, session) as { frameTree: { frame: { id: string } } };
    state.mainFrame = tree.frameTree.frame.id;
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, session);
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = new Promise<void>((resolve, reject) => {
      loaded = resolve;
      timer = setTimeout(() => reject(new Error('private_login_load_timeout')), input.timeouts?.loadMs ?? 45_000);
    });
    load.catch(() => {});
    try { await send('Page.navigate', { url: input.url }, session); await load; } finally { clearTimeout(timer); }
    signal.throwIfAborted();
    const evaluate = async <T>(expression: string) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true }, session) as { result: { value: T } }).result.value;
    website((await evaluate<{ url: string }>(STATE)).url, input.origin);
    const document = (await send('Runtime.evaluate', { expression: 'document' }, session) as { result: { objectId: string } }).result.objectId;
    const call = async <T>(functionDeclaration: string, args: unknown[]) => (await send('Runtime.callFunctionOn',
      { objectId: document, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true }, session) as { result: { value: T } }).result.value;
    const filled = await call<{ action?: string; method?: string; error?: string }>(FILL, [input.selection, input.account, input.password]);
    if (!filled.action || filled.method !== 'POST') throw new Error('private_login_form_unavailable');
    website(filled.action, input.origin);
    state.submission = filled.action;
    signal.throwIfAborted();
    await call(SUBMIT, [input.selection]);
    const until = Date.now() + (input.timeouts?.confirmMs ?? 30_000);
    let status: PrivateLoginStatus = 'person_interaction_required';
    while (Date.now() < until) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!state.navigatedAfterSubmit) continue;
      const now = await evaluate<{ url: string; passwords: number }>(STATE).catch(() => null);
      if (now && now.passwords === 0) { website(now.url, input.origin); status = 'submitted_unconfirmed'; break; }
    }
    if (status !== 'submitted_unconfirmed') return { status, cookies: 0 };
    // Only this site's cookies move; the private context's storage and workers stay behind and are disposed.
    const host = new URL(input.origin).hostname;
    const { cookies } = await send('Storage.getCookies', { browserContextId }) as { cookies: Array<Record<string, unknown> & { domain: string }> };
    const own = cookies.filter(cookie => { const domain = cookie.domain.replace(/^\./, ''); return host === domain || host.endsWith(`.${domain}`); });
    if (own.length) await send('Storage.setCookies', { cookies: own.map(cookieParam) });
    return { status, cookies: own.length };
  } finally {
    events.removeListener('event', listener);
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

function cookieParam(cookie: Record<string, unknown>): Record<string, unknown> {
  const keep = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'];
  const param: Record<string, unknown> = Object.fromEntries(keep.filter(key => cookie[key] !== undefined).map(key => [key, cookie[key]]));
  if (cookie.session !== true && typeof cookie.expires === 'number' && cookie.expires > 0) param.expires = cookie.expires;
  return param;
}
