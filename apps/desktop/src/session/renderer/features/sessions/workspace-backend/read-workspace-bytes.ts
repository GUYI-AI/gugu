import { base64ToBytes } from '@shared/lib/base64';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { OPENED_FILE_MAX_BYTES, REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { getFileKind } from '@renderer/lib/editor/fileKind';
import { workspaceRpc } from './workspace-backend';

/** As long as the chunks on the line at once may take to come through: the machine's link waits behind them, its heartbeats too. */
const LINE_BUDGET_MS = 1_000;
const MOST_AHEAD = 4;

/**
 * A file of a workspace read where it is, in chunks (`readChunk`, routed to whichever machine the workspace is on): no
 * single message carries the whole file, so its size is not capped by one. `maxBytes`: refused once the size is known.
 */
export async function readWorkspaceBytes(projectId: string, workspaceId: string, path: string, maxBytes = Infinity): Promise<BlobPart[]> {
  const files = workspaceRpc(projectId).files;
  const read = async (offset: number) => {
    const result = await files.readChunk(projectId, workspaceId, { path, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES });
    if (!result.success) throw new Error(String(result.error.type));
    return { size: result.data.size, bytes: base64ToBytes(result.data.data) };
  };
  const asked = Date.now();
  const first = await read(0);
  const size = first.size;
  if (size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too-large' });
  // @@@read-ahead - each chunk is a round trip to the file's machine. Asked one after another, a file on another machine
  // was mostly waiting (3 MB over a 150 ms line: about 2 s, where its bytes take 1.2 s). The rest are asked several at a
  // time — as many as the first chunk's speed brings through in LINE_BUDGET_MS — and kept in order.
  const ahead = Math.max(1, Math.min(MOST_AHEAD, Math.floor(first.bytes.length / Math.max(1, Date.now() - asked) * LINE_BUDGET_MS / REMOTE_WORKSPACE_CHUNK_BYTES)));
  if (first.bytes.length === 0 && size > 0) throw new Error('The file changed while it was read');
  const offsets: number[] = [];
  for (let offset = first.bytes.length; offset < size; offset += REMOTE_WORKSPACE_CHUNK_BYTES) offsets.push(offset);
  const parts: BlobPart[] = [first.bytes.slice().buffer];
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

const isTextRead = (path: string) => ['text', 'markdown', 'html', 'csv'].includes(getFileKind(path));

/** A file of a workspace as its preview reads it, and the image viewer too: text as text, the rest as bytes. */
export async function readWorkspaceFileBytes(projectId: string, workspaceId: string, path: string, inWorkspace: boolean): Promise<Blob> {
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
  if (inWorkspace) return new Blob(await readWorkspaceBytes(projectId, workspaceId, path, OPENED_FILE_MAX_BYTES), { type: mimeTypeFromName(path) ?? 'application/octet-stream' });
  const result = await files.readInlineBinary(projectId, workspaceId, path);
  if (!result.success) throw new Error('message' in result.error ? result.error.message : String(result.error));
  if (!result.data.success) throw new Error(result.data.error);
  return (await fetch(result.data.dataUrl)).blob();
}
