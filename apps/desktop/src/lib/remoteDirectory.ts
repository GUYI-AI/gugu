import type { DeviceFsEntry } from '@gugu/core/cloud/deviceFsProtocol'
import { deviceFsListDirectory } from './deviceFs'
import type { DeviceRpcError } from './deviceRpc'
import { rendererLogger } from './log'
import { replica } from './replica'
import { sortEntries } from '../components/remoteFolderPath'

const LIST_DIRECTORY_TIMEOUT_MS = 20_000
const log = rendererLogger('remote-directory')

/** Codes that mean "this path is not a place to stand" (the picker's first path falls back to the home folder on them). */
export const UNREACHABLE_PATH_CODES: readonly string[] = ['not_found', 'not_a_directory', 'permission_denied', 'path_blocked']

export class RemoteDirectoryError extends Error {
  constructor(readonly path: string, readonly rpcError: DeviceRpcError) {
    super(rpcError.message || rpcError.code)
    this.name = 'RemoteDirectoryError'
  }
}

export type RemoteDirectory = {
  /** The folder as the machine resolved it (`~` → its home). */
  path: string
  entries: DeviceFsEntry[]
  /** The machine's home folder: newer machines say it with every listing; an older one only when `~` was listed. */
  home: string | null
  /** The machine listed only this many (too many entries); null = all of them. */
  truncated: number | null
}

/** One folder on another machine. Not pushed, not kept (listings grow without bound): read on open, held a minute. */
export const remoteDirectory = replica({
  name: 'remoteDirectory',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, deviceId: string, path: string, showHidden: boolean): Promise<RemoteDirectory> => {
    // @@@remote-dir-no-retry (#670) - a directory listing either resolves or it doesn't; retrying only doubles the wait.
    const response = await deviceFsListDirectory(deviceId, { path, show_hidden: showHidden }, { timeoutMs: LIST_DIRECTORY_TIMEOUT_MS, retryOnTimeout: false })
    const result = response.result
    if (!result) {
      const error = response.error ?? { code: 'internal_error', message: 'empty response' }
      if (![...UNREACHABLE_PATH_CODES, 'invalid_path'].includes(error.code)) log.warn({ deviceId, path, error }, 'list-directory failed')
      throw new RemoteDirectoryError(path, error)
    }
    return {
      path: result.path,
      entries: sortEntries(result.entries),
      home: result.home ?? (path === '~' ? result.path : null),
      truncated: response.error?.code === 'too_many_entries' ? result.entries.length : null,
    }
  },
  fresh: 0,
  keep: 60_000,
})
