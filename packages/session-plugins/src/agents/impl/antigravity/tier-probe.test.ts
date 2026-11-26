import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAntigravityPlan, readAntigravityUsage, windowsFromAgyUsage } from './subscription';
import { bindAgyTierObservation, tierNameFromAcpResponse } from './acp-tier';
import { antigravityCliAuthStatus, execAntigravityCli } from './auth';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(tier: unknown, authRequired = false) {
  const root = await mkdtemp(join(tmpdir(), 'agy-tier-test-'));
  roots.push(root);
  const cli = join(root, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  const script = process.platform === 'win32' ? join(root, 'fake-agy.cjs') : cli;
  const transcript = join(root, 'requests.jsonl');
  const home = join(root, '.gemini');
  await mkdir(join(home, 'antigravity-cli', 'conversations'), { recursive: true });
  await writeFile(join(home, 'antigravity-cli', 'conversations', 'preserved.db'), 'existing history');
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
    fs.writeFileSync(${JSON.stringify(join(root, 'probe-mcp.json'))}, fs.readFileSync(path.join(probe, 'config', 'mcp_config.json')));
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
    env: { ...process.env, SSH_CONNECTION: '', HOME: root, GEMINI_HOME: home },
    fsFollowsConfigRoot: true,
    fs: { read: vi.fn().mockResolvedValue(null) },
    exec: vi.fn().mockResolvedValue({ stdout: 'gemini-4-carbon-high\tGemini 4 Carbon (High)\n', stderr: '' }),
  } as unknown as AgentAuthContext;
  return { ctx, transcript, home, root };
}

function useTrackedCachePlatform() {
  if (process.platform === 'linux') {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  }
}

