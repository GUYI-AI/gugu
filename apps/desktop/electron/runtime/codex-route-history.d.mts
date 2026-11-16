// codex-route-history.mjs 的类型面(与 codex-fork-handoff.d.mts 同理)。

export declare function routeSwitchHistory(
  rpc: (method: string, params: unknown) => Promise<any>,
  threadId: string,
): Promise<Array<Record<string, unknown>>>
