import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { GuguMcpContext } from '../acp-engine-utils'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { passwordBetaAgentPort } from '../password-vault/beta-runtime-port'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { registerGuguTool } from './register-gugu-tool.mjs'

const selectionSchema = z.object({ form: z.string().min(1), account: z.string().min(1), password: z.string().min(1), submitter: z.string().optional() }).strict()
const loginArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), credentialId: z.string().uuid(), browserId: z.string().min(1), loginUrl: z.string().url(), selection: selectionSchema }).strict(),
  z.object({ action: z.literal('start'), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('status'), requestId: z.string().uuid() }).strict(),
])

export function registerPasswordBetaTools(server: McpServer, context: () => GuguMcpContext, track: GuguMcpRequestTracker, lifetime: AbortSignal) {
  if (!PASSWORD_BETA_ENABLED) return
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  registerGuguTool(server, { name: 'password_credentials', description: 'List saved website references and masked accounts. Never returns a password. Ask the person to set up/unlock Passwords in Settings if unavailable.', schema: z.object({}).strict() },
    async () => { try { return result(await passwordBetaAgentPort().list(context())) } catch { return result({ status: 'unavailable' }) } }, track)
  registerGuguTool(server, { name: 'password_login', description: 'Request a single embedded-browser login. Request returns immediately; continue other work. The person receives a private request message. Only after a new approved delivery call action=start with requestId. No password is returned. Use CSS selectors from the current HTTPS POST login form.',
    // MCP/Anthropic consumers require an object at the root. Validate each action below.
    schema: z.object({ action: z.enum(['request', 'start', 'status']), credentialId: z.string().uuid().optional(),
      browserId: z.string().min(1).optional(), loginUrl: z.string().url().optional(), selection: selectionSchema.optional(), requestId: z.string().uuid().optional() }).strict() }, async args => {
      const parsed = loginArguments.safeParse(args)
      if (!parsed.success) return { ...result({ status: 'invalid_request', retry: false,
        error: 'Invalid password_login arguments: request requires credentialId, browserId, loginUrl and selection; start/status requires requestId. Do not mix fields from different actions.' }), isError: true }
      try {
        const input = parsed.data
        if (input.action === 'request') return result(await passwordBetaAgentPort().request(context(), lifetime, input))
        return result(await passwordBetaAgentPort()[input.action](context(), input.requestId))
      } catch { return result({ status: 'unavailable', retry: false }) }
    }, track)
}
