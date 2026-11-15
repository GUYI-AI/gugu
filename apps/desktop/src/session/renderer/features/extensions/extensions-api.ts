import { rpc, rpcOn } from '@renderer/lib/ipc';

/**
 * @@@extensions-api-of — the one resolver from a host key to the API that answers for it (PR 3, a replica's `read` is
 * module level, so it asks by key, as `getAgentConfigRuntimeClient(machine)` does): `local` = this desktop's main,
 * `remote:<deviceId>` = another desktop's main through device RPC (#6264). The phone's App store (`phone`) is not an
 * `rpc.extensions`: its models read it themselves (installed-extensions.ts). A host that is offline is not asked: its
 * readers pass null arguments.
 */
export const LOCAL_HOST = 'local';
export const PHONE_HOST = 'phone';

export const remoteHostKey = (deviceId: string): string => `remote:${deviceId}`;

const remotes = new Map<string, typeof rpc.extensions>();

export function extensionsApiOf(hostKey: string): typeof rpc.extensions {
  if (hostKey === LOCAL_HOST) return rpc.extensions;
  if (!hostKey.startsWith('remote:')) throw new Error(`No extensions API for host ${hostKey}`);
  const deviceId = hostKey.slice('remote:'.length);
  let api = remotes.get(deviceId);
  if (!api) remotes.set(deviceId, (api = rpcOn(deviceId).extensions));
  return api;
}
