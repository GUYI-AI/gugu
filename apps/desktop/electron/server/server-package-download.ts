import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { egress, EgressError } from '@gugu/core/shared/egress'

export class DownloadSiteUnreachableError extends Error {}

/** Packages use the host's egress; an idle body still has the download caller's existing deadline. */
export async function downloadServerPackage(url: string, destination: string, idleTimeoutMs = 30_000): Promise<void> {
  const abort = new AbortController()
  let response: Response
  try {
    response = await egress.fetch(url, { signal: abort.signal, timeoutMs: idleTimeoutMs, redirect: 'follow' })
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel()
      throw new Error(`Package download failed (HTTP ${response.status}): ${url}`)
    }
  } catch (error) {
    const message = error instanceof EgressError && error.kind === 'timeout'
      ? 'Server package download stopped receiving data'
      : error instanceof Error ? error.message : String(error)
    throw new DownloadSiteUnreachableError(message, { cause: error })
  }
  const stream = Readable.fromWeb(response.body! as unknown as NodeWebReadableStream<Uint8Array>)
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    if (idleTimeoutMs > 0) timer = setTimeout(() => abort.abort(new Error('Server package download stopped receiving data')), idleTimeoutMs)
  }
  stream.on('data', arm)
  arm()
  try {
    await pipeline(stream, createWriteStream(destination))
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}
