import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { GuguMcpContext } from '../acp-engine-utils'
import type { SaveProposal } from './beta-save'
import type { CredentialSearch } from './beta-agent-view'
import type { FillRequest } from './fill-plan'

/** password_fill on a browser page. Without credentialId: the credential of that page's website, when there is one. */
export type FillInput = FillRequest & { credentialId?: string }

/** The Agent's password tools: on a desktop the local vault (beta-host.ts), on a Gugu server the account's desktop (server-agent.ts). */
export interface PasswordAgentPort {
  list(context: GuguMcpContext, search?: CredentialSearch): Promise<unknown>
  request(context: GuguMcpContext, signal: AbortSignal, input: FillInput): Promise<unknown>
  start(context: GuguMcpContext, requestId: string): Promise<unknown>
  status(context: GuguMcpContext, requestId: string): Promise<unknown>
  save(context: GuguMcpContext, input: SaveProposal & { origin: string; credentialId?: string }): Promise<unknown>
  saveStatus(context: GuguMcpContext, requestId: string): Promise<unknown>
}
let port: PasswordAgentPort | undefined
/** Main binds exactly one implementation per process. */
export function bindPasswordBetaAgent(value: PasswordAgentPort): void {
  if (!PASSWORD_BETA_ENABLED || port) return
  port = Object.freeze({ list: value.list.bind(value), request: value.request.bind(value),
    start: value.start.bind(value), status: value.status.bind(value), save: value.save.bind(value), saveStatus: value.saveStatus.bind(value) })
}
export function passwordBetaAgentPort(): PasswordAgentPort {
  if (!PASSWORD_BETA_ENABLED || !port) throw new Error('password_beta_unavailable')
  return port
}
