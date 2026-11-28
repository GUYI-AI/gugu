import { readFileSync } from 'node:fs'
import { atomicWriteText } from '@gugu/core/local/state/paths'
import { clearStoredServerSession, readStoredServerSession, type ServerSessionTokens } from './server-auth'
import { isServerSessionId } from './server-names'

function sessionId(token: string, userId: string): string {
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown; session_id?: unknown }
  if (claims.sub !== userId || typeof claims.session_id !== 'string' || !isServerSessionId(claims.session_id)) {
    throw new Error('The stored login does not identify this account and server session')
  }
  return claims.session_id.toLowerCase()
}

type UninstallLoginDeps = {
  receipt: string
  read: () => ServerSessionTokens | null
  markRevoked: (receipt: string) => void | Promise<void>
  clear: () => void | Promise<void>
}

/** The expired JWT identifies the installation login. Only the desktop can confirm its cloud revocation. */
export async function revokeServerLogin(userId: string, deps: UninstallLoginDeps, confirmedSession?: string): Promise<string> {
  const revoked = deps.receipt.split('\n')[1]
  if (deps.receipt !== `${userId}\n` && (!revoked || !isServerSessionId(revoked) || deps.receipt !== `${userId}\n${revoked}\n`)) {
    throw new Error('Task archival was not confirmed for this account')
  }
  const stored = deps.read()
  const id = stored ? sessionId(stored.accessToken, userId) : revoked
  if (!id) throw new Error('The stored server login is missing')
  if ((revoked && revoked !== id) || (confirmedSession !== undefined && confirmedSession !== id)) {
    throw new Error('The server account changed during uninstall')
  }
  if (confirmedSession === undefined) return id
  if (!revoked) await deps.markRevoked(`${userId}\n${id}\n`)
  await deps.clear()
  return id
}

export async function revokeStoredServerLogin(userId: string, archiveReceipt: string, confirmedSession?: string): Promise<string> {
  const archived = readFileSync(archiveReceipt, 'utf8')
  const { stopRegisteredSystemdService } = await import('./server-service')
  stopRegisteredSystemdService()
  if (readFileSync(archiveReceipt, 'utf8') !== archived) throw new Error('The server restarted after task archival')
  return revokeServerLogin(userId, {
    receipt: archived,
    read: readStoredServerSession,
    markRevoked: (receipt) => atomicWriteText(archiveReceipt, receipt),
    clear: clearStoredServerSession,
  }, confirmedSession)
}
