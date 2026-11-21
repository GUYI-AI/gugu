import type { EnvironmentImportItem } from '@shared/core/session-import/environment-import';

/** Keep service-specific fields and source configuration on the host. */
export function importItemMetadata(value: unknown, names: ReadonlyMap<string, string> = new Map()): EnvironmentImportItem {
  const row = value as Record<string, unknown>;
  const id = String(row.localSourceId ?? '');
  const status = String(row.status);
  const normalized: EnvironmentImportItem['status'] = status === 'ready' ? 'ready'
    : ['exists', 'existing', 'already-exists'].includes(status) ? 'existing'
    : status === 'imported' ? 'imported' : status === 'conflict' || status === 'source-changed' ? 'conflict'
    : status === 'failed' ? 'failed' : 'skipped';
  return { localSourceId: id, fingerprint: typeof row.fingerprint === 'string' ? row.fingerprint
    : typeof row.sourceFingerprint === 'string' ? row.sourceFingerprint : null,
    name: typeof row.name === 'string' ? row.name : names.get(id) ?? id,
    status: normalized,
    ...(typeof row.reason === 'string' ? { reason: row.reason } : normalized === 'skipped' ? { reason: status } : {}) };
}
