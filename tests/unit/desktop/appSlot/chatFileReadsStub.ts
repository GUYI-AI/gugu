import { vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn(async () => ({ error: null })))
export const chatFileRpc = rpc

// Panel tests own their files: recent-open bookkeeping and host metadata must not start real I/O after the panel unmounts.
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/fileAccess')>(),
  localFileRevision: async () => null,
  fileMetadata: async () => ({ status: 'gone', sha256: null }),
}))
