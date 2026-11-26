/**
 * @@@machine-file-stream - a file on another machine read in main over that machine's device link: one stream
 * (`files.stream`, remote protocol 19) per read, front to back, instead of one call per piece. Every reader in main of a
 * file elsewhere goes through `streamedRange`: an App's working-copy read (app-files.ts) and the window's reads of a
 * workspace's file (`workspace.files.readStreamed`: preview, open, a `gugu-preview://` page).
 *
 * A read from the start names no version: the machine says which one it streams before the first byte (the stream's
 * head), and that version comes back with every range. A reader going on names it (or a version it learned
 * otherwise) and asks ranges in order; a range that does not follow on starts the stream again there, of that version. A
 * file that changed on its machine is said so (`changed`), never mixed. Whether a machine streams is decided once, from its
 * mapping (`linked`, main.ts `linkReaches`): a linked machine streams or fails loudly; one no device link reaches (only
 * its cloud channel) is `linked: false`, and its readers read the way that channel goes.
 */

import { FILE_CHUNK_BYTES } from '@gugu/core/shared/fileResolver';

export type FileStreamBytes = { size: number; etag: string; read(offset: number, length: number): Promise<Uint8Array>; dispose(): Promise<void> };

/** How main streams a file over a device link (`remoteFileStreams`, projectFileSsh.ts); main sets it. */
export type MachineFileStreams = {
  linked(deviceId: string): Promise<boolean>;
  /** Resolves with the stream's head: the version it is of (`pin`: what it must be). */
  open(deviceId: string, type: string, request: StreamRequest, pin: { etag?: string }, from: number): Promise<FileStreamBytes>;
};

export const MACHINE_FILE_STREAM = 'files.stream';

let streams: MachineFileStreams | null = null;
export function setMachineFileStreams(value: MachineFileStreams | null): void {
  streams = value;
}

export function machineFileStreams(): MachineFileStreams | null {
  return streams;
}

type Version = { size: number; etag: string };
/** The stream request the machine's streamer takes; `etag` = the version it must be of (absent: the one on disk). */
export type StreamRequest = (offset: number, stream: string, etag?: string) => Record<string, unknown>;
type Open = Version & { next: number; bytes: FileStreamBytes; idle: ReturnType<typeof setTimeout> };
const reads = new Map<string, Open>();
/** A stream nobody read on for this long is let go (and its link hold with it). */
const IDLE_MS = 30_000;

function drop(key: string): void {
  const read = reads.get(key);
  if (!read) return;
  reads.delete(key);
  clearTimeout(read.idle);
  void read.bytes.dispose().catch(() => undefined);
}

/** The version `key`'s stream is of, while it is open (a reader jumping in it keeps that version). */
export function openStreamVersion(key: string): Version | null {
  const read = reads.get(key);
  return read ? { size: read.size, etag: read.etag } : null;
}

/** Whether a range read at `offset` of `key` goes on from where its stream is (no link question needed). */
export function streamGoesOn(key: string, offset: number): boolean {
  return reads.get(key)?.next === offset;
}

/**
 * Bytes `offset..offset+length` of one version of a file on `deviceId`, from its stream, with that version. `key` names
 * the file for one reader; `pin` is the version the reader has (null: whichever its open stream is of, or the one on disk
 * when none is open); `request` is the stream request the machine's streamer takes.
 */
export async function streamedRange(key: string, deviceId: string, pin: Version | null, request: StreamRequest,
  offset: number, length: number): Promise<Version & { bytes: Uint8Array }> {
  const using = streams;
  if (!using) throw new Error('File streams are not ready');
  let read = reads.get(key);
  if (read && (read.next !== offset || (pin && read.etag !== pin.etag))) {
    drop(key);
    read = undefined;
  }
  const known = read ?? pin;
  if (known && offset >= known.size) return { size: known.size, etag: known.etag, bytes: new Uint8Array(0) };
  if (!read) {
    const bytes = await using.open(deviceId, MACHINE_FILE_STREAM, request, { etag: pin?.etag }, offset);
    read = { size: bytes.size, etag: bytes.etag, next: offset, bytes, idle: setTimeout(() => drop(key), IDLE_MS) };
    read.idle.unref?.();
    reads.set(key, read);
  }
  const version = { size: read.size, etag: read.etag };
  const want = Math.max(0, Math.min(length, read.size - offset));
  let bytes: Uint8Array;
  try {
    bytes = await read.bytes.read(offset, want);
  } catch (error) {
    drop(key);
    throw error;
  }
  read.next = offset + bytes.length;
  if (read.next >= read.size) drop(key);
  else read.idle.refresh();
  return { ...version, bytes };
}

/** A read error that says the file changed on its machine while it was streamed. */
export function changedOnItsMachine(error: unknown): boolean {
  return /changed/i.test(error instanceof Error ? error.message : String(error));
}

export type WorkspaceRange = { size: number; etag: string; offset: number; data: string };

/**
 * A range of a workspace's file on `deviceId`, with its version: from the start with none named (the stream's head says
 * it), or of the version its reader names. `place` is the workspace as that machine names it. null = a machine no device
 * link reaches: the reader reads its chunks the way that machine's channel goes.
 */
export async function workspaceFileRange(deviceId: string, place: { projectId: string; workspaceId: string },
  request: { path: string; offset: number; length: number; size?: number; etag?: string }): Promise<WorkspaceRange | null> {
  const using = streams;
  const key = `workspace\0${deviceId}\0${place.projectId}\0${place.workspaceId}\0${request.path}`;
  if (!using || (!streamGoesOn(key, request.offset) && !(await using.linked(deviceId)))) return null;
  const { path, size, etag } = request;
  const pin = size !== undefined && etag !== undefined ? { size, etag } : null;
  const length = Math.max(0, Math.min(request.length, FILE_CHUNK_BYTES));
  const range = await streamedRange(key, deviceId, pin, (offset, stream, pinned) => ({ place, path, offset, stream, ...(pinned ? { etag: pinned } : {}) }), request.offset, length);
  return { size: range.size, etag: range.etag, offset: request.offset, data: Buffer.from(range.bytes).toString('base64') };
}

/** Whether `deviceId`'s files stream here (a device link reaches it, its server streams); a link that will not open throws. */
export async function machineStreams(deviceId: string): Promise<boolean> {
  return streams ? streams.linked(deviceId) : false;
}
