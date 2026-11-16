import type { SessionOptionGroup } from '@gugu/session-core/session-record/contract';
import type { AgentCapabilities } from './agent-payload';

export type CreationFastGroup = SessionOptionGroup & { model: string };
type NativeCatalog = {
  kind: string; selected?: string | null;
  fastMode?: SessionOptionGroup & { configId: string };
};

/** A target snapshot proves Fast only for its exact native model and real on/off option. */
export function creationFastGroup(capabilities: Pick<AgentCapabilities, 'acp'> | null | undefined,
  model: string | null, catalog: NativeCatalog): CreationFastGroup | null {
  const capability = capabilities?.acp;
  const fast = capability?.liveSettings?.fast;
  const group = catalog.fastMode;
  if (!model || model.startsWith('platform:') || capability?.kind !== 'supported'
    || fast?.channel !== 'acp-config-option' || fast.ack === 'none'
    || catalog.kind !== 'ready' || catalog.selected !== model || group?.configId !== 'fast'
    || !group.available.some(option => option.id === 'on') || !group.available.some(option => option.id === 'off')
    || group.selected !== null && group.selected !== 'on' && group.selected !== 'off') return null;
  return { model, selected: group.selected, available: group.available.map(option => ({ ...option })) };
}
