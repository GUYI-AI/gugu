import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// file-logger 靠 app.setAppLogsPath 是否存在决定要不要落文件;无头替身必须提供它,否则宿主日志静默丢失。
describe('headless electron shim: app logs path', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'gugu-headless-'))
    process.env.GUGU_TASK_HOST_USER_DATA = userData
  })
  afterEach(() => {
    delete process.env.GUGU_TASK_HOST_USER_DATA
    rmSync(userData, { recursive: true, force: true })
  })

  it('exposes setAppLogsPath and serves it back through getPath("logs")', async () => {
    const { app } = await import('./electron-shim')
    expect(typeof (app as { setAppLogsPath?: unknown }).setAppLogsPath).toBe('function')
    const target = path.join(userData, 'custom-logs')
    app.setAppLogsPath(target)
    expect(app.getPath('logs')).toBe(target)
    expect(existsSync(target)).toBe(true)
  })

  it('defaults to <userData>/logs when called without an argument', async () => {
    const { app } = await import('./electron-shim')
    app.setAppLogsPath()
    expect(app.getPath('logs')).toBe(path.join(app.getPath('userData'), 'logs'))
  })
})

// No image decoder headless: every image is empty and encodes to nothing, so no caller takes the input bytes for its own
// encoding (an upload's preview, a shrunk image, a dropped HEIC saved as .png).
describe('headless electron shim: nativeImage', () => {
  it('reads every image as empty and hands no bytes back', async () => {
    const { nativeImage } = await import('./electron-shim')
    const image = nativeImage.createFromBuffer(Buffer.from([1, 2, 3]))
    expect(image.isEmpty()).toBe(true)
    expect(image.toPNG().length).toBe(0)
    expect(image.toJPEG().length).toBe(0)
    expect(image.resize({ width: 32, height: 32, quality: 'best' }).isEmpty()).toBe(true)
  })
})

// The server boots on this shim: every session hook main installs must exist on it (regressed in 7dec44fdf4, where the
// preview protocol's claim on the default session's onBeforeRequest threw and the server exited at boot).
describe('headless electron shim: session hooks main installs', () => {
  it('has every webRequest hook the main process uses', async () => {
    const { session } = await import('./electron-shim')
    const root = path.join(import.meta.dirname, '..', '..')
    const used = new Set<string>()
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      for (const match of readFileSync(path.join(root, file), 'utf8').matchAll(/webRequest\.(on[A-Za-z]+)/g)) used.add(match[1])
    }
    expect(used.size).toBeGreaterThan(0)
    const hooks = session.defaultSession.webRequest as Record<string, unknown>
    expect([...used].filter((hook) => typeof hooks[hook] !== 'function')).toEqual([])
  })

  it('setupPreviewProtocol installs on the headless default session without throwing', async () => {
    vi.resetModules()
    vi.doMock('electron', () => import('./electron-shim'))
    const { setupPreviewProtocol } = await import('../main/core/files/preview-protocol')
    expect(() => setupPreviewProtocol()).not.toThrow()
    vi.doUnmock('electron')
  })
})
