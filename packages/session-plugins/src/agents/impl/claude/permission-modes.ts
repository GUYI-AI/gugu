import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

export const CLAUDE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'default', aliases: ['dontAsk'] },
  edit: { id: 'acceptEdits' },
  'ai-review': { id: 'auto', reviewRequirements: {
    minimumCliVersion: '2.1.302',
    modelPattern: '^(?:claude-)?fable(?:-|$)|^(?:claude-)?opus(?:$|-(?:4-(?:[6-9]|[1-9]\\d+)|(?:[5-9]|[1-9]\\d+))(?:-|$))|^(?:claude-)?sonnet-(?:4-(?:[6-9]|[1-9]\\d+)|(?:[5-9]|[1-9]\\d+))(?:-|$)|^(?:claude-)?haiku-5-5(?:-|$)',
  } },
  'full-access': { id: 'bypassPermissions' },
} satisfies ProviderPermissionModeMap;
