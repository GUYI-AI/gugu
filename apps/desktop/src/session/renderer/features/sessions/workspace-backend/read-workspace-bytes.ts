import { base64ToBytes } from '@shared/lib/base64';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { OPENED_FILE_MAX_BYTES } from '@gugu/session-core/session-record/contract';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { getFileKind } from '@renderer/lib/editor/fileKind';
import { workspaceRpc } from './workspace-backend';

/**
 * A file of a workspace read where it is, in chunks (`readChunk`, routed to whichever machine the workspace is on): no
 * single message carries the whole file, so its size is not capped by one. `maxBytes`: refused once the size is known.
 */
export async function readWorkspaceBytes(projectId: string, workspaceId: string, path: string, maxBytes = Infinity): Promise<BlobPart[]> {
  const files = workspaceRpc(projectId).files;
  const parts: BlobPart[] = [];
  for (let offset = 0, size = Infinity; offset < size;) {
    const result = await files.readChunk(projectId, workspaceId, { path, offset, length: 512 * 1024 });
    if (!result.success) throw new Error(String(result.error.type));
    size = result.data.size;
    if (size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too-large' });
    const bytes = base64ToBytes(result.data.data);
    if (bytes.length === 0 && offset < size) throw new Error('The file changed while it was read');
    parts.push(bytes.slice().buffer);
    offset += bytes.length;
  }
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
