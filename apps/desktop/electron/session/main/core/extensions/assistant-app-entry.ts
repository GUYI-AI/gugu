import { z } from 'zod';
import { log } from '@main/lib/logger';
import {
  ASSISTANT_RULES_PROVIDER_ID,
  assistantRulesDistrust,
  installedAssistantRulesProvider,
  type AssistantRulesInstallRecord,
  type AssistantRulesTrustCondition,
} from '../../../../assistant-rules-trust';
import { isOwnAssistantChat } from './app-assistant-binding';
import { account, current } from './app-unread-bindings';
import { extensionsService } from './extensions-root';
import { ASSISTANT_RESUME_TABS, type AppBindingSurface, type AssistantResumeTab } from '@shared/extensions/unread-binding';

/**
 * The entry switch (assistant App P5): the product's own assistant App replaces the built-in assistant page the person already
 * has, so the host sets it up the way the page was — nothing to choose, nothing to agree to. Only the trusted App: gugu's
 * `gugu-assistant`, installed from the market as its signed release in gugu's market repository, not a fork. Any other App, the same id
 * from anywhere else included, keeps the ordinary consent and chooser.
 *
 * - Its permissions: what it declares is granted at install (the market install with gugu's consent, #1931's ensure step);
 *   a permission the person withdraws stays withdrawn — nothing here gives one back.
 * - Its conversation binding: the account's private chat with its own assistant, written by the host (`by: 'host'`) — after
 *   the first setup made the chat, after a move, after close and a new assistant — and taken off as soon as the account has
 *   no assistant. Per account. Never over the person's own choice (`conversationBindingChosenByPerson`): a conversation they
 *   picked, or removed, in the App's permissions stands.
 *
 * The window says when (its assistant snapshot changed, the App was installed or changed: AssistantAppEntryHost); which chat it
 * is, is checked here against the account's own provision and the chat's members, never taken from the window.
 */
export const ASSISTANT_APP_ID = ASSISTANT_RULES_PROVIDER_ID;

// ── Trust ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// No definition here: #1931's own check (assistant-rules-trust.ts), on the App installed now — the App whose product rules the
// host believes is the App this entry trusts.
const ensureAssistantAppHere = (): void => {
  void import('../../../../assistant-rules-root')
    .then(({ ensureAssistantApp }) => ensureAssistantApp('assistant'))
    .catch((error: unknown) => log.warn('assistant App entry: the ensure step did not run', { error: String(error) }));
};

const notTrusted = (service: AssistantRulesInstallRecord, trust?: readonly AssistantRulesTrustCondition[]): Promise<string | null> => {
  const provider = installedAssistantRulesProvider(service);
  return provider ? assistantRulesDistrust(provider, trust) : Promise.resolve('it is not installed');
};

// ── The binding ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What one sync found. `trusted`: the installed App is the trusted assistant App. `changed`: the host wrote the binding.
 * - absent / distrusted: no trusted App; nothing touched.
 * - off: switched off. withdrawn: `chat:unread` taken back (the binding goes with it). undeclared: no binding declared.
 * - chosen: the person chose (or removed) its conversation themselves — left as they chose.
 * - bound / unbound: written now. kept: already as it should be, or changed meanwhile (the next sync decides).
 * - refused: the chat named is not the account's private chat with its own assistant. unverified: it could not be checked now.
 * - pending: it is that chat, but the assistant's setup has not finished (its resources are not served for it yet): nothing is
 *   bound — a binding written now is one every call of the App is refused over — and the window asks again.
 */
export type AssistantAppEntryOutcome = 'absent' | 'distrusted' | 'off' | 'withdrawn' | 'undeclared' | 'chosen'
  | 'bound' | 'unbound' | 'kept' | 'refused' | 'pending' | 'unverified';
export interface AssistantAppEntryState {
  ownerId: string;
  extensionId: typeof ASSISTANT_APP_ID;
  trusted: boolean;
  outcome: AssistantAppEntryOutcome;
  changed: boolean;
}

const syncSchema = z.strictObject({ ownerId: z.string().uuid(), chatId: z.string().uuid().nullable() });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

export interface AssistantAppEntryDeps {
  /** Tests only: #1931's conditions with release keys made in the test (default: the shipped ones). */
  trust?: readonly AssistantRulesTrustCondition[];
  ownAssistantChat?: (token: string, ownerId: string, chatId: string) => Promise<boolean | 'pending'>;
  /** Tells the App's pages what its binding is now (default: `pushBindingSurfaces`, the one way a page hears `onSurface`). */
  push?: () => Promise<void>;
  /** Asks the ensure step to put the App in (assistant-rules-root.ts `ensureAssistantApp('assistant')`); it decides if needed. */
  ensureApp?: () => void;
}

/**
 * Brings the trusted App's binding to the account's own assistant chat (`chatId`: the window's; null: the window shows no
 * assistant). Trusted window only (controller `syncAssistantAppEntry`), never an App verb.
 */
