import type { AppPlatform } from './types'
import { createUnsupportedPlatform } from './unsupported'
import { fileBlob } from '@gugu/core/shared/fileResolver'
import { writeBrowserClipboardText } from './browserClipboard'

const base = createUnsupportedPlatform('web', 'web')

/**
 * @@@remote-download (#1892) — a cross-origin URL in `<a download>` is ignored by Chromium and navigates the whole window
 * to the bare file, so the bytes are fetched first and saved through a same-origin object URL: the browser's own download.
 * Web only — the desktop saves through main's save dialog (electron.ts).
 */
async function browserDownload(blob: Blob, filename: string): Promise<{ saved: boolean }> {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // A non-Chromium engine may read the blob URL after the click: revoke a little later.
  setTimeout(() => URL.revokeObjectURL(url), 200)
  return { saved: true }
}

export const webPlatform: AppPlatform = {
  ...base,
  // @@@task-web-host — 网页版有会话页:后端是无头宿主(electron/session/headless),经 WebSocket 接入。
  capabilities: { ...base.capabilities, externalFileOpen: true, sessionHost: true, modelSettings: true, clipboard: true, readingZoomMemory: true },
  writeClipboardText: writeBrowserClipboardText,
  saveFile: browserDownload,
  async openRemoteFile(file) {
    const url = URL.createObjectURL(await fileBlob(file))
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    if (!opened) throw new Error('The browser blocked the external file window')
  },
}
