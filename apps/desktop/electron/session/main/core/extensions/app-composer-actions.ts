import {
  COMPOSER_RUN_ACTION,
  composerActionRunSchema,
  composerActionsAskSchema,
  type ComposerAction,
  type ComposerActionResult,
  type ComposerActionView,
} from '@shared/extensions/composer-actions';
import { BINDING_ACTION_CAPABILITY, type AppSurfaceIntent } from '@shared/extensions/unread-binding';
import { boundAgent } from './app-bound-resources';
import { account } from './app-unread-bindings';
import { appVoiceNoteStart } from './app-voice-notes';
import { extensionsService } from './extensions-root';

/**
 * #1927 (API 48) The composer 「+」 entries an App placed beside the person's own assistant chat declares
 * (`contributes.conversationSurface.composerActions`), for the trusted window that draws that conversation: which to draw,
 * and running one the person clicked. The host runs it from the App as installed — the window names only the App, the
 * column's authority and the entry's id, never a text, an intent or a chat — and no App code runs on that click.
 *
 * Each run is checked as the App's own calls are: the account the window drew it for, the App installed and on, the column
 * drawn under the App's current authority, the run's binding action granted, the conversation the person's private one
 * with their own assistant and they still in it — and again after every wait (app-bound-resources.ts `boundAgent`).
 */

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

async function signedIn(ownerId: string): Promise<void> {
  if ((await account()).ownerId !== ownerId) throw denied('Account changed');
}

/** The App's entries as installed now, for the column drawn under `authority` (account, installation, switch, grant, choice). */
function declared(ownerId: string, extensionId: string, authority: string): { name: string; actions: readonly ComposerAction[] } {
  const service = extensionsService();
  if (!service.isInstalled(extensionId) || !service.isEnabled(extensionId)) throw denied('This App is not on');
  const surface = service.get(extensionId).manifest.contributes.conversationSurface;
  if (!surface) throw denied('This App is not placed beside a conversation');
  if (service.conversationSurfaceAuthority(ownerId, extensionId, surface.binding) !== authority) throw denied('App conversation surface authority changed');
  return { name: surface.binding, actions: surface.composerActions ?? [] };
}

const granted = (extensionId: string, action: ComposerAction) =>
  extensionsService().hasCapability(extensionId, BINDING_ACTION_CAPABILITY[COMPOSER_RUN_ACTION[action.run.kind]]);

const viewOf = (action: ComposerAction): ComposerActionView => ({ id: action.id, label: { ...action.label }, icon: action.icon, kind: action.run.kind,
  ...(action.chip ? { chip: { ...action.chip } } : {}) });

/**
 * The entries to draw in that column's 「+」, in the App's order: those whose run is granted now. None at all unless the
 * conversation is the person's private one with their own assistant.
 */
export async function composerActionsFor(input: unknown): Promise<{ actions: ComposerActionView[] }> {
  const { ownerId, extensionId, authority } = composerActionsAskSchema.parse(input);
  await signedIn(ownerId);
  const { name, actions } = declared(ownerId, extensionId, authority);
  if (actions.length === 0) return { actions: [] };
  const bound = await boundAgent(extensionId, name, ['surface'], null).catch((error: unknown) => {
    // Not the person's own assistant chat (or no longer theirs): nothing to draw. A check that could not be made is thrown.
    if (codeOf(error) === 'denied') return null;
    throw error;
  });
  if (!bound) return { actions: [] };
  const views = actions.filter((action) => granted(extensionId, action)).map(viewOf);
  declared(ownerId, extensionId, authority);
  return { actions: views };
}

/** The person clicked entry `actionId` in that column: the host runs it. A draft is the window's to put in its composer. */
export async function runComposerAction(
  input: unknown,
  tellPage: (extensionId: string, intent: AppSurfaceIntent) => Promise<boolean>,
): Promise<ComposerActionResult> {
  const { ownerId, extensionId, authority, actionId } = composerActionRunSchema.parse(input);
  await signedIn(ownerId);
  const { name, actions } = declared(ownerId, extensionId, authority);
  const action = actions.find((entry) => entry.id === actionId);
  if (!action) throw Object.assign(new Error(`No composer action "${actionId}" in this App`), { code: 'not-found' });
  const still = () => declared(ownerId, extensionId, authority);
  if (action.run.kind === 'voice-note') {
    // The recorder's own path (API 47): its grant, the personal assistant, the window's account, rechecked after the wait —
    // a grant gone meanwhile stops what it started and is refused there.
    const started = await appVoiceNoteStart(extensionId, { name }, { present: true });
    return { kind: 'voice-note', outcome: started.state === 'unbound' ? 'unavailable' : started.state === 'started' ? 'started' : started.state };
  }
  const bound = await boundAgent(extensionId, name, ['surface', COMPOSER_RUN_ACTION[action.run.kind]], null);
  if (!bound) throw denied('No conversation is chosen for this App');
  await bound.recheck();
  still();
  if (action.run.kind === 'draft') return { kind: 'draft', text: { ...action.run.text } };
  return { kind: 'page-intent', delivered: await tellPage(extensionId, { kind: 'composer-action', id: action.id }) };
}

/**
 * The host's recording bar beside that conversation: the person opened the note it shows. The App's page drawn there is
 * told `voice-note` (no data), its panel expanded — only while it is drawn there for this account.
 */
export async function voiceNoteOpenedBeside(
  input: unknown,
  tellPage: (extensionId: string, intent: AppSurfaceIntent) => Promise<boolean>,
): Promise<boolean> {
  const { ownerId, extensionId } = composerActionsAskSchema.pick({ ownerId: true, extensionId: true }).strict().parse(input);
  await signedIn(ownerId);
  if (!extensionsService().isInstalled(extensionId) || !extensionsService().isEnabled(extensionId)) return false;
  return tellPage(extensionId, { kind: 'voice-note' });
}

/**
 * The host's 「自定义<name>」 hint above that conversation's composer (offered once after the assistant is set up, as the
 * built-in's): the person opened it. The App's page drawn there is told `customize` (no data), its panel expanded — only an
 * App that declared the host's row over the person's own assistant chat (46 `header: "assistant"`), only while it is drawn
 * there for this account.
 */
export async function customizeOpenedBeside(
  input: unknown,
  tellPage: (extensionId: string, intent: AppSurfaceIntent) => Promise<boolean>,
): Promise<boolean> {
  const { ownerId, extensionId } = composerActionsAskSchema.pick({ ownerId: true, extensionId: true }).strict().parse(input);
  await signedIn(ownerId);
  const service = extensionsService();
  if (!service.isInstalled(extensionId) || !service.isEnabled(extensionId)) return false;
  if (service.get(extensionId).manifest.contributes.conversationSurface?.header !== 'assistant') return false;
  return tellPage(extensionId, { kind: 'customize' });
}
