import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { GuguMcpContext } from '../acp-engine-utils'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { passwordBetaAgentPort } from '../password-vault/beta-runtime-port'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { registerGuguTool } from './register-gugu-tool.mjs'

const selectionSchema = z.object({ form: z.string().min(1), account: z.string().min(1), password: z.string().min(1), submitter: z.string().optional() }).strict()
const loginArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), credentialId: z.string().uuid(), browserId: z.string().min(1).optional(), loginUrl: z.string().url(), selection: selectionSchema }).strict(),
  z.object({ action: z.literal('start'), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('status'), requestId: z.string().uuid() }).strict(),
])
const fieldsSchema = z.array(z.object({ name: z.string().trim().min(1).max(200), value: z.string().min(1).max(65536) }).strict()).max(64)
const saveArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), origin: z.string().url(), credentialId: z.string().uuid().optional(),
    account: z.string().max(4096).optional(), password: z.string().max(65536).optional(), fields: fieldsSchema.optional() }).strict(),
  z.object({ action: z.literal('status'), requestId: z.string().uuid() }).strict(),
])

export function registerPasswordBetaTools(server: McpServer, context: () => GuguMcpContext, track: GuguMcpRequestTracker, lifetime: AbortSignal) {
  if (!PASSWORD_BETA_ENABLED) return
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  // The person's request card goes through the host action, which needs this call's signal (as gugu-im-server binds it).
  const bound = (signal: AbortSignal): GuguMcpContext => {
    const value = context()
    if (value.kind !== 'social' || !value.runHostAction) return value
    const run = value.runHostAction
    return { ...value, runHostAction: (action: unknown, own?: AbortSignal) => run(action, own ?? signal) }
  }
  registerGuguTool(server, { name: 'password_credentials', description: 'List saved logins: credentialId, website, masked account, field names, and your access (ask: the person approves each use; read: use without asking; write: also change it). Never returns a password or field value.', schema: z.object({}).strict() },
    async () => { try { return result(await passwordBetaAgentPort().list(context())) } catch { return result({ status: 'unavailable' }) } }, track)
  registerGuguTool(server, { name: 'password_login', description: 'Request a single embedded-browser login. Request returns immediately. With read/write access the result is already approved: call action=start with requestId. Otherwise continue other work: the person receives a private request message, and only after a new approved delivery call action=start. No password is returned. Open the login page in your browser first: the login runs in the tab of this task that shows that site (browserId is optional). Use CSS selectors from the current HTTPS POST login form.',
    // MCP/Anthropic consumers require an object at the root. Validate each action below.
    schema: z.object({ action: z.enum(['request', 'start', 'status']), credentialId: z.string().uuid().optional(),
      browserId: z.string().min(1).optional(), loginUrl: z.string().url().optional(), selection: selectionSchema.optional(), requestId: z.string().uuid().optional() }).strict() }, async (args, signal: AbortSignal) => {
      const parsed = loginArguments.safeParse(args)
      if (!parsed.success) return { ...result({ status: 'invalid_request', retry: false,
        error: 'Invalid password_login arguments: request requires credentialId, loginUrl and selection (browserId optional); start/status requires requestId. Do not mix fields from different actions.' }), isError: true }
      try {
        const input = parsed.data
        if (input.action === 'request') return result(await passwordBetaAgentPort().request(bound(signal), lifetime, input))
        return result(await passwordBetaAgentPort()[input.action](context(), input.requestId))
      } catch { return result({ status: 'unavailable', retry: false }) }
    }, track)
  registerGuguTool(server, { name: 'password_save', description: 'Save a login for later use, or change one (pass credentialId). action=request with origin (https) and any of account, password, fields [{name, value}] such as an API key. With write access on that credential it is saved at once; omitted values keep the stored ones. Otherwise this returns pending and the person fills in or checks the values from a private message; the outcome arrives later as a delivery. Never repeat passwords in chat. action=status with requestId.',
    schema: z.object({ action: z.enum(['request', 'status']), origin: z.string().url().optional(), credentialId: z.string().uuid().optional(),
      account: z.string().max(4096).optional(), password: z.string().max(65536).optional(), fields: fieldsSchema.optional(), requestId: z.string().uuid().optional() }).strict() }, async (args, signal: AbortSignal) => {
      const parsed = saveArguments.safeParse(args)
      if (!parsed.success) return { ...result({ status: 'invalid_request', retry: false,
        error: 'Invalid password_save arguments: request requires origin (https) plus optional credentialId/account/password/fields; status requires requestId only.' }), isError: true }
      try {
        const input = parsed.data
        if (input.action === 'status') return result(await passwordBetaAgentPort().saveStatus(context(), input.requestId))
        const { action: _action, ...proposal } = input
        return result(await passwordBetaAgentPort().save(bound(signal), proposal))
      } catch { return result({ status: 'unavailable', retry: false }) }
    }, track)
}
