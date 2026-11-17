import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAntigravityPlan } from './subscription';
import { tierNameFromAcpResponse } from './acp-tier';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(tier: unknown, authRequired = false) {
  const root = await mkdtemp(join(tmpdir(), 'agy-tier-test-'));
  roots.push(root);
  const cli = join(root, 'agy');
  const transcript = join(root, 'requests.jsonl');
  const home = join(root, '.gemini');
  await mkdir(home);
  await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method === 'session/new' && ${authRequired}) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n');
    return;
  }
  const result = request.method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { _meta: { antigravity: { tier: true } } } }
    : { sessionId: 'fixture-session', _meta: { antigravity: { tier: ${JSON.stringify(tier)} } } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`, { mode: 0o755 });
  const ctx = {
    cli,
    env: { HOME: root, GEMINI_HOME: home, PATH: process.env.PATH ?? '' },
    fsFollowsConfigRoot: true,
    fs: { read: vi.fn().mockResolvedValue(null) },
    exec: vi.fn().mockResolvedValue({ stdout: 'gemini-4-carbon-high\tGemini 4 Carbon (High)\n', stderr: '' }),
  } as unknown as AgentAuthContext;
  return { ctx, transcript };
}

describe('Antigravity subscription comes from the signed-in CLI ACP response', () => {
  it('recognizes Ultra without an IDE installation and sends no model prompt or authenticate request', async () => {
    const { ctx, transcript } = await fixture({ id: 'g1-ultra-lite-tier', name: 'Google AI Ultra', upgradeUri: 'https://antigravity.google/g1-upgrade' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'session/new']);
    expect(requests.at(-1).params.mcpServers).toEqual([]);
  });

  it('does not infer Ultra from Carbon access if the server reports no tier', async () => {
    const { ctx } = await fixture(null);
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI', tierUnknown: true });
  });

  it('does not start an ACP server when the CLI reports signed out', async () => {
    const { ctx, transcript } = await fixture({ name: 'Google AI Ultra' });
    vi.mocked(ctx.exec).mockRejectedValue({ code: 1, stderr: 'Please sign in to view available models.' });
    await expect(readAntigravityPlan(ctx)).resolves.toEqual({ payer: 'not-signed-in' });
    await expect(readFile(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an ACP authentication failure instead of returning a successful unknown subscription', async () => {
    const { ctx } = await fixture(null, true);
    await expect(readAntigravityPlan(ctx)).resolves.toEqual({ payer: 'not-signed-in' });
  });

  it('ignores missing or malformed tier metadata rather than rendering untrusted control characters', () => {
    expect(tierNameFromAcpResponse(null)).toBeNull();
    expect(tierNameFromAcpResponse({ _meta: { antigravity: { tier: { name: 3 } } } })).toBeNull();
    expect(tierNameFromAcpResponse({ _meta: { antigravity: { tier: { name: 'Google AI\nUltra' } } } })).toBeNull();
  });
});
