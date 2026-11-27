import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { createAssistantPanelClient, type AssistantPanelClient, type AssistantPanelItem } from '@gugu/core/cloud/assistantPanel';
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles';
import { ASSISTANT_APP_ID, pickAssistant } from '@gugu/core/shared/assistantProvision';
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs';
import type { AppBoundSchedule } from './bound-schedules';

/**
 * #1928 (shared since API 49: the desktop's main and the phone's binding host read it the same way)
 * The bound agent's schedules when it is the person's assistant living on another computer or in the cloud — the
 * source and the path the built-in 已安排 panel takes there (`assistant-panel-routines.ts`). Read: the panel's `schedules`
 * collection as it was last published, through the built-in panel's own reader (`createAssistantPanelFiles`,
 * `collection`). Read only: a change is refused (bound-resources-core.ts `panelChangeRefused`).
 */

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
const iso = (at: unknown) => {
  const ms = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** Where the assistant's panel is, read as the person. */
export type PanelHome = { ownerId: string; assistantId: string; deviceId: string; cloud: AssistantPanelClient };

/** The built-in panel's client, over main's own connection, with the person's token. */
export function panelAs(token: string, ownerId: string): AssistantPanelClient {
  return createAssistantPanelClient(async (name, args) => {
    const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
    const { data, error, status } = await client.rpc(name, args).abortSignal(AbortSignal.timeout(10_000));
    return { data, error, status };
  }, () => ownerId);
}

/** The person's assistant and its home device, as the built-in panel finds it (`personalAssistant`); null: none. */
export async function personalAssistantOf(token: string, _ownerId: string): Promise<{ agentId: string; deviceId: string } | null> {
  const { data, error } = await createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } })
    .rpc('my_app_agent', { p_app_id: ASSISTANT_APP_ID })
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) throw coded('failed', 'Could not read the personal assistant');
  try {
    return pickAssistant(data);
  } catch {
    throw coded('failed', 'Could not verify the personal assistant');
  }
}

const refuse = async (): Promise<never> => { throw coded('invalid', 'A schedule has no body'); };

/**
 * The `schedules` collection exactly as the built-in panel reads it: only once the home has published it, with nothing
 * stale and no change to it the home failed to apply — anything else is `unavailable`, never a guess or an empty list.
 */
async function scheduleItems(home: PanelHome, recheck: () => Promise<void>): Promise<AssistantPanelItem[]> {
  const files = createAssistantPanelFiles({
    ownerId: home.ownerId, assistantId: home.assistantId, deviceId: home.deviceId, cloud: home.cloud,
    assertCurrent: recheck, readBody: refuse, upload: refuse, discard: refuse, changed: () => undefined,
  });
  try {
    return await files.collection('schedules');
  } catch (error) {
    if (codeOf(error) === 'denied') throw error;
    throw coded(codeOf(error) === 'account-changed' ? 'denied' : 'unavailable',
      'The assistant\'s home has not published its schedules, or a change to them is unresolved, or the cloud did not answer: try again later');
  }
}

function scheduleOf(item: AssistantPanelItem, now: number): AppBoundSchedule {
  const { data } = item;
  const at = typeof data.at === 'number' ? data.at : null;
  const last = data.lastRun && typeof data.lastRun === 'object' ? data.lastRun as { status?: unknown; at?: unknown } : null;
  return {
    id: encodeTypedId('schedule', item.resource_key),
    revision: item.revision,
    title: typeof data.title === 'string' ? data.title : '',
    prompt: typeof data.prompt === 'string' ? data.prompt : '',
    at: iso(at),
    cron: at == null && typeof data.cron === 'string' && data.cron ? data.cron : null,
    tz: typeof data.tz === 'string' ? data.tz : null,
    state: data.enabled === true ? 'active' : at != null && at <= now ? 'ended' : 'paused',
    nextRunAt: data.enabled === true ? iso(data.nextRunAt) : null,
    lastRun: last ? { status: last.status === 'done' || last.status === 'failed' || last.status === 'skipped' ? last.status : 'running', at: iso(last.at) } : null,
    updatedAt: iso(item.updated_at) ?? new Date(0).toISOString(),
  };
}

export async function listPanelSchedules(home: PanelHome, recheck: () => Promise<void>): Promise<AppBoundSchedule[]> {
  const now = Date.now();
  return (await scheduleItems(home, recheck)).map((item) => scheduleOf(item, now));
}

/** A fingerprint of the schedules and their outstanding changes, so a panel change that is not theirs is not heard. */
export async function panelSchedulesPrint(home: PanelHome): Promise<string> {
  const snapshot = await home.cloud.snapshot(home.assistantId);
  return JSON.stringify([
    snapshot.items.filter((item) => item.domain === 'schedules').map((item) => [item.resource_key, item.revision, item.deleted_at, item.stale_at ?? null]).sort(),
    snapshot.application.filter((row) => row.domain === 'schedules').map((row) => [row.operationId, row.status]).sort(),
  ]);
}
