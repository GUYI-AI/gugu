// One Codex MCP call (the app-server `mcpToolCall` item; `McpToolCall` in a rollout) as an ACP tool call: the live bridge
// and the record read it the same way.

export interface CodexMcpCall {
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: unknown;
}

/**
 * `mcp__<server>__<tool>`: the title shape the reducer reads as an MCP call and splits into server + tool. Its result's
 * blocks (text, image, …) are the output, as the Claude bridge sends a tool's result: a client reads a tool's pictures
 * there, not in the provider's own `rawOutput`. The output travels once (review 10f3ea946c): a result those blocks carry
 * whole — nothing in it besides `content`, and only blocks the client reads (text, image) — is not sent again as
 * rawOutput. A failure, a result with more in it (structuredContent, isError, …), or one with a block the client does not
 * read (resource_link, resource, audio: review 3b0e55360c) keeps the provider's value.
 */
export function codexMcpCall(item: CodexMcpCall): { name: string; rawInput: unknown; rawOutput: unknown; blocks: Array<Record<string, unknown>> } {
  const blocks = Array.isArray(item.result?.content) ? item.result.content as Array<Record<string, unknown>> : [];
  const { content: _content, ...besides } = item.result ?? {};
  const carried = !item.error
    && blocks.length > 0
    && blocks.every((block) => block?.type === 'text' || block?.type === 'image')
    && Object.values(besides).every((value) => value == null || value === false);
  return {
    name: `mcp__${item.server || 'mcp'}__${item.tool || 'tool'}`,
    rawInput: item.arguments,
    rawOutput: item.error ?? (carried ? undefined : item.result) ?? undefined,
    blocks,
  };
}
