import type { FileProgress } from '@gugu/core/shared/fileResolver';
import { base64ToBytes } from '@shared/lib/base64';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { OPENED_FILE_MAX_BYTES, REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { getFileKind } from '@renderer/lib/editor/fileKind';
import { classifyDocumentPreview } from '@/components/chat/documentPreview';
import { machineFileReader } from './machine-file-reader';
import { workspaceBackend, workspaceRpc } from './workspace-backend';

/** As long as the chunks on the line at once may take to come through: the machine's link waits behind them, its heartbeats too. */
const LINE_BUDGET_MS = 1_000;
const MOST_AHEAD = 4;

type FirstChunk = { size: number; etag: string; bytes: Uint8Array; ms: number };

const chunkReader = (projectId: string, workspaceId: string, path: string) => async (offset: number) => {
  const result = await workspaceRpc(projectId).files.readChunk(projectId, workspaceId, { path, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES });
  if (!result.success) throw new Error(String(result.error.type));
  return { size: result.data.size, etag: result.data.etag, bytes: base64ToBytes(result.data.data) };
};

/**
 * @@@first-read-early - a read of a workspace's file, begun before the view that shows it is drawn: its first range is
 * on its way from the moment the file is opened, while the view's code loads and lays out, and the view's read goes on
 * from it with the same reader (`@@@machine-file-reader`: on a linked machine, the version its stream said and that stream).
 * Opened in an App instead, or as text, this one range was read for nothing; nobody takes it, and its failure is nobody's.
 */
export type BegunRead = { reader: ReturnType<typeof machineFileReader> | null; first: Promise<FirstChunk> };

export function beginWorkspaceRead(projectId: string, workspaceId: string, path: string): BegunRead {
  const machine = workspaceBackend(projectId).machine;
  // Another machine: its file reader. Linked, every byte streams, its version said with the first; not linked, its first chunk is
  // the anchor and the rest are asked below, several at a time (`@@@cloud-only-chunks`).
  const reader = machine.kind === 'remote' ? machineFileReader(machine.deviceId, projectId, workspaceId, (at, offset, length) =>
    workspaceRpc(projectId).files.readChunk(projectId, workspaceId, { path: at, offset, length }).then((result) => {
      if (!result.success) throw new Error(String(result.error.type));
      return { size: result.data.size, etag: result.data.etag, bytes: base64ToBytes(result.data.data) };
    })) : null;
  const asked = Date.now();
  const first = (reader ? reader.read(path, 0, REMOTE_WORKSPACE_CHUNK_BYTES) : chunkReader(projectId, workspaceId, path)(0))
    .then((chunk) => ({ ...chunk, ms: Date.now() - asked }));
  first.catch(() => undefined);
  return { reader, first };
}

/**
 * A file of a workspace read where it is, in chunks (`readChunk`, routed to whichever machine the workspace is on): no
 * single message carries the whole file, so its size is not capped by one. `maxBytes`: refused once the size is known.
 * `begun`: the read already begun (`@@@first-read-early`).
 */
export async function readWorkspaceBytes(projectId: string, workspaceId: string, path: string, maxBytes = Infinity, begun?: BegunRead, progress?: FileProgress): Promise<BlobPart[]> {
  const read = chunkReader(projectId, workspaceId, path);
  const { reader, first: firstRead } = begun ?? beginWorkspaceRead(projectId, workspaceId, path);
  const first = await firstRead;
  const size = first.size;
  if (size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too-large' });
  if (first.bytes.length === 0 && size > 0) throw new Error('The file changed while it was read');
  const parts: BlobPart[] = [first.bytes.slice().buffer];
  let from = first.bytes.length;
  progress?.(from, size);
  while (reader?.linked && from < size) {
    const chunk = await reader.read(path, from, REMOTE_WORKSPACE_CHUNK_BYTES);
    if (chunk.size !== size || chunk.bytes.length !== Math.min(REMOTE_WORKSPACE_CHUNK_BYTES, size - from)) throw new Error('The file changed while it was read');
    parts.push(chunk.bytes.slice().buffer);
    from += chunk.bytes.length;
    progress?.(from, size);
  }
  // @@@read-ahead - each chunk is a round trip to the file's machine. Asked one after another, a file on another machine
  // was mostly waiting (3 MB over a 150 ms line: about 2 s, where its bytes take 1.2 s). The rest are asked several at a
  // time — as many as the first chunk's speed brings through in LINE_BUDGET_MS — and kept in order.
  const ahead = Math.max(1, Math.min(MOST_AHEAD, Math.floor(first.bytes.length / Math.max(1, first.ms) * LINE_BUDGET_MS / REMOTE_WORKSPACE_CHUNK_BYTES)));
  const offsets: number[] = [];
  for (let offset = from; offset < size; offset += REMOTE_WORKSPACE_CHUNK_BYTES) offsets.push(offset);
  const base = parts.length;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ahead, offsets.length) }, async () => {
    while (next < offsets.length) {
      const k = next++, offset = offsets[k]!;
      const chunk = await read(offset);
      if (chunk.size !== size || chunk.bytes.length !== Math.min(REMOTE_WORKSPACE_CHUNK_BYTES, size - offset)) throw new Error('The file changed while it was read');
      parts[base + k] = chunk.bytes.slice().buffer;
      from += chunk.bytes.length;
      progress?.(from, size);
    }
  }));
  return parts;
}

const isTextRead = (path: string) => ['text', 'markdown', 'html', 'csv'].includes(getFileKind(path));

/** Whether a preview of this file reads its bytes (`readWorkspaceFileBytes` in chunks): not text, and a kind it draws. */
export function previewReadsBytes(path: string): boolean {
  return !isTextRead(path) && classifyDocumentPreview({ fileName: path, mimeType: mimeTypeFromName(path) ?? 'application/octet-stream' }) !== 'unsupported';
}

/** A file of a workspace as its preview reads it, and the image viewer too: text as text, the rest as bytes. */
export async function readWorkspaceFileBytes(projectId: string, workspaceId: string, path: string, inWorkspace: boolean, begun?: BegunRead, progress?: FileProgress): Promise<Blob> {
  const files = workspaceRpc(projectId).files;
  if (isTextRead(path)) {
    const read = inWorkspace ? files.readFile : files.readExternalFile;
    const result = await read(projectId, workspaceId, path, EDITOR_CONFIRM_FILE_BYTES);
    if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
    if (result.data.truncated) throw new Error(`File too large: ${result.data.totalSize} bytes`);
    return new Blob([result.data.content], { type: 'text/plain' });
  }
  // Inside the workspace: read in chunks, so a large PDF opens (the inline read below is one message, capped at 10 MB). The
  // whole file lands in this window's memory, so it stops at the limit a preview of an opened file has on the phone too.
  if (inWorkspace) return new Blob(await readWorkspaceBytes(projectId, workspaceId, path, OPENED_FILE_MAX_BYTES, begun, progress), { type: mimeTypeFromName(path) ?? 'application/octet-stream' });
  const result = await files.readInlineBinary(projectId, workspaceId, path);
  if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
  if (!result.data.success) throw new Error(result.data.error);
  return (await fetch(result.data.dataUrl)).blob();
}
