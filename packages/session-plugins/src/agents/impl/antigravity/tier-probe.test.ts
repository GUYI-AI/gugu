import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAntigravityPlan, readAntigravityUsage } from './subscription';
import { observeAgyTier, tierNameFromAcpResponse } from './acp-tier';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(tier: unknown, authRequired = false, tokenFile = true) {
  const root = await mkdtemp(join(tmpdir(), 'agy-tier-test-'));
  roots.push(root);
  const cli = join(root, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  const script = process.platform === 'win32' ? join(root, 'fake-agy.cjs') : cli;
  const transcript = join(root, 'requests.jsonl');
  const home = join(root, '.gemini');
  await mkdir(join(home, 'antigravity-cli', 'conversations'), { recursive: true });
  await writeFile(join(home, 'antigravity-cli', 'conversations', 'preserved.db'), 'existing history');
  if (tokenFile) await writeFile(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'account-a-fixture');
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method === 'session/new' && ${authRequired}) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n');
    return;
  }
  if (request.method === 'session/new') {
    const probe = process.argv[process.argv.indexOf('--gemini-dir') + 1];
    fs.writeFileSync(${JSON.stringify(join(root, 'probe-location.json'))}, JSON.stringify(probe));
    fs.writeFileSync(path.join(probe, 'antigravity-cli', 'conversations', 'empty-probe.db'), 'empty session');
  }
  const result = request.method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { _meta: { antigravity: { tier: true } } } }
    : { sessionId: 'fixture-session', _meta: { antigravity: { tier: ${JSON.stringify(tier)} } } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`, { mode: 0o755 });
  if (process.platform === 'win32') await writeFile(cli, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const ctx = {
    cli,
    env: { ...process.env, HOME: root, GEMINI_HOME: home },
    fsFollowsConfigRoot: true,
    fs: { read: vi.fn().mockResolvedValue(null) },
    exec: vi.fn().mockResolvedValue({ stdout: 'gemini-4-carbon-high\tGemini 4 Carbon (High)\n', stderr: '' }),
  } as unknown as AgentAuthContext;
  return { ctx, transcript, home, root };
}

describe('Antigravity subscription comes from the signed-in CLI ACP response', () => {
  it('recognizes Ultra without an IDE installation and sends no model prompt or authenticate request', async () => {
    const { ctx, transcript } = await fixture({ id: 'g1-ultra-lite-tier', name: 'Google AI Ultra', upgradeUri: 'https://antigravity.google/g1-upgrade' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'session/new']);
    expect(requests.at(-1).params.mcpServers).toEqual([]);
    // Each read confirms sign-in; only the first opens an ACP session.
    expect(vi.mocked(ctx.exec).mock.calls.filter(([, args]) => args?.includes('models'))).toHaveLength(2);
  });

  it('does not infer Ultra from Carbon access if the server reports no tier', async () => {
    const { ctx } = await fixture(null);
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI', tierUnknown: true });
  });

  it('keeps probe-created conversations out of the managed history and removes the scratch store', async () => {
    const { ctx, home, root } = await fixture({ name: 'Google AI Pro' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ plan: 'Google AI Pro' });
    expect(await readdir(join(home, 'antigravity-cli', 'conversations'))).toEqual(['preserved.db']);
    const probe = JSON.parse(await readFile(join(root, 'probe-location.json'), 'utf8'));
    expect(probe).not.toBe(home);
    await expect(readdir(probe)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates the cached tier when the account credential generation changes', async () => {
    const { ctx, transcript, home } = await fixture({ name: 'Google AI Ultra' });
    await readAntigravityPlan(ctx);
    await writeFile(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'different-account-fixture');
    await readAntigravityPlan(ctx);
    const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'session/new')).toHaveLength(2);
  });

  it('uses tier metadata from a real chat open without starting a plan-only ACP process', async () => {
    const { ctx, transcript } = await fixture({ name: 'unused' });
    await observeAgyTier(ctx, { _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } }, ctx.exec);
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ plan: 'Google AI Pro', planAsOf: expect.any(Number) });
    await expect(readFile(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a cached tier never outlives a sign-out', async () => {
    const { ctx } = await fixture({ name: 'unused' });
    await observeAgyTier(ctx, { _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } }, ctx.exec);
    vi.mocked(ctx.exec).mockRejectedValue({ code: 1, stderr: 'Please sign in to view available models.' });
    await expect(readAntigravityPlan(ctx)).resolves.toEqual({ payer: 'not-signed-in' });
  });

  it.skipIf(process.platform === 'darwin')('without a credential file, an account switch is invisible, so the tier is read live each time', async () => {
    const { ctx, transcript, home } = await fixture({ name: 'Google AI Ultra' }, false, false);
    await observeAgyTier(ctx, { _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } }, ctx.exec);
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ plan: 'Google AI Ultra' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ plan: 'Google AI Ultra' });
    expect(await readdir(home)).not.toContain('.gugu-cli-tier.json');
    const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'session/new')).toHaveLength(2);
  });

  it('checks authentication before a usage command even when the caller has a cached subscription plan', async () => {
    const { ctx } = await fixture({ name: 'Google AI Ultra' });
    vi.mocked(ctx.exec).mockRejectedValue({ code: 1, stderr: 'Please sign in to view available models.' });
    await expect(readAntigravityUsage(ctx, { payer: 'subscription', plan: 'Google AI Ultra' }))
      .resolves.toMatchObject({ kind: 'unavailable', reason: 'not-signed-in' });
    expect(vi.mocked(ctx.exec).mock.calls.some(([, args]) => args?.includes('/usage'))).toBe(false);
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
