import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import type { LibraryMcpCheck, LibraryMcpHarnessServer, LibraryMcpServer } from '@shared/mcp-library';

const harnessKey = (hostKey: string, agentId: string) => ['mcpLibrary', 'harness', hostKey, agentId] as const;

/**
 * 一家自己配的那几台 —— 段头展开才读(`enabled`),一家一个查询:读哪一家只等哪一家,一家读不了只坏它那一组。
 * 照读那一家的配置文件,❌ 跑它的 CLI(好几家 `mcp list` 会把每台 stdio server 起一遍)。
 */
export function useHarnessMcpServers(agentId: string, enabled: boolean) {
  const host = useLibraryHost();
  return useQuery({
    queryKey: harnessKey(host.key, agentId),
    queryFn: async (): Promise<LibraryMcpHarnessServer['server'][]> =>
      (await host.mcpLibrary.harnessServers([agentId])).map((row) => row.server),
    enabled: enabled && host.remote?.online !== false,
    ...(host.remote ? { retry: false } : {}),
  });
}

/**
 * 资源库 → MCP 的数据:这台机器(资源库选的那台)上咕咕自己管的列表,以及装了的各家自己的用户级那几台。
 * 各家的只读(由那一家自己加载);检测它们的结果只留在这一页,不记下来 —— 那不是咕咕的记录。
 */
export function useMcpLibrary() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  const listKey = ['mcpLibrary', host.key] as const;
  const reachable = host.remote?.online !== false;
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => host.mcpLibrary.list(),
    enabled: reachable,
    ...(host.remote ? { retry: false } : {}),
  });

  // 「咕咕提供」里的内置、集成、App 三组:和开会话时读的是同一组来源(见 mcp-library/service.ts `provided`)。
  const provided = useQuery({
    queryKey: ['mcpLibrary', 'provided', host.key],
    queryFn: () => host.mcpLibrary.provided(),
    enabled: reachable,
    ...(host.remote ? { retry: false } : {}),
  });
  const agents = useManagementAgents();
  const installed = useMemo(
    () => (agents.data ?? []).filter((agent) => agent.reading !== 'not-detected').sort((a, b) => a.name.localeCompare(b.name)),
    [agents.data]
  );
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: listKey });
  const add = useMutation({ mutationFn: (servers: LibraryMcpServer[]) => host.mcpLibrary.add(servers), onSettled: invalidate });
  const update = useMutation({ mutationFn: (server: LibraryMcpServer) => host.mcpLibrary.update(server), onSettled: invalidate });
  const remove = useMutation({ mutationFn: (name: string) => host.mcpLibrary.remove(name), onSettled: invalidate });
  const setEnabledByDefault = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => host.mcpLibrary.setEnabledByDefault(name, enabled),
    onSettled: invalidate,
  });

  // 正在检测的那几台(键 = `gugu:<名>` 或 `<家>:<名>`),以及各家那几台这一页上检测出来的结果。
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [harnessChecks, setHarnessChecks] = useState<Readonly<Record<string, LibraryMcpCheck>>>({});
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
    servers: list.data ?? [],
    provided: provided.data,
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
          servers: await queryClient.fetchQuery({
            queryKey: harnessKey(host.key, agent.id),
            queryFn: async () => (await host.mcpLibrary.harnessServers([agent.id])).map((row) => row.server),
          }),
        }))
      );
      for (const read of reads) {
        if (read.status !== 'fulfilled') continue;
        for (const server of read.value.servers) (names[server.name] ??= []).push(read.value.agent.name);
      }
      return names;
    },
    // 各家那几组只等「装了哪几家」(段头要画出来);各家的配置等展开才读。
    isLoading: list.isLoading || agents.isLoading || provided.isLoading,
    error: list.error ?? agents.error ?? provided.error,
    hasData: list.data !== undefined,
    reload: () => {
      void list.refetch();
      void provided.refetch();
      void queryClient.invalidateQueries({ queryKey: ['mcpLibrary', 'harness', host.key] });
    },
    isBusy: add.isPending || update.isPending || remove.isPending,
    add: add.mutateAsync,
    update: update.mutateAsync,
    remove: remove.mutateAsync,
    setEnabledByDefault: (name: string, enabled: boolean) => setEnabledByDefault.mutate({ name, enabled }),
    checking,
    check: (name: string) => track(`gugu:${name}`, () => host.mcpLibrary.check(name)).finally(invalidate),
    harnessChecks,
    checkHarness: (providerId: string, name: string) =>
      track(`${providerId}:${name}`, async () => {
        const result = await host.mcpLibrary.checkHarnessServer(providerId, name);
        setHarnessChecks((current) => ({ ...current, [`${providerId}:${name}`]: result }));
        return result;
      }),
  };
}
