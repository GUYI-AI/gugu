import { eq } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { isValidProviderId } from '../agents/plugin-registry';
import { newSessionMemoryChangedChannel } from '@shared/core/sessions/sessionEvents';
import { sessionPlatformModel } from './platform-model-selection';

/**
 * #3293 A model switched to inside a session becomes the new-session memory's `lastStarted` (product-docs
 * model-access.md: 「上次使用的模型」优先) — once its first reply succeeds, never at the switch itself.
 *
 * The switch is armed where it lands in the session record (`recordLiveModelSwitch`, `reloadEmdashSession`); the next
 * live turn settles it: `done` remembers, `error` drops it (a switch whose first reply fails is not remembered).
 * What is remembered is read back from the session record at that moment — the model that actually replied, not the
 * one a caller asked for. Held in this process: a switch whose reply never comes before a restart is not remembered.
 */
const armed = new Set<string>();

export function armSwitchedModelMemory(sessionId: string): void {
  armed.add(sessionId);
}

export async function settleSwitchedModelMemory(sessionId: string, outcome: TranscriptTurn['outcome']): Promise<void> {
  if (!outcome || !armed.has(sessionId)) return;
  if (outcome.kind === 'cancelled') return; // stopped by hand: says nothing about the model, keep waiting
  armed.delete(sessionId);
  if (outcome.kind !== 'done') return;
  const [row] = await db.select({ provider: sessions.provider, config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId));
  const provider = row?.provider;
  if (!provider || !isValidProviderId(provider)) return;
  const platform = await sessionPlatformModel(sessionId);
  const model = platform ? undefined : row.config?.model?.trim();
  if (!platform && !model) return; // the harness's own default: nothing named to preselect
  const { appSettingsService } = await import('@main/core/settings/settings-service');
  const memory = await appSettingsService.get('newSessionMemory');
  const previous = memory.lastStarted?.provider === provider ? memory.lastStarted : null;
  const effort = row.config?.effort?.trim();
  await appSettingsService.update('newSessionMemory', {
    ...memory,
    lastStarted: {
      provider: provider as AgentProviderId,
      ...(model && { model }),
      ...(platform && { platformModel: platform.modelId }),
      ...(effort && { effort }),
      ...(previous?.permissionMode && { permissionMode: previous.permissionMode }),
      // A model switch is not an engine pick: another engine's switch must not outrank settings' default agent.
      providerChosenByUser: previous?.providerChosenByUser ?? false,
    },
  });
  events.emit(newSessionMemoryChangedChannel, {});
}

/** Fire-and-forget form for the turn writer: the memory never stands in the way of a reply. */
export function noteSwitchedModelReply(sessionId: string, outcome: TranscriptTurn['outcome']): void {
  if (!armed.has(sessionId)) return;
  void settleSwitchedModelMemory(sessionId, outcome).catch((error: unknown) => {
    log.error('remember the switched model failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
  });
}
