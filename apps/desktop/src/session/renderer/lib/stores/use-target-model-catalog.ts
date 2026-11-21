import { useTranslation } from 'react-i18next';
import { refreshFailure, retryOf, useReplica } from '@/lib/replica';
import { useSessionInputNotice } from '@renderer/features/sessions/session-input-notice';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import type { HarnessCatalogState } from './use-harness-model-catalog';
import { targetModelCatalog } from './agent-replicas';
import { useHostMachine } from './host-replica';

/** Model-specific native facts stay independent of the default catalog, including unknown and failed reads. */
export function useTargetModelCatalog(providerId: string | null, leg: SessionpageLeg, model: string | null): HarnessCatalogState | undefined {
  const { t } = useTranslation('common');
  const { machine, online } = useHostMachine();
  const args: [string | null, string, SessionpageLeg, string] | null = providerId && model ? [machine, providerId, leg, model] : null;
  const reading = useReplica(targetModelCatalog, args, { read: online });
  const failure = refreshFailure(reading);
  useSessionInputNotice(`target-model-catalog:${JSON.stringify(args)}`, failure && args ? {
    title: t('staleRead.failed'), tier: 'warning', diagnostic: failure.message, attempt: failure,
    action: { label: t('staleRead.retry'), onClick: retryOf(reading)! },
  } : args && reading.state === 'unknown' ? undefined : null);
  if (!args) return undefined;
  if (reading.state === 'value') return reading.value;
  return reading.state === 'error' ? { kind: 'unavailable', reason: reading.error.message } : { kind: 'unknown' };
}
