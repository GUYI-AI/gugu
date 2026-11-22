import { base64ToBytes } from '@shared/lib/base64';
import { rpc } from '@renderer/lib/ipc';
import { machineCodec } from '@renderer/lib/machine-routing';

export type MachineChunk = { size: number; etag: string; bytes: Uint8Array };

/**
 * @@@machine-file-reader - the window's one way to read a file of a workspace on another machine, whoever reads it (the
 * file view, a dropped file, voice notes, the assistant's move). A read from the start goes through the machine's channel
 * (`readChunk`, routed to that machine): it anchors the version. A read further on, of that version, comes from one
 * stream over the machine's device link (`workspace.files.readStreamed`, main's `@@@machine-file-stream`).
 *
 * Whether the machine streams is main's answer, from its mapping, once per reader: `{ linked: false }` = no device link
 * reaches it (only its cloud channel, or this window's host has no links), and every read stays a `readChunk`
 * (`@@@cloud-only-chunks`; goes when stream frames travel there too). A linked machine streams or fails: a stream that
 * fails never goes on in chunks. `deviceId` null = this computer: its own disk, read in chunks.
 */
export function machineFileReader(deviceId: string | null, workspaceId: string,
  readChunk: (path: string, offset: number, length: number) => Promise<MachineChunk>) {
  const versions = new Map<string, { size: number; etag: string }>();
  let linked: boolean | null = deviceId ? null : false;
  const there = deviceId ? machineCodec(deviceId).outbound({ workspaceId }) : null;
  return {
    /** Whether this reader's machine streams: null until the first read past a file's start asked. */
    get linked() { return linked; },
    /** A version already read from its start elsewhere (a first chunk asked early). */
    anchor(path: string, version: { size: number; etag: string }) {
      versions.set(path, version);
    },
    async read(path: string, offset: number, length: number): Promise<MachineChunk> {
      const version = versions.get(path);
      if (offset > 0 && version && linked !== false && deviceId && there) {
        const result = await rpc.workspace.files.readStreamed(deviceId, there.workspaceId, { path, offset, length, ...version });
        if (!result.success) throw new Error(result.error.type === 'content_changed' ? 'The file changed while it was read' : result.error.message);
        if (result.data.linked) {
          linked = true;
          return { ...version, bytes: base64ToBytes(result.data.data) };
        }
        if (linked) throw new Error('The connection to this machine was lost while the file was read');
        linked = false;
      }
      const chunk = await readChunk(path, offset, length);
      if (offset === 0) versions.set(path, { size: chunk.size, etag: chunk.etag });
      return chunk;
    },
  };
}
