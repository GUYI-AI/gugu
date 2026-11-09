import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, ipcMain, BrowserWindow } from 'electron'
import { createLogger } from './lib/logger'
import { createErrorSummaryConsentStore, ERROR_SUMMARY_CONSENT_CHANNELS as channels } from '../shared/error-summary-consent'

/** 「帮助改进咕咕」的本机记录:谁在用(哈希后的账号)→ 关没关。上报宿主每次发送前都来这里问一遍。 */
export function registerErrorSummaryConsent(deps: {
  eligible: boolean
  owner: () => string | null | undefined
}) {
  const file = join(app.getPath('userData'), 'error-summary-consent.json')
  const discardPending = () => {
    try { unlinkSync(join(app.getPath('userData'), 'pending-error-summaries.json')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const changed = () => {
    ipcMain.emit(channels.changed)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(channels.changed)
    }
  }
  const store = createErrorSummaryConsentStore({
    eligible: deps.eligible,
    scope: () => {
      const owner = deps.owner()
      return owner === undefined ? undefined : owner === null ? 'anonymous' : createHash('sha256').update(owner).digest('hex')
    },
    read: () => {
      try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    save: record => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    },
    changed,
    withdraw: discardPending,
  })
  // In-process callback only; IPC senders cannot serialize a function.
  ipcMain.on('error-summary:read-local-consent', (reply: unknown) => {
    if (typeof reply === 'function') reply(store.snapshot())
  })
  ipcMain.handle(channels.read, () => store.snapshot())
  ipcMain.handle(channels.write, (_event, decision: unknown, scope: unknown) => store.set(decision, scope))
  let previousOwner = deps.owner()
  return {
    ...store,
    identityChanged: () => {
      const owner = deps.owner()
      if (owner === previousOwner) return
      const previous = previousOwner
      previousOwner = owner
      changed()
      if (previous === undefined) return
      try { discardPending() } catch {
        store.block()
        createLogger('error-summary').warn('Pending summaries could not be cleared; reporting disabled for this session')
      }
    },
  }
}
