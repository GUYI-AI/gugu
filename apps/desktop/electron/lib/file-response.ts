import { net } from 'electron'
import { pathToFileURL } from 'node:url'

/** The custom app protocols read local files, never external URLs. Keep Electron's MIME inference and streaming. */
export function localFileResponse(file: string): Promise<Response> {
  return net.fetch(pathToFileURL(file).href)
}
