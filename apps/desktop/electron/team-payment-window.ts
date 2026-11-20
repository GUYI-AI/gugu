import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'

/** An unprivileged, in-memory payment browser; it never receives the application's preload or Auth credentials. */
export function openTeamPaymentWindow(parent: BrowserWindow, title: string, input: {
  url: string; parameters: Record<string, string>; closed(): void
}) {
  const partition = `team-payment-${randomUUID()}`
  const options: BrowserWindowConstructorOptions = {
    parent, title, width: 520, height: 760, show: false,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  }
  const root = new BrowserWindow(options), owned = new Set<BrowserWindow>([root])
  const close = () => { for (const window of owned) if (!window.isDestroyed()) window.destroy(); owned.clear() }
  parent.once('closed', close)
  function harden(window: BrowserWindow) {
    window.removeMenu()
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, answer) => answer(false))
    const permitted = (raw: string) => {
      try { const url = new URL(raw); return (url.protocol === 'https:' && !url.username && !url.password) || raw === 'about:blank' }
      catch { return false }
    }
    window.webContents.on('will-navigate', (event, url) => { if (!permitted(url)) event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { if (!permitted(url)) event.preventDefault() })
    window.webContents.setWindowOpenHandler(({ url }) => permitted(url)
      ? { action: 'allow', overrideBrowserWindowOptions: { ...options, show: true } } : { action: 'deny' })
    window.webContents.on('did-create-window', child => {
      owned.add(child); harden(child); child.on('closed', () => owned.delete(child))
    })
  }
  harden(root)
  root.once('closed', () => {
    parent.removeListener('closed', close)
    owned.delete(root); close(); input.closed()
  })
  const ready = root.loadURL(input.url, {
    postData: [{ type: 'rawData', bytes: Buffer.from(new URLSearchParams(input.parameters).toString(), 'utf8') }],
    extraHeaders: 'Content-Type: application/x-www-form-urlencoded\r\n',
  }).then(() => { if (!root.isDestroyed()) root.show() })
  return { ready, close }
}
