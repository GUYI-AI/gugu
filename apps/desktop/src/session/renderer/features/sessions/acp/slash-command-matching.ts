import type { CommandItem } from '@gugu/session-ui/react/components';
import { commandToken } from '@gugu/session-core/acp/commands';
import type { HarnessCatalogState } from '@main/core/agents/harness-model-catalog';

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase();
}

function commandMatchesQuery(command: CommandItem, query: string): boolean {
  if (!query) return true;
  return [command.name, command.label, command.description]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(query));
}

function matchRank(command: CommandItem, query: string): number {
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;

  const label = command.label?.toLowerCase();
  if (label === query) return 3;
  if (label?.startsWith(query)) return 4;
  if (label?.includes(query)) return 5;

  return 6;
}

/**
 * Return provider commands in match-quality order while preserving provider order for ties.
 * An empty query deliberately keeps the provider's advertised order.
 */
export function filterSlashCommands(commands: readonly CommandItem[], query: string): CommandItem[] {
  const normalized = normalizedQuery(query);
  return commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => commandMatchesQuery(command, normalized))
    .sort((left, right) => {
      if (!normalized) return left.index - right.index;
      return (
        matchRank(left.command, normalized) - matchRank(right.command, normalized) ||
        left.index - right.index
      );
    })
    .map(({ command }) => command);
}

/** An agent's advertised commands as the `/` menu offers them (`commandToken`: the text the agent has to receive). */
export function advertisedCommandItems(commands: readonly { name: string; description: string; inputHint?: string }[]): CommandItem[] {
  return commands.map((command) => ({
    id: command.name,
    name: command.name,
    // 发出去的原文由 ACP 领域规则算:裸名配 `/`,自带 sigil 的(codex 的 `$skill`)原样。
    // 编辑器只负责把这个字符串插进去,❌ 它不许自己拼前缀。
    token: commandToken(command.name),
    description: command.description,
    behavior: 'insert' as const,
    // reducer 早就把 `input.hint` 采下来了(acp/reducer/reducer.ts);缺席就是「不吃参数」。
    ...(command.inputHint ? { inputHint: command.inputHint } : {}),
  }));
}

/**
 * The commands a harness advertised to the host's probe of it (`HarnessCatalogState.commands`): what an agent of that
 * harness will take before it has a session of its own (the new-agent composer, a session whose engine has not started).
 */
export function catalogCommandItems(state: HarnessCatalogState): CommandItem[] {
  if (state.kind !== 'ready' || !state.commands) return [];
  return advertisedCommandItems(state.commands.map((command) => ({
    name: command.name, description: command.description, ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
  })));
}
