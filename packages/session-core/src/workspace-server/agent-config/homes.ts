import { z } from 'zod';

export const agentHomeGroupIdSchema = z.enum(['settings', 'hooks', 'mcp', 'rules', 'skills', 'agents', 'models']);
export const agentHomeIssueSchema = z.object({
  path: z.string(),
  reason: z.enum(['symlink', 'sensitive', 'database', 'tooLarge', 'sourceChanged', 'unreadable']),
});
export const agentHomeScanSchema = z.object({
  providerId: z.string(), name: z.string(), userRoot: z.string(), sourceReadable: z.boolean(),
  importedAt: z.string().nullable(), needsImport: z.boolean(), sourceUpdated: z.boolean(),
  migration: z.boolean(),
  groups: z.array(z.object({ id: agentHomeGroupIdSchema, count: z.number(), mcpCount: z.number().optional() })),
  issues: z.array(agentHomeIssueSchema),
  mcpSecrets: z.array(z.string()), projectMcpCount: z.number(), unmarkedMcp: z.array(z.string()).optional(),
});
export const agentHomeImportResultSchema = z.object({
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
