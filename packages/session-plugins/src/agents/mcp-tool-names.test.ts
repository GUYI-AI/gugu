import { expect, it } from 'vitest';
import { AcpTranscriptParser, decodeSessionUpdate } from '@gugu/session-core/acp';
import { mcpToolNamesOn } from '@gugu/session-core/agents/plugins';
import { pluginRegistry } from './registry';

// A harness that lists gugu tools under its own spelling has its calls drawn in the task page (tool name, sent card)
// only when the timeline folds that spelling into a gugu MCP call.
it('folds every declared gugu tool spelling into a gugu MCP call', () => {
  const declared = pluginRegistry.getAll().flatMap((plugin) => {
    const mcp = plugin.capabilities.mcp;
    if (mcp.kind !== 'supported') return [];
    return (['acp', 'tui'] as const).flatMap((surface) => {
      const names = mcpToolNamesOn(mcp.toolNames, surface);
      return names.kind === 'listed' ? [[`${plugin.metadata.id}/${surface}`, names.prefix] as const] : [];
    });
  });
  expect(declared.map(([, prefix]) => prefix)).toEqual(expect.arrayContaining(['mcp__gugu__', 'gugu_', 'gugu-']));
  for (const [harness, prefix] of declared) {
    const parser = new AcpTranscriptParser({ sessionId: 's' });
    parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'X', title: `${prefix}widget_send`, kind: 'other', status: 'completed' }));
    expect(parser.activeTurn?.items, harness).toMatchObject([{ kind: 'mcp-tool-call', server: expect.stringMatching(/^(gugu|plugin_.+_gugu)$/), tool: 'widget_send' }]);
  }
});
