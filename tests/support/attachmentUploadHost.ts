import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { createAttachmentUploadHost } from '../../apps/desktop/electron/attachmentUploadHost'

const fixtures: { host: ReturnType<typeof createAttachmentUploadHost>; home: string }[] = []
/** The production account queue and file store, with only the service transport replaced. */
export function testAttachmentUploads(endpoint: () => Promise<AttachmentsEndpoint>) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-attachment-host-'))
  const host = createAttachmentUploadHost({ account: async () => ({ id: 'owner', home, endpoint }), progress: vi.fn(), warn: vi.fn() })
  fixtures.push({ host, home })
  return host
}
afterEach(() => {
  for (const { host, home } of fixtures.splice(0)) {
    host.dispose()
    if (!home.startsWith(join(tmpdir(), 'mcp-attachment-host-'))) throw new Error('Foreign attachment fixture')
    rmSync(home, { recursive: true, force: true })
  }
})
