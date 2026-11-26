import { z } from 'zod';

/** A host-owned App identity. A page cannot choose its sender or widen its recipient scope. */
// Outside the installable manifest ID grammar: a third-party bundle cannot impersonate this sender.
export const ASSISTANT_PANEL_APP = { extensionId: 'gugu.assistant', extensionName: '个人助理面板' } as const;
export const ASSISTANT_PANEL_SERVER = 'resources';

const summary = z.object({
  name: z.string().optional(), description: z.string().optional(), group: z.string().nullable().optional(),
  path: z.string().optional(), modifiedAt: z.string().optional(), active: z.boolean().optional(),
  cron: z.string().nullable().optional(), at: z.string().nullable().optional(), tz: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(), action: z.string().optional(),
}).strict();

/** Committed facts only. Never pass resource bodies, model prompts, tokens or integration configuration here. */
export const assistantAppChangeSchema = z.object({
  operationId: z.string().uuid(),
  resource: z.enum(['devices', 'projects', 'memory', 'pending-work', 'personality', 'files', 'integrations', 'schedules', 'assistant']),
  operation: z.enum(['created', 'edited', 'removed', 'saved']),
  id: z.string().min(1), deviceId: z.string().optional(),
  section: z.enum(['folders', 'accounts', 'appearance', 'profile', 'permissions']).optional(),
  before: summary.optional(), after: summary.optional(),
}).strict();
export type AssistantAppChange = z.infer<typeof assistantAppChangeSchema>;
