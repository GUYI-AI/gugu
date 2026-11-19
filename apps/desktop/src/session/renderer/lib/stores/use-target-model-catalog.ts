import { useTranslation } from 'react-i18next';
import { refreshFailure, useReplica } from '@/lib/replica';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useSessionInputNotice } from '@renderer/features/sessions/session-input-notice';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import type { HarnessCatalogState } from './use-harness-model-catalog';
import { targetModelCatalog } from './agent-replicas';

/** Model-specific native facts stay independent of the default catalog, including unknown and failed reads. */
export function useTargetModelCatalog(providerId: string | null, leg: SessionpageLeg, model: string | null): HarnessCatalogState | undefined {
  const { t } = useTranslation('common');
  const host = useLibraryHost().remote;
  const machine = host?.deviceId ?? null;
  const args: [string | null, string, SessionpageLeg, string] | null = providerId && model ? [machine, providerId, leg, model] : null;
  const reading = useReplica(targetModelCatalog, args, { read: host?.online !== false });
  const failure = refreshFailure(reading);
  useSessionInputNotice(`target-model-catalog:${JSON.stringify(args)}`, failure && args ? {
    title: t('staleRead.failed'), tier: 'warning', diagnostic: failure.message, attempt: failure,
    action: { label: t('staleRead.retry'), onClick: () => { void targetModelCatalog.refresh(...args); } },
  } : args && reading.state === 'unknown' ? undefined : null);
  if (!args) return undefined;
  if (reading.state === 'value') return reading.value;
  return reading.state === 'error' ? { kind: 'unavailable', reason: reading.error.message } : { kind: 'unknown' };
}
