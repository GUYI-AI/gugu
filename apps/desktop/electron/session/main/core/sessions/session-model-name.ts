import { concreteModelName, isPlaceholderModel, isUserFacingModelId } from '@gugu/session-core/acp/client';
import type { SessionOptionGroup } from '@gugu/session-core/session-record/contract';
import { eq } from 'drizzle-orm';
import { acpAgentStatusBridge } from '@main/core/acp/agent-status-bridge';
import { readSessionOptions, SessionOptionsError } from '@main/core/session-timeline/live-options';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { sessionModelLabel, sessionPlatformModel } from './platform-model-selection';

/**
 * #3938 The model a session runs, named the way the model list names it — what the agent's card shows (presence
 * `model_name`).
 *
 * - A Gugu model: its catalog name (`sessionModelLabel`); '' when the catalog was read and does not list it.
 * - The harness's own model, while the session is live: the selected option's name (`selectedModelName`).
 * - Not live, a terminal session, no model option reported, the catalog not read yet: null — nothing is known, so
 *   what was published before stands.
 *
 * ❌ fall back to a raw id or「Default」: the owner wants a concrete model name or none at all (11-24 / 11-25).
 */
export async function sessionModelName(sessionId: string): Promise<string | null> {
  const decision = await sessionPlatformModel(sessionId);
  if (decision) {
    const [row] = await db
      .select({ provider: sessions.provider, runtime: sessions.runtime })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) return null;
    const label = await sessionModelLabel(sessionId, decision, row.provider ?? null, row.runtime ?? null);
    if (label) return label;
    // '' kept beside the same model = the catalog answered without it; anything else = it could not be asked yet.
    const after = await sessionPlatformModel(sessionId);
    return after?.modelId === decision.modelId && after.label === '' ? '' : null;
  }
  // Only a session the runtime holds has options; asking for any other one would only hear「not running」.
  if (!acpAgentStatusBridge.current().has(sessionId)) return null;
  const options = await readSessionOptions(sessionId).catch((error: unknown) => {
    if (error instanceof SessionOptionsError && error.code === 'session_not_live') return null;
    throw error;
  });
  return options?.model ? selectedModelName(options.model) : null;
}

/**
 * The selected model's name by the settings model list's rule (`concreteHarnessModels`): a concrete model by its own
 * name; a placeholder (`default`,「Default (recommended)」) by the model its description names. '' when it names no
 * concrete model or is not among the user-facing choices; null when nothing is selected.
 */
export function selectedModelName(group: SessionOptionGroup): string | null {
  if (group.selected === null) return null;
  const choices = group.available.filter((choice) => isUserFacingModelId(choice.id));
  const selected = choices.find((choice) => choice.id === group.selected);
  if (!selected) return '';
  if (!isPlaceholderModel(selected.id, selected.name)) return selected.name;
  const names = choices.filter((choice) => !isPlaceholderModel(choice.id, choice.name)).map((choice) => choice.name);
  return concreteModelName(selected.description, names) ?? '';
}
