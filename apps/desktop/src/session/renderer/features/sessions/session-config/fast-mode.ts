import type { SessionOptionGroup } from '@gugu/session-core/session-record/contract';

/** A host-filtered native on/off group is a capability fact, not a model-name guess. */
export function fastModeValue(group: SessionOptionGroup | null | undefined): boolean | undefined {
  if (!group || !group.available.some(option => option.id === 'on') || !group.available.some(option => option.id === 'off')) return undefined;
  if (group.selected === null || group.selected === 'off') return false;
  return group.selected === 'on' ? true : undefined;
}

/** Local ACP facts also need the persisted own/vendor route before the UI offers Fast. */
export function sessionFastMode(input: {
  providerId: string | null | undefined;
  route: 'own' | 'platform' | 'unknown';
  group: (SessionOptionGroup & { configId: string }) | null | undefined;
}): boolean | undefined {
  if (input.route !== 'own' || (input.providerId !== 'codex' && input.providerId !== 'claude') || input.group?.configId !== 'fast') return undefined;
  return fastModeValue(input.group);
}

/** A pre-start probe proves capability for its selected model only. Intent still defaults off. */
export function draftFastMode(input: {
  enabled: boolean;
  providerId: string | null | undefined;
  modelId: string | null;
  platformModel: string | null;
  catalog: { kind: string; selected?: string | null; fastMode?: (SessionOptionGroup & { configId: string }) | null };
}): boolean | undefined {
  if (input.platformModel || !input.modelId || input.catalog.kind !== 'ready' || input.catalog.selected !== input.modelId) return undefined;
  const supported = sessionFastMode({ providerId: input.providerId, route: 'own', group: input.catalog.fastMode });
  return supported === undefined ? undefined : input.enabled;
}
