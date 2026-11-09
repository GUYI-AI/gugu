import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * `mode` config option on Kilo 7.8.27: code / ask / debug / orchestrator / plan.
 * `ask` is a real read-only tier: `write` and `edit` leave the tool list and a forced call fails.
 * `full-access` is an agent Gugu declares in the config document, so it is reported like the others.
 */
export const KILOCODE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'ask' },
  edit: { id: 'code', aliases: ['debug', 'orchestrator'] },
  'full-access': { id: 'full-access' },
} satisfies ProviderPermissionModeMap;
