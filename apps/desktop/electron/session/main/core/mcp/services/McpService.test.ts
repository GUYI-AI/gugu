import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpService } from './McpService';

const h = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/core/agents/agent-home', () => ({ resolveAgentHomeRoot: async () => h.root }));

describe('McpService', () => {
  beforeEach(() => { h.root = mkdtempSync(join(tmpdir(), 'gugu-mcp-service-')); });
  afterEach(() => { rmSync(h.root, { recursive: true, force: true }); });

  it('does not list the relay entries Gugu writes into the Antigravity config as the person\'s servers (#4038)', async () => {
    const relay = (name: string) => ({ command: '/app/electron', disabled: false,
      args: ['/app/dist-electron/runtime/gugu-mcp-stdio-relay.mjs', name] });
    mkdirSync(join(h.root, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(h.root, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: {
      'gugu-mcp': relay('gugu-mcp'),
      'browser-use-gugu': relay('browser-use-gugu'),
      mine: { command: 'npx', args: ['-y', 'some-server'] },
      remote: { serverUrl: 'https://example.invalid/mcp' },
    } }));
    expect((await mcpService.listForAgent('antigravity')).map((server) => server.name)).toEqual(['mine', 'remote']);
  });
});
