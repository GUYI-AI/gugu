import { z } from 'zod';

export const AGENT_HOME_NOT_IMPORTED = 'AGENT_HOME_NOT_IMPORTED';
export const AGENT_HOME_IMPORT_REQUIRED = 'AGENT_HOME_IMPORT_REQUIRED';

export function isAgentHomeImportCode(code: unknown): code is typeof AGENT_HOME_NOT_IMPORTED | typeof AGENT_HOME_IMPORT_REQUIRED {
  return code === AGENT_HOME_NOT_IMPORTED || code === AGENT_HOME_IMPORT_REQUIRED;
}

/** Electron invoke can transport only an Error string. Its final segment carries the code. */
export function isAgentHomeImportMessage(message: string): boolean {
  return isAgentHomeImportCode(message.trim().split(': ').at(-1));
}

export const agentHomeGroupIdSchema = z.enum(['settings', 'hooks', 'mcp', 'rules', 'skills', 'agents', 'models']);
export const agentHomeIssueSchema = z.object({
  path: z.string(),
  reason: z.enum(['symlink', 'sensitive', 'database', 'tooLarge', 'sourceChanged', 'unreadable', 'excluded', 'historyLimit']),
});
const historyImportSchema = z.object({ imported: z.number(), skipped: z.number(), sessionBytes: z.number(), limitBytes: z.number() });
export const agentHomeScanSchema = z.object({
  providerId: z.string(), name: z.string(), userRoot: z.string(), sourceReadable: z.boolean(),
  importedAt: z.string().nullable(), needsImport: z.boolean(), sourceUpdated: z.boolean(),
  migration: z.boolean(),
  migrationPreparation: z.object({ phase: z.enum(['preparing', 'copying', 'history']), startedAt: z.number(), attempt: z.number() }).optional(),
  nativeHistory: z.object({ removed: z.number(), pending: z.number(), retained: z.number(), unowned: z.number() }).optional(),
  historyImport: historyImportSchema.optional(),
  migrationSpace: z.object({ requiredBytes: z.number(), availableBytes: z.number(), shortfallBytes: z.number() }).optional(),
  upgraded: z.boolean().optional(), upgradeSignIn: z.enum(['copied', 'relogin']).optional(),
  terminalNeedsSignIn: z.boolean().optional(), oldSessionsSkipped: z.number().optional(), upgradeIssues: z.array(agentHomeIssueSchema).optional(),
  groups: z.array(z.object({ id: agentHomeGroupIdSchema, count: z.number(), mcpCount: z.number().optional() })),
  issues: z.array(agentHomeIssueSchema),
  mcpSecrets: z.array(z.string()), projectMcpCount: z.number(), unmarkedMcp: z.array(z.string()).optional(),
});
export const agentHomeImportResultSchema = z.object({
  historyImport: historyImportSchema.optional(),
  issues: z.array(agentHomeIssueSchema),
  terminalNeedsSignIn: z.boolean().optional(), oldSessionsSkipped: z.number().optional(),
  relogin: z.array(z.object({ connectionId: z.string(), name: z.string(), methodId: z.string() })).optional(),
});
export const agentHomeDiffSchema = z.object({
  entries: z.array(z.object({
    id: z.string(), path: z.string(), group: agentHomeGroupIdSchema,
    state: z.enum(['unchanged', 'userChanged', 'guguChanged', 'bothChanged', 'userAdded', 'userDeleted']),
    uncertain: z.boolean().optional(), revision: z.string(),
  })),
  issues: z.array(agentHomeIssueSchema),
});
export type AgentHomeScan = z.infer<typeof agentHomeScanSchema>;
export type AgentHomeDiff = z.infer<typeof agentHomeDiffSchema>;

export const agentHomeOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('import'), providerId: z.string(), groups: z.array(agentHomeGroupIdSchema).optional() }),
  z.object({ action: z.literal('skip'), providerId: z.string() }),
]);
