import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';
import { CLAUDE_AUTO_MODE_MODEL_PATTERN } from '@gugu/session-core/models/auto-review-model';

export const CLAUDE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'default', aliases: ['dontAsk'] },
  edit: { id: 'acceptEdits' },
  'ai-review': { id: 'auto', reviewRequirements: {
    minimumCliVersion: '2.1.302',
    modelPattern: CLAUDE_AUTO_MODE_MODEL_PATTERN,
  } },
  'full-access': { id: 'bypassPermissions' },
} satisfies ProviderPermissionModeMap;
