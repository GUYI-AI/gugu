import type { CustomModelConnection, DiscoverySource } from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList } from '@gugu/session-core/workspace-server/agent-config';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type UnlistedReason = Extract<ConnectionModelList, { kind: 'unlisted' }>['reason'];

/** A closed mapping: upstream exceptions and proxy credentials never become user copy. */
const messages = {
  'no-list': 'customModels.noList',
  unauthorized: 'customModels.refused',
  unreachable: 'customModels.unreachable',
  dns: 'customModels.dns',
  timeout: 'customModels.timeout',
  certificate: 'customModels.certificate',
  'connection-refused': 'customModels.connectionRefused',
  redirect: 'customModels.redirect',
  proxy: 'customModels.proxy',
} as const satisfies Record<UnlistedReason, SessionMessageLookupKey>;

export function connectionProbeMessageKey(reason: UnlistedReason) {
  return messages[reason];
}

const discoveredKeyName = {
  'codex-auth': 'customModels.keyCodexAuth', 'codex-provider': 'customModels.keyCodexProvider', 'shell-env': 'customModels.keyShellEnv',
} as const satisfies Record<DiscoverySource, SessionMessageLookupKey>;

/** The key the host uses for a connection when none is typed: one stored here, or one this machine already had (#3422). */
export function heldKeyName(translate: (key: SessionMessageLookupKey) => string, connection: CustomModelConnection | undefined): string | null {
  return connection?.keySaved ? translate(connection.discovered ? discoveredKeyName[connection.discovered.source] : 'customModels.keyStored') : null;
}