export async function syncAssistantAppEntry(input: unknown, deps: AssistantAppEntryDeps = {}): Promise<AssistantAppEntryState> {
  const { ownerId, chatId } = syncSchema.parse(input);
  const { token, ownerId: signedIn } = await account();
  if (signedIn !== ownerId) throw Object.assign(new Error('Account changed'), { code: 'denied' });
  const service = extensionsService();
  const state = (trusted: boolean, outcome: AssistantAppEntryOutcome, changed = false): AssistantAppEntryState =>
    ({ ownerId, extensionId: ASSISTANT_APP_ID, trusted, outcome, changed });
  if (!service.isInstalled(ASSISTANT_APP_ID)) {
    // The window shows the account's assistant (anywhere: here, another computer, the cloud, a server) and its page is not
    // here: the ensure step puts it in when main finds the account has one (it reads the provision itself).
    if (chatId) (deps.ensureApp ?? ensureAssistantAppHere)();
    return state(false, 'absent');
  }
  const distrust = await notTrusted(service, deps.trust);
  if (distrust) {
    log.info('assistant App entry: not the trusted App', { reason: distrust });
    // Its id is held, but not by the trusted App: the ensure step puts the signed release over gugu's own market copy (an
    // old unsigned build) and leaves the person's own (a folder, a fork, switched off) — it tells them apart, not this.
    if (chatId) (deps.ensureApp ?? ensureAssistantAppHere)();
    return state(false, 'distrusted');
  }
  const name = service.get(ASSISTANT_APP_ID).manifest.permissions?.bindings?.[0]?.name;
  if (!name) return state(true, 'undeclared');
  // Off, or `chat:unread` taken back: the service refuses the binding — the person's word, left as it is.
  const read = () => {
    try {
      return { binding: service.conversationUnreadBinding(ownerId, ASSISTANT_APP_ID, name), byPerson: service.conversationBindingChosenByPerson(ownerId, ASSISTANT_APP_ID, name) };
    } catch (error) {
      if (codeOf(error) !== 'denied') throw error;
      return null;
    }
  };
  const before = read();
  if (!before) return state(true, service.isEnabled(ASSISTANT_APP_ID) ? 'withdrawn' : 'off');
  if (before.byPerson) return state(true, 'chosen');
  const ownChat = deps.ownAssistantChat ?? isOwnAssistantChat;
  let target: string | null;
  try {
    if (chatId === null) {
      // The window shows no assistant: taken off once the bound chat is no longer the account's own assistant chat here too.
      if (!before.binding || await ownChat(token, ownerId, before.binding.chatId)) return state(true, 'kept');
      target = null;
    } else {
      if (before.binding?.chatId === chatId) return state(true, 'kept');
      const own = await ownChat(token, ownerId, chatId);
      if (own === 'pending') return state(true, 'pending');
      if (!own) return state(true, 'refused');
      target = chatId;
    }
  } catch (error) {
    if (codeOf(error) !== 'failed') throw error;
    return state(true, 'unverified');
  }
  // Everything again after the waits: the account, the App and its trust, the person's choice, the same binding.
  await current(ownerId);
  if (await notTrusted(service, deps.trust)) return state(false, 'distrusted');
  const now = read();
  if (!now) return state(true, service.isEnabled(ASSISTANT_APP_ID) ? 'withdrawn' : 'off');
  if (now.byPerson) return state(true, 'chosen');
  if (now.binding?.handle !== before.binding?.handle) return state(true, 'kept');
  service.setConversationUnreadBinding(ownerId, ASSISTANT_APP_ID, name, target, 'host');
  log.info('assistant App entry: binding written by the host', { bound: target !== null });
  // The App's pages hear what the binding is now (`onSurface`), the one way they are told — a page that read before it was
  // there reads again. `bound` itself reaches them once the window draws the conversation beside the page, which it does on
  // the inventory change the caller announces; this tells the pages the binding changed in the meantime.
  await (deps.push ?? (async () => (await import('./extension-bridge')).pushBindingSurfaces(ASSISTANT_APP_ID)))()
    .catch((error: unknown) => log.warn('assistant App entry: the App\'s pages could not be told the binding', { error: String(error) }));
  return state(true, target === null ? 'unbound' : 'bound', true);
}

// ── Hand-over (G6) ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The tab the person last had open on the built-in page, handed to the trusted App once (the window decides when: the first
// time the App is where the entry goes for that account here). Held here until the App's page reads its surface bound for
// that account — its first read or event, whichever comes first — then gone (`ASSISTANT_RESUME_TABS`, unread-binding.ts).
let pendingResume: { ownerId: string; tab: AssistantResumeTab } | null = null;

const handOverSchema = z.strictObject({ ownerId: z.string().uuid(), tab: z.enum(ASSISTANT_RESUME_TABS) });

/** Trusted window only (controller `handOverAssistantPage`). Answers whether it is held for the App (the trusted App is in). */
export async function handOverAssistantPage(
  input: unknown, deps: Pick<AssistantAppEntryDeps, 'trust'> & { push?: () => Promise<void> } = {},
): Promise<boolean> {
  const { ownerId, tab } = handOverSchema.parse(input);
  await current(ownerId);
  const service = extensionsService();
  if (!service.isInstalled(ASSISTANT_APP_ID) || await notTrusted(service, deps.trust)) return false;
  pendingResume = { ownerId, tab };
  // A page already up hears it now.
  await (deps.push ?? (async () => (await import('./extension-bridge')).pushBindingSurfaces(ASSISTANT_APP_ID)))();
  return true;
}

/** What a page of `extensionId` reads or hears: with the held tab, once, if it is the trusted App bound for that account. */
export async function withAssistantPageResume(extensionId: string, surface: AppBindingSurface): Promise<AppBindingSurface> {
  const held = pendingResume;
  if (!held || extensionId !== ASSISTANT_APP_ID || surface.state !== 'bound' || surface.intent) return surface;
  try {
    if ((await account()).ownerId !== held.ownerId) return surface;
  } catch {
    return surface;
  }
  if (pendingResume !== held) return surface;
  pendingResume = null;
  return { ...surface, intent: { kind: 'resume', tab: held.tab } };
}

export function forgetAssistantPageResumeForTest(): void {
  pendingResume = null;
}
