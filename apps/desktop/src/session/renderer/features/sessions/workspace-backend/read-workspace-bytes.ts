import { base64ToBytes } from '@shared/lib/base64';
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
