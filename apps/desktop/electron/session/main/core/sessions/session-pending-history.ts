import type { NativeInputLookup } from '@gugu/core/local/agent/deliveryIdentity';
import { readNativeInputTail, type NativeInputTail } from '@gugu/session-core/session-record';

/** A projection (including an optimistic user row) is not evidence of native receipt. Read one native suffix per pass. */
export function nativePendingInputLookup(sessionId: string): NativeInputLookup {
  let tail: Promise<NativeInputTail> | undefined;
  return async input => {
    tail ??= (async () => {
      const { readSessionRow, locateRow } = await import('../session-timeline/service');
      const row = readSessionRow(sessionId, { includeArchived: true });
      if (!row) return { find: () => ({ state: 'incomplete' as const, reason: 'native_session_unavailable' }) };
      const location = locateRow(row);
      if (!location.supported) return { find: () => ({ state: 'incomplete' as const, reason: 'native_location_unavailable' }) };
      const { acpAgentStatusBridge } = await import('../acp/agent-status-bridge');
      const summary = acpAgentStatusBridge.current().get(sessionId);
      const path = summary?.providerId === row.provider ? summary.transcriptPath ?? undefined : undefined;
      const checked = await readNativeInputTail(location.locator, { path });
      const current = readSessionRow(sessionId, { includeArchived: true });
      return current?.provider === row.provider && current.providerSessionId === row.providerSessionId
        ? checked : { find: () => ({ state: 'incomplete' as const, reason: 'native_session_changed' }) };
    })();
    return (await tail).find(input);
  };
}
