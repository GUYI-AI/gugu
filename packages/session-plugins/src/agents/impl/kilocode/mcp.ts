import { opencodeFamilyMcpAdapter } from '../../helpers/opencode-family-mcp';

/**
 * Kilo reads the OpenCode MCP schema from `~/.config/kilo/`: kilo.jsonc, kilo.json, then the OpenCode
 * names (Kilo-Org/kilocode@v7.8.27 packages/opencode/src/config/config.ts:208).
 */
export function kilocodeMcpAdapter() {
  return opencodeFamilyMcpAdapter(
    '.config/kilo/kilo.json',
    ['.config/kilo/opencode.json', '.config/kilo/config.json'],
    ['.config/kilo/kilo.jsonc', '.config/kilo/opencode.jsonc'],
  );
}
