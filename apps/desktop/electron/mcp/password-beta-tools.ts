import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { GuguMcpContext } from '../acp-engine-utils'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { passwordBetaAgentPort } from '../password-vault/beta-runtime-port'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { registerGuguTool } from './register-gugu-tool.mjs'

const fillEntrySchema = z.object({ field: z.string().trim().min(1).max(200), into: z.string().min(1).max(1000), code: z.boolean().optional(), value: z.string().max(4096).optional() }).strict()
const fillArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), on: z.enum(['browser', 'screen', 'terminal']).default('browser'), credentialId: z.string().uuid().optional(),
    url: z.string().url(), browserId: z.string().min(1).optional(), fill: z.array(fillEntrySchema).min(1).max(16) }).strict(),
  z.object({ action: z.literal('start'), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('status'), requestId: z.string().uuid() }).strict(),
])
const fieldsSchema = z.array(z.object({ name: z.string().trim().min(1).max(200), value: z.string().min(1).max(65536).optional(), secret: z.boolean().optional() }).strict()).max(64)
const saveArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), origin: z.string().url(), credentialId: z.string().uuid().optional(), name: z.string().trim().max(200).optional(),
    account: z.string().max(4096).optional(), accountSecret: z.boolean().optional(), password: z.string().max(65536).optional(), fields: fieldsSchema.optional() }).strict(),
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
  registerGuguTool(server, { name: 'password_credentials', description: 'Find saved credentials (logins, API keys): credentialId, name, website, the names of its values and your access (ask: the person approves each use; read: use without asking; write: also change it). Secret values (passwords, keys) are never returned; with read/write access you also get the account and values marked non-secret. Filters: site (matches subdomains), query (name, website, value names), field (has a value of this name), usable (no approval needed); rows pages ("21-40"), 20 by default.',
    schema: z.object({ site: z.string().max(253).optional(), query: z.string().max(200).optional(), field: z.string().max(200).optional(), usable: z.boolean().optional(),
      rows: z.string().regex(/^\d+(?:-\d+)?$/).optional() }).strict() },
    async args => { try { return result(await passwordBetaAgentPort().list(context(), args)) } catch { return result({ status: 'unavailable' }) } }, track)
  registerGuguTool(server, { name: 'password_fill', description: 'Fill values (account, password, an API key, a one-time code) into the inputs of a page in your browser, without ever seeing them, like a person\'s autofill: nothing is submitted, you press the button (登录, 保存) yourself afterwards and read the result. Open the page in your browser first. action=request with url (the page your tab shows), fill [{field, into, value?}] (field: 账号, 密码 or the name of a value; into: a CSS selector of a visible input on that page; value: one you already know and that is not a secret, such as the username; code:true for the current 6-digit code of a saved value holding a TOTP seed). What is saved is used; what is not saved and not given, the person types in (never ask for a secret in chat: call this instead), and may keep it for next time. credentialId is optional: without it the credential saved for that website is used, the person fills in when nothing is saved, or you get the candidates to choose from. With read/write access, on its own websites, into inputs that hide secrets, with every value saved, it is filled at once and this returns status filled. Otherwise it returns pending: the person checks and fills in from a private message; continue other work, the outcome arrives as a delivery (filled, or why not). After filled, press the page\'s button. No value is returned. action=status with requestId. on=screen and on=terminal are not available yet.',
    // MCP/Anthropic consumers require an object at the root. Validate each action below.
    schema: z.object({ action: z.enum(['request', 'start', 'status']), on: z.enum(['browser', 'screen', 'terminal']).optional(), credentialId: z.string().uuid().optional(),
      url: z.string().url().optional(), browserId: z.string().min(1).optional(), fill: z.array(fillEntrySchema).max(16).optional(),
      requestId: z.string().uuid().optional() }).strict() }, async (args, signal: AbortSignal) => {
      const parsed = fillArguments.safeParse(args)
      if (!parsed.success) return { ...result({ status: 'invalid_request', retry: false,
        error: 'Invalid password_fill arguments: request requires url and fill (credentialId and browserId optional); status requires requestId. Do not mix fields from different actions.' }), isError: true }
      try {
        const input = parsed.data
        if (input.action === 'request') {
          if (input.on !== 'browser') return result({ status: 'not_available', retry: false, error: `password_fill on=${input.on} is not available yet; ask the person to type it.` })
          const { action: _action, on: _on, ...request } = input
          return result(await passwordBetaAgentPort().request(bound(signal), lifetime, request))
        }
        return result(await passwordBetaAgentPort()[input.action](context(), input.requestId))
      } catch { return result({ status: 'unavailable', retry: false }) }
    }, track)
  registerGuguTool(server, { name: 'password_save', description: 'Save a credential for later use, or change one (pass credentialId). action=request with origin (https), an optional name, and any of account, password, fields [{name, value?, secret?}] such as an API key, a host or a username. Fill in what you already know and leave secret values you do not have without a value: the person fills those in. Values are secret by default; mark a value secret:false when it is not (a host, a username), and accountSecret:true when the account itself is. With write access on that credential it is saved at once; omitted values keep the stored ones. Otherwise, and whenever a value would stop being secret or a new value is missing, this returns pending and the person checks and completes it from a private message; the outcome arrives later as a delivery. Never repeat secret values in chat. action=status with requestId.',
    schema: z.object({ action: z.enum(['request', 'status']), origin: z.string().url().optional(), credentialId: z.string().uuid().optional(), name: z.string().trim().max(200).optional(),
      account: z.string().max(4096).optional(), accountSecret: z.boolean().optional(), password: z.string().max(65536).optional(), fields: fieldsSchema.optional(), requestId: z.string().uuid().optional() }).strict() }, async (args, signal: AbortSignal) => {
      const parsed = saveArguments.safeParse(args)
      if (!parsed.success) return { ...result({ status: 'invalid_request', retry: false,
        error: 'Invalid password_save arguments: request requires origin (https) plus optional credentialId/name/account/accountSecret/password/fields; status requires requestId only.' }), isError: true }
      try {
        const input = parsed.data
        if (input.action === 'status') return result(await passwordBetaAgentPort().saveStatus(context(), input.requestId))
        const { action: _action, ...proposal } = input
        return result(await passwordBetaAgentPort().save(bound(signal), proposal))
      } catch { return result({ status: 'unavailable', retry: false }) }
    }, track)
}
