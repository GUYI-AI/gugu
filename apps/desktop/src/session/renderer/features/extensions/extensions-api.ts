import { rpc, rpcOn } from '@renderer/lib/ipc';

/**
 * @@@extensions-api-of — host key → the API answering for it: `local` = this desktop's main, `remote:<deviceId>` = another
 * desktop's through device RPC (#6264). `phone` is not an `rpc.extensions`: its models read the phone store themselves.
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
