// 「帮助改进咕咕」(owner 11-09):默认开,人关了才不发;按安装 × 账号记,重启还在;读不出记录不当成开着。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { app, ipcMain, BrowserWindow } from 'electron'
import { registerErrorSummaryConsent } from '../../apps/desktop/electron/error-summary-consent-host'
import { registerErrorSummaryReporting } from '../../apps/desktop/electron/error-summary-reporting-host'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    app: Object.assign(new EventEmitter(), { getPath: vi.fn(), getVersion: () => '0.3.2' }),
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) },
      invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
      clearHandlers: () => handlers.clear(),
    }),
    BrowserWindow: { getAllWindows: vi.fn(() => []), fromWebContents: () => ({}) },
  }
})
vi.mock('../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))

type FakeIpc = typeof ipcMain & { invoke: (channel: string, ...args: unknown[]) => unknown; clearHandlers: () => void }
const ipc = ipcMain as FakeIpc
const hash = (id: string) => createHash('sha256').update(id).digest('hex')
let root: string
let owner: string | null | undefined

function localConsent() {
  let seen: unknown
  ipcMain.emit('error-summary:read-local-consent', (snapshot: unknown) => { seen = snapshot })
  return seen
}

function start() {
  ipcMain.removeAllListeners()
  ipc.clearHandlers()
  return registerErrorSummaryConsent({ eligible: true, owner: () => owner })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gugu-summary-consent-'))
  vi.mocked(app.getPath).mockReturnValue(root)
  owner = 'u1'
})

afterEach(() => {
  ipcMain.removeAllListeners()
  ipc.clearHandlers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe('help improve Gugu consent', () => {
  it('is on for an account that never chose, and the reporting host reads it as allowed', () => {
    start()
    expect(ipc.invoke('error-summary:consent-read')).toEqual({ eligible: true, context: hash('u1'), decision: 'allowed' })
    expect(localConsent()).toEqual({ eligible: true, context: hash('u1'), decision: 'allowed' })
  })

  it('remembers turning it off per account across restarts, and turning it back on', () => {
    start()
    const changed = vi.fn()
    ipcMain.on('error-summary:consent-changed', changed)
    expect(ipc.invoke('error-summary:consent-write', 'denied', hash('u1'))).toMatchObject({ decision: 'denied' })
    expect(changed).toHaveBeenCalled()

    start()
    expect(ipc.invoke('error-summary:consent-read')).toMatchObject({ context: hash('u1'), decision: 'denied' })
    owner = 'u2'
    expect(ipc.invoke('error-summary:consent-read')).toMatchObject({ context: hash('u2'), decision: 'allowed' })
    owner = 'u1'
    expect(ipc.invoke('error-summary:consent-write', 'allowed', hash('u1'))).toMatchObject({ decision: 'allowed' })
    start()
    expect(ipc.invoke('error-summary:consent-read')).toMatchObject({ decision: 'allowed' })
    expect(JSON.parse(readFileSync(join(root, 'error-summary-consent.json'), 'utf8'))).toEqual({ version: 1, denied: {} })
  })

  it('stops reporting when turned off even if saving the choice fails', () => {
    writeFileSync(join(root, 'pending-error-summaries.json'), '[]')
    mkdirSync(join(root, 'error-summary-consent.json.tmp'))
    start()
    expect(() => ipc.invoke('error-summary:consent-write', 'denied', hash('u1'))).toThrow()
    expect(existsSync(join(root, 'pending-error-summaries.json'))).toBe(false)
    expect(localConsent()).toMatchObject({ decision: 'unknown' })
  })

  it('stops reporting at once when turned off and drops what was waiting', () => {
    writeFileSync(join(root, 'pending-error-summaries.json'), '[]')
    start()
    ipc.invoke('error-summary:consent-write', 'denied', hash('u1'))
    expect(existsSync(join(root, 'pending-error-summaries.json'))).toBe(false)
    expect(localConsent()).toMatchObject({ decision: 'denied' })
  })

  it('does not treat an unreadable record as on', () => {
    writeFileSync(join(root, 'error-summary-consent.json'), '{not json')
    start()
    expect(ipc.invoke('error-summary:consent-read')).toMatchObject({ eligible: true, decision: 'unknown' })
    expect(ipc.invoke('error-summary:consent-write', 'allowed', hash('u1'))).toMatchObject({ decision: 'allowed' })
  })

  it('refuses a choice made for an account that is no longer signed in', () => {
    start()
    owner = 'u2'
    expect(() => ipc.invoke('error-summary:consent-write', 'denied', hash('u1'))).toThrow()
    expect(ipc.invoke('error-summary:consent-read')).toMatchObject({ context: hash('u2'), decision: 'allowed' })
  })

  it('has nothing to show before the account is known or in a build that does not record it', () => {
    owner = undefined
    start()
    expect(ipc.invoke('error-summary:consent-read')).toEqual({ eligible: false, context: null, decision: 'unknown' })
    ipcMain.removeAllListeners()
    ipc.clearHandlers()
    owner = 'u1'
    registerErrorSummaryConsent({ eligible: false, owner: () => owner })
    expect(ipc.invoke('error-summary:consent-read')).toMatchObject({ eligible: false, decision: 'unknown' })
    expect(() => ipc.invoke('error-summary:consent-write', 'denied', hash('u1'))).toThrow()
  })

  it('tells windows and the reporting host when the signed-in account changes', () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ webContents: { isDestroyed: () => false, send } }] as never)
    owner = undefined
    const consent = start()
    const changed = vi.fn()
    ipcMain.on('error-summary:consent-changed', changed)
    owner = 'u1'
    consent.identityChanged()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('error-summary:consent-changed')
    writeFileSync(join(root, 'pending-error-summaries.json'), '[]')
    owner = 'u2'
    consent.identityChanged()
    expect(existsSync(join(root, 'pending-error-summaries.json'))).toBe(false)
  })

  it('lets the reporting host send by default and stop after the person turns it off', async () => {
    vi.stubGlobal('__GUGU_ERROR_REPORTING_ENDPOINT__', 'https://errors.example.test/v1/beta-errors')
    const fetch = vi.fn(async () => ({ ok: true, body: null }))
    vi.stubGlobal('fetch', fetch)
    const before = process.listeners('uncaughtExceptionMonitor')
    const rejections = process.listeners('unhandledRejection')
    try {
      start()
      registerErrorSummaryReporting({ eligible: true, owner: () => owner })
      const summary = { type: 'TypeError', locations: ['apps/desktop/src/App.tsx:12:3'], version: '0.3.2', system: 'darwin', time: new Date().toISOString() }
      ipcMain.emit('error-summary:report', { sender: {} }, { context: hash('u1'), summary })
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      ipc.invoke('error-summary:consent-write', 'denied', hash('u1'))
      ipcMain.emit('error-summary:report', { sender: {} }, { context: hash('u1'), summary })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      for (const listener of process.listeners('uncaughtExceptionMonitor')) if (!before.includes(listener)) process.removeListener('uncaughtExceptionMonitor', listener)
      for (const listener of process.listeners('unhandledRejection')) if (!rejections.includes(listener)) process.removeListener('unhandledRejection', listener)
    }
  })
})
