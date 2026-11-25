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

/** Reasons that send the person to check the address: a platform preset has no address field to check. */
const addressReasons: ReadonlySet<UnlistedReason> = new Set(['unreachable', 'dns', 'certificate', 'connection-refused', 'redirect']);

/**
 * `fixedAddress` = the provider's address is the preset's own and cannot be edited: an address reason is then said as
 * what is known (the list was not read) and what the person can do (B7-F03), ❌ 「check this address」.
 */
export function connectionProbeMessageKey(reason: UnlistedReason, fixedAddress = false) {
  return fixedAddress && addressReasons.has(reason) ? 'customModels.presetListFailed' : messages[reason];
}
