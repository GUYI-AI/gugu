/** Gugu shows no predicted next prompt, so a Claude session must not spend a model request on one. */
import type { SessionMaterialization } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../../registry';

function materialize(): SessionMaterialization {
  return pluginRegistry.get('claude')!.behavior.sessionBundle!.materialize(
    { surface: 'acp', lifecycle: 'fresh', cwd: '/worktree' },
    { mcpServers: [], env: {}, model: null, autonomy: null, promptBlocks: {}, packages: [] } as never,
  );
}

describe('Claude chat sessions', () => {
  it('turn off the prompt prediction in the options the adapter hands to the SDK', () => {
    const options = (materialize().acp?.meta as { claudeCode?: { options?: Record<string, unknown> } }).claudeCode?.options;
    expect(options?.promptSuggestions).toBe(false);
  });
});
