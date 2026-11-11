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
// The one definition is #1931's (assistant-rules-trust.ts): the App whose product rules the host believes is the App this
// entry trusts — its id, installed from the market, its code in gugu's market repository as its signed release (the proof
// verifying again, the files still the signed bytes), not a fork.

/** Why the installed App is not the trusted assistant App — the first condition that fails — or null when it is. */
export async function assistantAppDistrust(
  service: AssistantRulesInstallRecord, conditions?: readonly AssistantRulesTrustCondition[],
): Promise<string | null> {
  const provider = installedAssistantRulesProvider(service);
  return provider ? assistantRulesDistrust(provider, conditions) : 'it is not installed';
}

// ── The binding ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What one sync found. `trusted`: the installed App is the trusted assistant App. `changed`: the host wrote the binding.
 * - absent / distrusted: no trusted App; nothing touched.
 * - off: switched off. withdrawn: `chat:unread` taken back (the binding goes with it). undeclared: no binding declared.
 * - chosen: the person chose (or removed) its conversation themselves — left as they chose.
 * - bound / unbound: written now. kept: already as it should be, or changed meanwhile (the next sync decides).
 * - refused: the chat named is not the account's private chat with its own assistant. unverified: it could not be checked now.
 */
export type AssistantAppEntryOutcome = 'absent' | 'distrusted' | 'off' | 'withdrawn' | 'undeclared' | 'chosen'
  | 'bound' | 'unbound' | 'kept' | 'refused' | 'unverified';
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
  distrust?: (service: AssistantRulesInstallRecord) => Promise<string | null>;
  ownAssistantChat?: (token: string, ownerId: string, chatId: string) => Promise<boolean>;
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
  if (!service.isInstalled(ASSISTANT_APP_ID)) return state(false, 'absent');
  const distrust = await (deps.distrust ?? assistantAppDistrust)(service);
  if (distrust) {
    log.info('assistant App entry: not the trusted App', { reason: distrust });
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
      if (!await ownChat(token, ownerId, chatId)) return state(true, 'refused');
      target = chatId;
    }
  } catch (error) {
    if (codeOf(error) !== 'failed') throw error;
    return state(true, 'unverified');
  }
  // Everything again after the waits: the account, the App and its trust, the person's choice, the same binding.
  await current(ownerId);
  if (await (deps.distrust ?? assistantAppDistrust)(service)) return state(false, 'distrusted');
  const now = read();
  if (!now) return state(true, service.isEnabled(ASSISTANT_APP_ID) ? 'withdrawn' : 'off');
  if (now.byPerson) return state(true, 'chosen');
  if (now.binding?.handle !== before.binding?.handle) return state(true, 'kept');
  service.setConversationUnreadBinding(ownerId, ASSISTANT_APP_ID, name, target, 'host');
  log.info('assistant App entry: binding written by the host', { bound: target !== null });
  return state(true, target === null ? 'unbound' : 'bound', true);
}
