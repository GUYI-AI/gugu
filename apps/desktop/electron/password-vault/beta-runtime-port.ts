import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { passwordBetaAgent } from './beta-host'

type Port = typeof passwordBetaAgent
let port: Port | undefined
/** Main's existing embedded backend supplies its ONE browser registry/vault instance. */
export function bindPasswordBetaAgent(value: Port): void {
  if (!PASSWORD_BETA_ENABLED || port) return
  port = Object.freeze({ list: value.list.bind(value), request: value.request.bind(value),
    start: value.start.bind(value), status: value.status.bind(value) })
}
export function passwordBetaAgentPort(): Port {
  if (!PASSWORD_BETA_ENABLED || !port) throw new Error('password_beta_unavailable')
  return port
}
