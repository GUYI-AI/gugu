import type { Readable } from 'node:stream'

export declare function createJsonlReader(options: {
  input: Readable
  onLine(line: string): void
  onClose?(): void
  onError?(error: Error): void
}): { close(): void; pause(): void; resume(): void }

export declare function jsonlParseError(source: string, line: string): Error
