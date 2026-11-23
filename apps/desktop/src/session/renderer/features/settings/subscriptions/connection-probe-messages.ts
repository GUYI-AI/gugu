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
