import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Kiro CLI V3 permission tiers are its client-requested policy presets, sent as
 * `_meta.kiro.policyPreset` on `session/new` and `session/load` (kiro.dev/docs/permissions, "Policy presets").
 * The ids below are those preset ids. An unknown id is rejected with -32602 (measured on 3.0.0), so a typo here
 * cannot silently open a looser session.
 *
 * Presets only add `allow` rules on top of Kiro's default of asking:
 *  - read-only: `read-workspace`. Workspace reads are silent; writes and shell still ask.
 *  - edit: `edit-workspace` + `dev-shell`. Workspace reads and writes, git and build commands are silent; other commands
 *    and writes outside still ask. `edit-workspace` alone would ask before every command.
 *  - full-access: `allow-all`.
 *
 * No `plan` tier: Kiro's `plan` is an agent mode, and its modes are not permission tiers (`sessionModes: 'none'`).
 */
export const KIRO_PERMISSION_MODES = {
  'read-only': { id: 'read-workspace' },
  edit: { id: 'edit-workspace' },
  'full-access': { id: 'allow-all' },
} satisfies ProviderPermissionModeMap;

/** Mode id → the presets it opens with. A tier's id names its main preset; `edit` needs a second one. */
export const KIRO_POLICY_PRESETS: Readonly<Record<string, readonly string[]>> = {
  'read-workspace': ['read-workspace'],
  'edit-workspace': ['edit-workspace', 'dev-shell'],
  'allow-all': ['allow-all'],
};
