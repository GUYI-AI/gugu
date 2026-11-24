import { useObserver } from 'mobx-react-lite';
import { replica } from '@/lib/replica';
import { rpc } from '@renderer/lib/ipc';
import type { SearchItem } from '@shared/core/search';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { isAssistantSession } from '@renderer/features/assistant/assistant-lineage';
import { paletteTasks } from './palette-tasks';
import { recentTaskIds } from './recent-tasks';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { machineRegistry } from '@renderer/lib/machine-routing';

export const commandPaletteSearch = replica({
  name: 'commandPaletteSearch',
  scope: 'device',
  read: (_owner, query: string): Promise<SearchItem[]> => rpc.search.commandPalette({ query }),
  fresh: 5_000,
  keep: 5_000,
});

export function usePaletteTasks(results: SearchItem[] | null, search: string) {
  return useObserver(() => {
    if (!results) return null;
    const recent = search ? [] : recentTaskIds();
    // Recall opened local tasks beyond the search RPC's newest ten, from existing task rows only.
    const remembered = recent.flatMap(id => {
      const data = sessionRegistry.get(id)?.sessions.get(id)?.data;
      return data && !data.archivedAt && !data.automationRunId && !machineRegistry.machineOf(data.projectId)
        ? [{ kind: 'session' as const, id, projectId: data.projectId, title: data.title, subtitle: '', score: 0, lastInteractedAt: data.lastInteractedAt }] : [];
    });
    return paletteTasks([...results, ...remembered].filter(item => {
      const binding = sessionAgentBindings.bindingFor(item.id);
      return !isAssistantSession({ agent: binding ? { userId: binding.agentUserId } : null }, sidebarStore.assistantAgentId);
    }), remoteHostsStore.allListedSessions().map(item => ({
      ...item, deviceLabel: remoteHostsStore.device(item.deviceId)!.label,
    })), search, sidebarStore.assistantAgentId, recent);
  });
}