describe('Antigravity subscription comes from the signed-in CLI ACP response', () => {
  it('reads an isolated saved account without querying models or another account’s keyring', async () => {
    const { ctx } = await fixture({ name: 'Google AI Pro' });
    ctx.env.SSH_CONNECTION = '127.0.0.1 1 127.0.0.1 2';
    vi.mocked(ctx.fs.read).mockImplementation(async path => path.endsWith('antigravity-oauth-token')
      ? JSON.stringify({ token: { refresh_token: 'fixture-refresh', id_token: `h.${Buffer.from(JSON.stringify({ email: 'account@example.test' })).toString('base64url')}.s` } }) : null);
    expect(await antigravityCliAuthStatus(ctx)).toEqual({ kind: 'authenticated', credentialKind: 'subscription', account: 'account@example.test' });
    expect(ctx.exec).not.toHaveBeenCalled();
    vi.mocked(ctx.fs.read).mockResolvedValue(null);
    expect(await antigravityCliAuthStatus(ctx)).toEqual({ kind: 'unauthenticated' });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('keeps every vendor quota group and never substitutes missing fractions with zero', () => {
    expect(windowsFromAgyUsage(JSON.stringify({ command: { data: { groups: [{ name: 'Gemini Models', buckets: [
      { window: 'weekly', remaining_fraction: 0, reset_time: '2026-12-01T00:00:00Z' },
      { window: '5h', remaining_fraction: 0.75 }, { window: '5h' },
    ] }, { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 1 }] }] } } })))
      .toEqual([{ group: 'Gemini Models', windowMinutes: 10_080, usedPercent: 100, resetsAt: Date.parse('2026-12-01T00:00:00Z') },
        { group: 'Gemini Models', windowMinutes: 300, usedPercent: 25 },
        { group: 'Claude and GPT models', windowMinutes: 10_080, usedPercent: 0 }]);
  });
  it('recognizes Ultra without an IDE installation and sends no model prompt or authenticate request', async () => {
    useTrackedCachePlatform();
    const { ctx, transcript } = await fixture({ id: 'g1-ultra-lite-tier', name: 'Google AI Ultra', upgradeUri: 'https://antigravity.google/g1-upgrade' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'session/new']);
    expect(requests.at(-1).params.mcpServers).toEqual([]);
    expect(vi.mocked(ctx.exec).mock.calls.filter(([, args]) => args?.includes('models'))).toHaveLength(process.platform === 'darwin' ? 0 : 1);
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
    useTrackedCachePlatform();
    const { ctx, transcript, home } = await fixture({ name: 'Google AI Ultra' });
    await readAntigravityPlan(ctx);
    await writeFile(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'different-account-fixture');
    await readAntigravityPlan(ctx);
    const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'session/new')).toHaveLength(2);
  });

  it('uses tier metadata from a real chat open without starting a plan-only ACP process', async () => {
    useTrackedCachePlatform();
    const { ctx, transcript } = await fixture({ name: 'unused' });
    await (await bindAgyTierObservation(ctx, ctx.exec))({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ plan: 'Google AI Pro', planAsOf: expect.any(Number) });
    await expect(readFile(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('revalidates sign-out when account A only changed in the Linux keyring', async () => {
    const { ctx, transcript } = await fixture({ name: 'unused' });
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    await (await bindAgyTierObservation(ctx, ctx.exec))({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } });
    vi.mocked(ctx.exec).mockRejectedValue({ code: 1, stderr: 'Please sign in to view available models.' });
    await expect(readAntigravityPlan(ctx)).resolves.toEqual({ payer: 'not-signed-in' });
    expect(vi.mocked(ctx.exec).mock.calls.filter(([, args]) => args?.includes('models'))).toHaveLength(1);
    await expect(readFile(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('reads account B when Linux credential files have not changed since account A', async () => {
    const { ctx, transcript } = await fixture({ name: 'Google AI Ultra' });
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    await (await bindAgyTierObservation(ctx, ctx.exec))({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    expect(vi.mocked(ctx.exec).mock.calls.filter(([, args]) => args?.includes('models'))).toHaveLength(1);
    expect(await readFile(transcript, 'utf8')).toContain('session/new');
  });

  it.skipIf(process.platform === 'win32')('leaves the tier unknown when only an unrelated Linux IDE cache is available', async () => {
    const { ctx, root } = await fixture(null);
    const ide = join(root, '.config', 'Antigravity IDE', 'User', 'globalStorage');
    await mkdir(ide, { recursive: true });
    await writeFile(join(ide, 'state.vscdb'), 'old IDE fixture');
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }));
    vi.mocked(ctx.exec).mockResolvedValue({
      stdout: Buffer.from('g1-pro-tier\x12\x0dGoogle AI Pro', 'latin1').toString('base64'),
      stderr: '',
    });
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({
      payer: 'subscription', plan: 'Google AI', tierUnknown: true,
    });
    expect(vi.mocked(ctx.exec).mock.calls.some(([command]) => command === 'sqlite3')).toBe(false);
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

  it('drops a tier that arrives after the account that opened the conversation changed', async () => {
    useTrackedCachePlatform();
    const { ctx, transcript, home } = await fixture({ name: 'Google AI Ultra' });
    const token = join(home, 'antigravity-cli', 'antigravity-oauth-token');
    await writeFile(token, 'account-a');
    const observe = await bindAgyTierObservation(ctx, ctx.exec); // the open request leaves as account A
    await writeFile(token, 'account-b, signed in while A was opening');
    await observe({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } }); // A's response arrives late
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ payer: 'subscription', plan: 'Google AI Ultra' });
    expect(await readFile(transcript, 'utf8')).toContain('session/new');
  });

  it('drops a tier that arrives after the account signed out during the open', async () => {
    useTrackedCachePlatform();
    const { ctx, home } = await fixture({ name: 'unused' });
    const token = join(home, 'antigravity-cli', 'antigravity-oauth-token');
    await writeFile(token, 'account-a');
    const observe = await bindAgyTierObservation(ctx, ctx.exec);
    await rm(token);
    await observe({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } });
    expect(await readdir(home)).not.toContain('.gugu-cli-tier.json');
  });

  it('runs Windows status reads in a scratch profile with the credentials and no MCP servers', async () => {
    const { ctx, home } = await fixture(null);
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { marker: { command: 'marker-mcp-must-not-start' } } }));
    await writeFile(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'account-a');
    const seen: { args: string[]; profile: string; mcp: string; token: string }[] = [];
    vi.mocked(ctx.exec).mockImplementation(async (_command, args, options) => {
      const profile = options!.env!.USERPROFILE!;
      expect(options!.env!.HOME).toBe(profile);
      seen.push({ args: args!, profile, mcp: await readFile(join(profile, '.gemini', 'config', 'mcp_config.json'), 'utf8'),
        token: await readFile(join(profile, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8') });
      return { stdout: '', stderr: '' };
    });
    await expect(antigravityCliAuthStatus(ctx, 'win32')).resolves.toEqual({ kind: 'authenticated' });
    await execAntigravityCli(ctx, ['-p', '/usage', '--output-format', 'json'], 1000, 'win32');
    expect(seen.map(call => call.args[0])).toEqual(['models', '-p']);
    for (const call of seen) {
      expect(JSON.parse(call.mcp)).toEqual({ mcpServers: {} });
      expect(call.token).toBe('account-a');
      expect(call.profile).not.toBe(dirname(home));
      await expect(readdir(call.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('starts the plan probe with an empty MCP configuration', async () => {
    useTrackedCachePlatform();
    const { ctx, home, root } = await fixture({ name: 'Google AI Pro' });
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { marker: { command: 'marker-mcp-must-not-start' } } }));
    await expect(readAntigravityPlan(ctx)).resolves.toMatchObject({ plan: 'Google AI Pro' });
    expect(JSON.parse(await readFile(join(root, 'probe-mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
  });
});
