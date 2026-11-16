import { useId, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/replica';
import { messageForUser } from '@/lib/userFacingError';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { MarketVersionHistoryEntry } from '@shared/extensions/market';
import type { Loadable } from './app-version-history';

type HistoryApi = { marketHistory: (args: { extensionId: string }) => Promise<{ success: boolean; data?: MarketVersionHistoryEntry[]; error?: string }> };

/** Both App detail surfaces use the existing query client's silent, bounded read recovery. */
export function useVersionHistory(api: HistoryApi, extensionId: string, enabled = true) {
  const view = useId();
  const source = useRef({ api, generation: 0 });
  if (source.current.api !== api) source.current = { api, generation: source.current.generation + 1 };
  const query = useQuery({
    queryKey: ['extension-version-history', view, source.current.generation, extensionId],
    queryFn: async () => {
      const result = await api.marketHistory({ extensionId });
      if (!result.success || !result.data) throw new Error(result.error || 'history unreadable');
      return result.data;
    },
    enabled, retry: 3, gcTime: 0, refetchOnWindowFocus: false,
  }, queryClient);
  const error = query.isError ? query.error.message === 'history unreadable' ? translateSessionMessage('extensions.historyUnavailable') : messageForUser(query.error) : undefined;
  const state: Loadable<MarketVersionHistoryEntry[]> = query.data !== undefined
    ? { status: 'ready', data: query.data, error }
    : query.isError ? { status: 'error', error } : { status: enabled ? 'loading' : 'idle' };
  return { state, retry: () => { void query.refetch({ cancelRefetch: false }); } };
}
