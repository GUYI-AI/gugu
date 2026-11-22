import { z } from 'zod';
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '@gugu/core/shared/agentStatus';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { sessionLifecycleSchema } from '@gugu/session-core/acp/client';

// Deliberately closed: no generic payload, title, message body or tool arguments in this index.
const id = z.string().min(1).max(512);
export const activityEventSchema = z.object({
  event_id: id,
  kind: z.enum(['session.created', 'session.renamed', 'session.archived', 'session.deleted',
    'session.input_submitted', 'agent.status', 'session.message_delivered',
    'question.pending', 'question.resolved', 'question.cancelled', 'automation.run',
    // The session's runtime committed a turn (`object_id` its runtime id, `related_object_id` a key the agent numbered
    // in it, `identityKeys`, which its record keeps) / a revert removed turns from the history.
    'session.turn_recorded', 'session.history_reverted',
    // project.* events were written by earlier releases only (a group is the only container now).
    'project.created', 'project.deleted', 'project.folder_attached', 'project.folder_detached',
    'project.group_bound', 'project.group_unbound', 'app.source_created', 'app.source_updated',
    'app.installed', 'app.replaced', 'session.model_changed', 'session.lifecycle', 'device.sleep']),
  occurred_at: z.number().int().nonnegative().nullable(),
  observed_at: z.number().int().nonnegative(),
  session_id: id.optional(),
  /** The group the event's subject lives in. */
  chat_id: id.optional(),
  related_session_id: id.optional(),
  parent_session_id: id.optional(),
  spawned_by_session_id: id.optional(),
  object_id: id.optional(),
  related_object_id: id.optional(),
  /** Historical: the stored-history position older turn events carry. Nothing reads it now. */
  turn_seq: z.number().int().nonnegative().optional(),
  app_version: id.optional(),
  model_id: id.optional(),
  previous_model_id: id.optional(),
  sleep_until_at: z.number().int().nonnegative().optional(),
  sleep_source: z.enum(['native-power', 'fc-confirmed']).optional(),
  lifecycle: sessionLifecycleSchema.optional(),
  source_ref: z.string().max(2048).refine(value => parseConversationLink(value) !== null, 'source_ref must be a conversation locator').optional(),
  status: z.enum([...AGENT_STATUSES, 'scheduled', 'queued',
    'creating_session', 'launching_session', 'starting_agent', 'done', 'failed', 'skipped']).optional(),
  detail: z.enum(AGENT_STATUS_DETAILS).nullable().optional(),
}).strict();
export type ActivityEvent = z.infer<typeof activityEventSchema>;
/**
 * What a producer reports. It never names a group: the journal derives `chat_id` from the event's subject (its
 * session, or the folder of its run's automation), in one place, so no producer can omit or contradict it.
 */
export const activityObservationSchema = activityEventSchema.omit({ chat_id: true }).superRefine((event, ctx) => {
  if (event.kind === 'device.sleep' && (event.occurred_at === null || event.sleep_until_at === undefined
    || event.sleep_until_at <= event.occurred_at || !event.sleep_source)) {
    ctx.addIssue({ code: 'custom', path: ['sleep_until_at'], message: 'Device sleep requires a confirmed ordered interval and source' });
  }
});
export type ActivityObservation = z.infer<typeof activityObservationSchema>;

export const activityQuerySchema = z.object({
  since: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  session_id: id.optional(),
  chat_id: id.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(4096).optional(),
}).strict().refine(q => Date.parse(q.since) < Date.parse(q.until), 'until must be later than since');
export type ActivityQuery = z.input<typeof activityQuerySchema>;
