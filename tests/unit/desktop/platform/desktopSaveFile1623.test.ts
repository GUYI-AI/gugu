// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// gugu-dev#1623: a chat attachment's Download (and every other desktop Save) did nothing on 0.3.10 and 0.3.11 — no save
// dialog, no file, no error. The desktop's saveFile clicked an `<a download>` on a blob URL, which Electron's own download
// finished "completed" with no path. The desktop now saves through main's save dialog, the Files App's `files.download`
// (controller `extensions.saveFile` → app-files.ts `saveBytesAs`), and says when it could not.

const ipc = vi.hoisted(() => ({ saveFile: vi.fn() }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { saveFile: ipc.saveFile } } }))

import { electronPlatform } from '../../../../apps/desktop/src/platform/electron'

describe('desktop saveFile goes through main\'s save dialog', () => {
  beforeEach(() => {
    ipc.saveFile.mockReset()
  })

  it('hands the bytes and the file name to main and never clicks a download link', async () => {
    ipc.saveFile.mockResolvedValue({ success: true, target: '/Users/someone/Downloads/dl-1127.md' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const blob = new Blob(['# dl-1127\n'], { type: 'text/markdown' })

    await expect(electronPlatform.saveFile(blob, 'dl-1127.md')).resolves.toEqual({ saved: true })

    expect(ipc.saveFile).toHaveBeenCalledTimes(1)
    const [args] = ipc.saveFile.mock.calls[0] as [{ name: string; bytes: Uint8Array }]
    expect(args.name).toBe('dl-1127.md')
    expect(new TextDecoder().decode(args.bytes)).toBe('# dl-1127\n')
    expect(click).not.toHaveBeenCalled()
  })

  it('says not saved when the person cancels the dialog', async () => {
    ipc.saveFile.mockResolvedValue({ success: true, target: null })
    await expect(electronPlatform.saveFile(new Blob(['x']), 'x.txt')).resolves.toEqual({ saved: false })
  })

  it('fails loudly when main could not save, so the caller can say why', async () => {
    ipc.saveFile.mockResolvedValue({ success: false, error: 'EACCES: permission denied' })
    await expect(electronPlatform.saveFile(new Blob(['x']), 'x.txt')).rejects.toThrow('EACCES: permission denied')
  })
})
