import { agentHomeOperationSchema } from '@gugu/session-core/workspace-server/agent-config'
import { AGENT_HOME_CALL, ATTACH_EXIT } from '../session/main/core/pty/attach/attach-protocol'
import { accountRequestError, callAccountProcess } from './account-call'
import { readServerAccount } from './server-layout'

const usage = 'Usage: gugu-server agent-home status | import <provider> [--groups settings,mcp,...] | skip <provider>'

export async function runAgentHome(
  args: readonly string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  deps = { account: readServerAccount, call: callAccountProcess },
): Promise<number> {
  const [action, providerId, option, value] = args
  if (action === '--help' || action === '-h') { io.stdout.write(`${usage}\n`); return 0 }
  const groups = option === '--groups' ? value : option?.startsWith('--groups=') ? option.slice('--groups='.length) : undefined
  const validLength = action === 'status' ? args.length === 1
    : action === 'skip' ? args.length === 2
      : args.length === 2 || !!groups && args.length === (option === '--groups' ? 4 : 3)
  const request = agentHomeOperationSchema.safeParse({ action, providerId, groups: groups?.split(',') })
  if (!validLength || !request.success) { io.stderr.write(`${usage}\n`); return 2 }

  const account = deps.account()
  const accountError = accountRequestError(account, process.env.GUGU_SERVER_ACCOUNT?.trim() ?? null)
  if (accountError || !account) {
    io.stderr.write(`${accountError} Run gugu-server login and gugu-server start.\n`)
    return ATTACH_EXIT.notSignedIn
  }
  const outcome = await deps.call(account, { type: AGENT_HOME_CALL, payload: request.data })
  if ('code' in outcome) { io.stderr.write(`${outcome.message}\n`); return outcome.code }
  let response: { result?: unknown; error?: { message?: string } }
  try { response = JSON.parse(outcome.reply.toString('utf8')) }
  catch { io.stderr.write('Invalid response from the Gugu server account process.\n'); return 1 }
  if (response.result === undefined) {
    io.stderr.write(`${response.error?.message ?? 'Agent home command failed.'}\n`)
    return 1
  }
  io.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`)
  return 0
}
