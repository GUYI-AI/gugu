import { GUGU_PERMISSION_MODES, type ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import type { SessionOptionGroup } from '@gugu/session-core/session-record/contract';

export type NativePermissionChoice = { id: string; name: string; description?: string };

/** The only permission-option assembler. Lifecycle is deliberately not an input. */
export function buildSessionPermissionOptions(input: {
  modeMap?: ProviderPermissionModeMap;
  native?: readonly NativePermissionChoice[];
  review?: { allowed: boolean; reason?: string; byHaiku?: boolean };
  leg?: 'acp' | 'tui';
  structuralFullAccess?: boolean;
}): SessionOptionGroup | null {
  const { modeMap, native, review, leg = 'acp' } = input;
  if (input.structuralFullAccess) return { selected: null, available: [{ id: 'full-access', name: 'taskConfig.grokPermissionFullAccess', description: 'taskConfig.grokPermissionWarning' }] };
  if (!modeMap) return native?.length ? { selected: null, available: [...native] } : null;
  const available: SessionOptionGroup['available'] = [];
  for (const tier of GUGU_PERMISSION_MODES) {
    const declared = modeMap[tier];
    if (!declared || (declared.legs && !declared.legs.includes(leg))) continue;
    const choice = native?.find(item => [declared.id, ...(declared.aliases ?? [])].includes(item.id));
    const allowed = tier === 'ai-review' ? !!choice && review?.allowed === true : native === undefined || !!choice;
    available.push({
      id: choice?.id ?? declared.id,
      name: choice?.name ?? declared.id,
      ...(!allowed ? { disabled: true, description: tier === 'ai-review'
        ? review?.reason ?? 'taskConfig.reviewEligibilityUnknown'
        : native ? 'taskConfig.permissionNativeUnavailable' : 'taskConfig.reviewEligibilityUnknown' } : {}),
      ...(tier === 'ai-review' && review?.byHaiku ? { reviewByHaiku: true } : {}),
    });
  }
  return available.length ? { selected: null, available } : null;
}
