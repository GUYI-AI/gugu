import type { FileActor, FileBytes, FileContext, FileHandle, FileRef, FileRevision, createFileResolver } from './fileResolver'

export type FileReadRoute = 'local' | 'ssh' | 'oss'
export type FileReadReuse = 'verified-local' | 'chunks' | null
export type FileReadFailure = 'holder_offline' | 'transfer_disabled' | 'upload_failed' | 'expired' | 'gone'
  | 'access_revoked' | 'integrity_failed' | 'interrupted' | 'cancelled'
export type FileReadState =
  | { status: 'waiting_sender'; reason: 'declared' | 'relay'; holder?: { label?: string; online?: boolean } }
  | { status: 'transferring'; route: FileReadRoute; done?: number; total?: number }
  | { status: 'verifying' }
  | { status: 'done'; route: FileReadRoute; reused: FileReadReuse; sha256: string | null }
  | { status: 'failed'; code: FileReadFailure; message: string }

export interface FileReadOptions {
  purpose: 'save' | 'bytes' | 'show'
  signal?: AbortSignal
}
export interface FileReadResult {
  /** Caller owns this pinned handle. Use its existing stream, saveTo, acknowledgement and dispose contracts. */
  file: FileHandle
  route: FileReadRoute
  reused: FileReadReuse
  sha256: string | null
  waited_ms: number
}
export interface FileReadRequest {
  /** Subscribing replays the latest state. The return value unsubscribes. */
  state$(listener: (state: FileReadState) => void): () => void
  result: Promise<FileReadResult>
}
export interface FileReads {
  request(ref: FileRef, actor: FileActor, options: FileReadOptions): FileReadRequest
  /** Compatible lazy metadata, preview, localOnly and FileHandle API. */
  resolve: ReturnType<typeof createFileResolver>
  nudge(): void
}
export interface FileReadStore {
  /** A verified original for this backend and account only. A hit still requires this request's read confirmation. */
  cachedCopy?(backend: string, revision: FileRevision, context: FileContext): Promise<FileBytes | null>
}
