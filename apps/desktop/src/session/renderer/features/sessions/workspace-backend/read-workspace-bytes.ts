import { base64ToBytes } from '@shared/lib/base64';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { OPENED_FILE_MAX_BYTES, REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { getFileKind } from '@renderer/lib/editor/fileKind';
import { rpc } from '@renderer/lib/ipc';
import { machineCodec } from '@renderer/lib/machine-routing';
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

/** A file's first chunk, and how long it took to come: asked before the rest of its read is known to be wanted. */
export function readFirstChunk(projectId: string, workspaceId: string, path: string): Promise<FirstChunk> {
  const asked = Date.now();
  return chunkReader(projectId, workspaceId, path)(0).then((chunk) => ({ ...chunk, ms: Date.now() - asked }));
}

/**
 * A file of a workspace read where it is, in chunks (`readChunk`, routed to whichever machine the workspace is on): no
 * single message carries the whole file, so its size is not capped by one. `maxBytes`: refused once the size is known.
 * `begun`: its first chunk, already asked.
 */
export async function readWorkspaceBytes(projectId: string, workspaceId: string, path: string, maxBytes = Infinity, begun?: Promise<FirstChunk>): Promise<BlobPart[]> {
  const read = chunkReader(projectId, workspaceId, path);
  const first = await (begun ?? readFirstChunk(projectId, workspaceId, path));
  const size = first.size;
  if (size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too-large' });
  // @@@read-ahead - each chunk is a round trip to the file's machine. Asked one after another, a file on another machine
  // was mostly waiting (3 MB over a 150 ms line: about 2 s, where its bytes take 1.2 s). The rest are asked several at a
  // time — as many as the first chunk's speed brings through in LINE_BUDGET_MS — and kept in order.
  const ahead = Math.max(1, Math.min(MOST_AHEAD, Math.floor(first.bytes.length / Math.max(1, first.ms) * LINE_BUDGET_MS / REMOTE_WORKSPACE_CHUNK_BYTES)));
  if (first.bytes.length === 0 && size > 0) throw new Error('The file changed while it was read');
  const parts: BlobPart[] = [first.bytes.slice().buffer];
  const machine = workspaceBackend(projectId).machine;
  if (machine.kind === 'remote' && await streamRest(machine.deviceId, projectId, workspaceId, path, first, parts)) return parts;
  // @@@cloud-only-chunks - a machine no device link reaches has only its cloud channel, where stream frames do not
  // travel: its chunks stay one call each. They go when stream frames travel there too, or when no such machine is left.
  const offsets: number[] = [];
  for (let offset = first.bytes.length; offset < size; offset += REMOTE_WORKSPACE_CHUNK_BYTES) offsets.push(offset);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ahead, offsets.length) }, async () => {
    while (next < offsets.length) {
      const k = next++, offset = offsets[k]!;
      const chunk = await read(offset);
      if (chunk.size !== size || chunk.bytes.length !== Math.min(REMOTE_WORKSPACE_CHUNK_BYTES, size - offset)) throw new Error('The file changed while it was read');
      parts[k + 1] = chunk.bytes.slice().buffer;
    }
  }));
  return parts;
}

/**
 * The rest of a file on another machine after its first chunk, from one stream over that machine's device link
 * (`workspace.files.readStreamed`, main's `@@@machine-file-stream`), of the version the first chunk read. false = no
 * device link reaches that machine (its chunks go through its channel); a linked machine streams or fails loudly.
 */
async function streamRest(deviceId: string, projectId: string, workspaceId: string, path: string, first: FirstChunk, parts: BlobPart[]): Promise<boolean> {
  const there = machineCodec(deviceId).outbound({ projectId, workspaceId });
  for (let offset = first.bytes.length; offset < first.size;) {
    const result = await rpc.workspace.files.readStreamed(deviceId, there.projectId, there.workspaceId, { path, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES, size: first.size, etag: first.etag });
    if (!result.success) throw new Error(result.error.type === 'content_changed' ? 'The file changed while it was read' : result.error.message);
    if (!result.data.linked) {
      if (offset !== first.bytes.length) throw new Error('The connection to this machine was lost while the file was read');
      return false;
    }
    const bytes = base64ToBytes(result.data.data);
    if (bytes.length === 0) throw new Error('The file changed while it was read');
    parts.push(bytes.slice().buffer);
    offset += bytes.length;
  }
  return true;
}

const isTextRead = (path: string) => ['text', 'markdown', 'html', 'csv'].includes(getFileKind(path));

/** A file of a workspace as its preview reads it, and the image viewer too: text as text, the rest as bytes. */
export async function readWorkspaceFileBytes(projectId: string, workspaceId: string, path: string, inWorkspace: boolean, begun?: Promise<FirstChunk>): Promise<Blob> {
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
  if (inWorkspace) return new Blob(await readWorkspaceBytes(projectId, workspaceId, path, OPENED_FILE_MAX_BYTES, begun), { type: mimeTypeFromName(path) ?? 'application/octet-stream' });
  const result = await files.readInlineBinary(projectId, workspaceId, path);
  if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
  if (!result.data.success) throw new Error(result.data.error);
  return (await fetch(result.data.dataUrl)).blob();
}
