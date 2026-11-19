import type { Readable } from 'node:stream'
export interface JsonlReader {
  close(): void
  pause(): void
  resume(): void
  on(event: 'line', listener: (line: string) => void): this
  on(event: 'close', listener: () => void): this
  once(event: 'close', listener: () => void): this
}
export declare function createJsonlReader(options: {
  input: Readable
  onLine?: (line: string) => void
  onClose?: () => void
  onError?: (error: Error) => void
}): JsonlReader
export declare function readJsonlLines(input: Readable): AsyncGenerator<string>
export declare function jsonlParseError(source: string, line: string): Error
