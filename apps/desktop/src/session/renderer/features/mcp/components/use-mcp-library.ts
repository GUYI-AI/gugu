import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { queryClient, replica, useReplica, type Reading } from '@/lib/replica';
import { writeOver } from '@/lib/replicaWrite';
import { keepLibraryHost, libraryHostOf, useLibraryHost } from '@renderer/features/library/library-host';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import type { GuguToolsOff } from '@shared/gugu-tool-groups';
import type { LibraryMcpCheck, LibraryMcpHarnessServer, LibraryMcpProvided, LibraryMcpServer } from '@shared/mcp-library';

/** The MCP library of a library host (@@@client-state-model). No push: `reload` reads it again. */
export const mcpLibraryServers = replica({
  name: 'mcpLibraryServers',
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<LibraryMcpServer[]> => libraryHostOf(hostKey).mcpLibrary.list(),
})

export const mcpProvided = replica({
  name: 'mcpProvided',
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<LibraryMcpProvided> => libraryHostOf(hostKey).mcpLibrary.provided(),
})

export const harnessMcpServers = replica({
  name: 'harnessMcpServers',
  scope: 'device',
  read: async (_owner: string, hostKey: string, agentId: string): Promise<LibraryMcpHarnessServer['server'][]> =>
    (await libraryHostOf(hostKey).mcpLibrary.harnessServers([agentId])).map((row) => row.server),
})

/**
 * 一家自己配的那几台 —— 段头展开才读(参数 null 前不读),一家一个条目:读哪一家只等哪一家,一家读不了只坏它那一组。
 * 照读那一家的配置文件,❌ 跑它的 CLI(好几家 `mcp list` 会把每台 stdio server 起一遍)。
 */
export function useHarnessMcpServers(agentId: string, enabled: boolean): Reading<LibraryMcpHarnessServer['server'][]> {
  const host = keepLibraryHost(useLibraryHost());
  return useReplica(harnessMcpServers, enabled ? [host.key, agentId] : null, { read: host.remote?.online !== false });
}

/**
 * 资源库 → MCP 的数据:这台机器(资源库选的那台)上咕咕自己管的列表,以及装了的各家自己的用户级那几台。
 * 各家的只读(由那一家自己加载);检测它们的结果只留在这一页,不记下来 —— 那不是咕咕的记录。
 */
export function useMcpLibrary() {
  const host = keepLibraryHost(useLibraryHost());
  const reachable = host.remote?.online !== false;
  const list = useReplica(mcpLibraryServers, [host.key], { read: reachable });
  // 「咕咕提供」里的内置、集成、App 三组:和开会话时读的是同一组来源(见 mcp-library/service.ts `provided`)。
  const provided = useReplica(mcpProvided, [host.key], { read: reachable });
  const agents = useManagementAgents().reading;
  // @@@reading-default(paired) - while the agent list is not known `isLoading` is true and the view draws no groups (nor offers "add", where `harnessNames` reads it)
  const installed = useMemo(
    () => (agents.state === 'value' ? agents.value : []).filter((agent) => agent.reading !== 'not-detected').sort((a, b) => a.name.localeCompare(b.name)),
    [agents]
  );
  const invalidate = () => void mcpLibraryServers.refresh(host.key);
  const add = useMutation({ mutationFn: (servers: LibraryMcpServer[]) => host.mcpLibrary.add(servers), onSettled: invalidate }, queryClient);
  const update = useMutation({ mutationFn: (server: LibraryMcpServer) => host.mcpLibrary.update(server), onSettled: invalidate }, queryClient);
  const remove = useMutation({ mutationFn: (name: string) => host.mcpLibrary.remove(name), onSettled: invalidate }, queryClient);
  const setEnabledByDefault = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => host.mcpLibrary.setEnabledByDefault(name, enabled),
    onSettled: invalidate,
  }, queryClient);

  // 内置那台的工具组开关:点下就画(开关不回弹);拒了就重读宿主那一份,重读也不行就回到点之前读到的(I4)。
  const setGuguToolsOff = useMutation({
    mutationFn: (off: GuguToolsOff) =>
      writeOver(mcpProvided, [host.key], (before) => before && { ...before, guguToolsOff: off }, () => host.mcpLibrary.setGuguToolsOff(off)),
  }, queryClient);

  // 正在检测的那几台(键 = `gugu:<名>` 或 `<家>:<名>`),以及各家那几台这一页上检测出来的结果。
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [harnessChecks, setHarnessChecks] = useState<Readonly<Record<string, LibraryMcpCheck>>>({});
  const [providedChecks, setProvidedChecks] = useState<Readonly<Record<string, LibraryMcpCheck>>>({});
  const track = async <T,>(key: string, work: () => Promise<T>): Promise<T> => {
    setChecking((current) => new Set(current).add(key));
    try {
      return await work();
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return {
    servers: list.state === 'value' ? list.value : null,
    provided,
    /** 装了的那几家,各一个折叠的段头;配置等展开才读。 */
    installed,
    /**
     * 「添加」时要知道名字和哪几家撞了:那时才把各家的读一遍(已经展开读过的直接用缓存)。
     * 读不了的那一家不算进来 —— 它那一组展开时自己会把读失败写出来。
     */
    harnessNames: async (): Promise<Record<string, string[]>> => {
      const names: Record<string, string[]> = {};
      const reads = await Promise.allSettled(
        installed.map(async (agent) => ({
          agent,
          servers: await harnessMcpServers.fetch(host.key, agent.id),
        }))
      );
      for (const read of reads) {
        if (read.status !== 'fulfilled') continue;
        for (const server of read.value.servers) (names[server.name] ??= []).push(read.value.agent.name);
      }
      return names;
    },
    // 各家那几组只等「装了哪几家」(段头要画出来);各家的配置等展开才读。
    isLoading: (reachable && (list.state === 'unknown' || provided.state === 'unknown')) || agents.state === 'unknown',
    error: (list.state === 'error' ? list.error : null) ?? (agents.state === 'error' || agents.state === 'value' ? agents.error : null) ?? (provided.state === 'error' ? provided.error : null),
    hasData: list.state === 'value',
    reload: () => {
      void mcpLibraryServers.refresh(host.key);
      void mcpProvided.refresh(host.key);
      void harnessMcpServers.refresh(host.key);
    },
    isBusy: add.isPending || update.isPending || remove.isPending,
    add: add.mutateAsync,
    update: update.mutateAsync,
    remove: remove.mutateAsync,
    setEnabledByDefault: (name: string, enabled: boolean) => setEnabledByDefault.mutate({ name, enabled }),
    setGuguToolsOff: setGuguToolsOff.mutateAsync,
    checking,
    check: (name: string) => track(`gugu:${name}`, () => host.mcpLibrary.check(name)).finally(invalidate),
    harnessChecks,
    /** 内置、集成、App 那几台的工具列表(键见 `LibraryMcpProvidedServer.key`,内置那台是它的名字),这一页上取的,不记下来。 */
    providedChecks,
    checkProvided: (key: string) =>
      track(key, async () => {
        const result = await host.mcpLibrary.providedTools(key);
        setProvidedChecks((current) => ({ ...current, [key]: result }));
        return result;
      }),
    checkHarness: (providerId: string, name: string) =>
      track(`${providerId}:${name}`, async () => {
        const result = await host.mcpLibrary.checkHarnessServer(providerId, name);
        setHarnessChecks((current) => ({ ...current, [`${providerId}:${name}`]: result }));
        return result;
      }),
  };
}
