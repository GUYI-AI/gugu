import { base64ToBytes } from '@shared/lib/base64';
import { rpc } from '@renderer/lib/ipc';
import { machineCodec } from '@renderer/lib/machine-routing';

export type MachineChunk = { size: number; etag: string; bytes: Uint8Array };

/**
 * @@@machine-file-reader - the window's one way to read a file of a workspace on another machine, whoever reads it (the
 * file view, a dropped file, voice notes, the assistant's move). On a machine a device link reaches, a read from the start
 * anchors its version with a `readChunk` of no bytes (routed to that machine: one round trip), and every byte comes from
 * one stream over the link (`workspace.files.readStreamed`, main's `@@@machine-file-stream`).
 *
 * Whether the machine streams is main's answer, from its mapping, once per reader (`streamsFrom`): false = no device link
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
    /** Whether this reader's machine streams: null until its first read asked main. */
    get linked() { return linked; },
    /** A version already read from its start elsewhere (a first chunk asked early): reads go on from it. */
    anchor(path: string, version: { size: number; etag: string }) {
      versions.set(path, version);
    },
    async read(path: string, offset: number, length: number): Promise<MachineChunk> {
      if (deviceId && there && linked === null) {
        const answer = await rpc.workspace.files.streamsFrom(deviceId);
        if (!answer.success) throw new Error(answer.error.message);
        linked = answer.data;
      }
      if (linked && deviceId && there) {
        // A read from the start anchors its version with no bytes (one round trip through the channel); every byte comes
        // from the stream, the first ones included.
        let version = offset === 0 ? undefined : versions.get(path);
        if (!version) {
          const anchor = await readChunk(path, 0, 0);
          version = { size: anchor.size, etag: anchor.etag };
          versions.set(path, version);
        }
        const result = await rpc.workspace.files.readStreamed(deviceId, there.workspaceId, { path, offset, length, ...version });
        if (!result.success) throw new Error(result.error.type === 'content_changed' ? 'The file changed while it was read' : result.error.message);
        if (!result.data.linked) throw new Error('The connection to this machine was lost while the file was read');
        return { ...version, bytes: base64ToBytes(result.data.data) };
      }
      const chunk = await readChunk(path, offset, length);
      if (offset === 0) versions.set(path, { size: chunk.size, etag: chunk.etag });
      return chunk;
    },
  };
}
