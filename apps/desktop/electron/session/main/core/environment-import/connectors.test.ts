import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { importCodexConnectors, scanCodexConnectors } from './connectors';

let root: string, home: ResolvedAgentHome;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const servers = {
  docs: { url: 'https://docs.fixture.invalid/mcp', http_headers: { 'X-Test': 'header-fixture-secret' }, bearer_token_env_var: 'FIXTURE_TOKEN' },
  context: { command: 'npx', args: ['-y', 'fixture-mcp'] },
  disabled: { command: 'node', args: ['disabled.mjs'], cwd: '/fixture/space here', enabled: false },
  'token-cookie': { command: 'uvx', env: { EMPTY: '', FIXTURE_TOKEN: 'env-fixture-secret' } },
  pencil: { command: '/fixture/pencil', args: ['--port', '123'] },
  repl: { command: 'node', args: ['repl.mjs'], env_vars: ['LOCAL_TEST', { name: 'REMOTE_TEST', source: 'remote' }], startup_timeout_sec: 120,
    tool_timeout_sec: 37.5, required: false, enabled_tools: [], tools: { run: { approval_mode: 'prompt', output_token_limit: 512 } },
    env: { INSTRUCTIONS: 'fixture instructions\nsecond line', EMPTY: '' } },
};

async function write(path: string, text: string) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text);
}
const source = () => join(home.userConfigRoot, 'config.toml');
const target = () => join(home.configRoot, 'config.toml');
const selection = async () => (await scanCodexConnectors({ home })).items.map(({ localSourceId, fingerprint }) => ({ localSourceId, fingerprint }));

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'gugu-connectors-3216-'));
  home = resolveAgentHome({ providerId: 'codex', injectionMode: 'managed-config-root', guguHome: join(root, 'gugu'), osHomeDir: join(root, 'person'), sourceEnv: {},
    configRoot: { envVar: 'CODEX_HOME', userPath: '.codex', credentialPaths: [{ path: 'auth.json', evidence: 'Fixture login store.' }], importGroups: [] },
  })!;
  await write(source(), stringify({ model: 'fixture-model', mcp_servers: servers }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('Codex connector category — native managed configuration', () => {
  it('counts one HTTP/five stdio and returns stable metadata, without commands, URLs, env or login material', async () => {
    const before = await fs.readFile(source());
    await write(join(home.userConfigRoot, 'auth.json'), 'source-login-fixture-secret');
    const scan = await scanCodexConnectors({ home });
    expect(scan.status).toBe('ok');
    expect(scan.count).toBe(6);
    expect(scan.items.filter((item) => item.transport === 'http')).toHaveLength(1);
    expect(scan.items.filter((item) => item.transport === 'stdio')).toHaveLength(5);
    expect(scan.items.every((item) => item.status === 'ready')).toBe(true);
    expect((await scanCodexConnectors({ home })).items).toEqual(scan.items);
    const serialized = JSON.stringify(scan);
    for (const value of ['docs.fixture.invalid', 'header-fixture-secret', 'env-fixture-secret', 'source-login-fixture-secret', 'fixture instructions', '/fixture/pencil', 'npx']) {
      expect(serialized).not.toContain(value);
    }
    expect(sha(await fs.readFile(source()))).toBe(sha(before));
    await expect(fs.stat(home.shadowHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('imports selected entries only; preserves all native fields, empty values and unrelated managed settings', async () => {
    const before = await fs.readFile(source());
    await write(target(), stringify({ model: 'managed-model', mcp_servers: { own: { command: 'owned-command' } } }));
    const chosen = (await scanCodexConnectors({ home })).items.filter((item) => ['docs', 'repl', 'token-cookie'].includes(item.name));
    const result = await importCodexConnectors({ home, selection: chosen });
    expect(result.items.map((item) => item.status)).toEqual(['imported', 'imported', 'imported']);
    const config = parse(await fs.readFile(target(), 'utf8'));
    expect(config.model).toBe('managed-model');
    expect(config.mcp_servers).toEqual({ own: { command: 'owned-command' }, docs: servers.docs, repl: servers.repl, 'token-cookie': servers['token-cookie'] });
    expect((await fs.stat(target())).mode & 0o777).toBe(0o600);
    expect(sha(await fs.readFile(source()))).toBe(sha(before));
    await expect(fs.stat(join(home.configRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('recognizes entries already supplied by the full-home migration and does not rewrite the file', async () => {
    await write(target(), await fs.readFile(source(), 'utf8'));
    const before = await fs.readFile(target());
    const scan = await scanCodexConnectors({ home });
    expect(scan.items.every((item) => item.status === 'already-exists')).toBe(true);
    expect((await importCodexConnectors({ home, selection: scan.items })).items.every((item) => item.status === 'already-exists')).toBe(true);
    expect(await fs.readFile(target())).toEqual(before);
  });

  it('preserves a conflicting managed entry and imports independent selections', async () => {
    await write(target(), stringify({ mcp_servers: { context: { command: 'user-edited' } } }));
    const result = await importCodexConnectors({ home, selection: await selection() });
    expect(result.items.find((item) => item.name === 'context')).toMatchObject({ status: 'conflict', reason: 'different-config' });
    expect(result.items.filter((item) => item.status === 'imported')).toHaveLength(5);
    expect((parse(await fs.readFile(target(), 'utf8')).mcp_servers as Record<string, unknown>).context).toEqual({ command: 'user-edited' });
  });

  it('rechecks a preview fingerprint and rejects changed or deleted source entries', async () => {
    const chosen = await selection();
    const { pencil: _removed, ...remaining } = servers;
    await write(source(), stringify({ mcp_servers: { ...remaining, context: { command: 'changed-after-preview' } } }));
    const result = await importCodexConnectors({ home, selection: chosen.filter((entry) => [chosen[1]!.localSourceId, chosen[4]!.localSourceId].includes(entry.localSourceId)) });
    expect(result.items.map((item) => item.status)).toEqual(['source-changed', 'source-changed']);
    await expect(fs.stat(target())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not turn malformed source or target documents into a successful empty import', async () => {
    const chosen = await selection();
    await write(source(), '[mcp_servers.docs]\nurl = "syntax-fixture-secret\n');
    expect(await scanCodexConnectors({ home })).toEqual({ count: 0, items: [], status: 'invalid' });
    expect((await importCodexConnectors({ home, selection: chosen })).items.every((item) => item.status === 'failed' && item.reason === 'source-unreadable')).toBe(true);
    await write(source(), stringify({ mcp_servers: servers }));
    await write(target(), 'private = "syntax-target-fixture-secret\n');
    const scan = await scanCodexConnectors({ home });
    expect(scan.count).toBe(6);
    expect(scan.items.every((item) => item.status === 'failed' && item.reason === 'target-unreadable')).toBe(true);
    expect(JSON.stringify(scan)).not.toContain('syntax-');
    const before = await fs.readFile(target());
    await importCodexConnectors({ home, selection: scan.items });
    expect(await fs.readFile(target())).toEqual(before);
  });

  it('distinguishes a missing source from a valid configuration with no connectors', async () => {
    await fs.rm(source());
    expect(await scanCodexConnectors({ home })).toEqual({ count: 0, items: [], status: 'missing' });
    await write(source(), 'model = "fixture"\n');
    expect(await scanCodexConnectors({ home })).toMatchObject({ count: 0, items: [], status: 'ok' });
    expect(await importCodexConnectors({ home, selection: [] })).toEqual({ items: [] });
    await expect(fs.stat(target())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a target alias pointing into the source home', async () => {
    await fs.mkdir(home.shadowHome, { recursive: true });
    await fs.symlink(home.userConfigRoot, home.configRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await fs.readFile(source());
    const scan = await scanCodexConnectors({ home });
    expect(scan.items.every((item) => item.reason === 'unsafe-target')).toBe(true);
    expect((await importCodexConnectors({ home, selection: scan.items })).items.every((item) => item.reason === 'unsafe-target')).toBe(true);
    expect(await fs.readFile(source())).toEqual(before);
  });

  it('uses the existing sensitive-link exclusion and permits ordinary linked configuration', async () => {
    const linked = join(root, 'person', '.ssh', 'private-config.toml');
    await write(linked, stringify({ mcp_servers: servers }));
    await fs.rm(source());
    await fs.symlink(linked, source(), 'file');
    expect(await scanCodexConnectors({ home })).toEqual({ count: 0, items: [], status: 'sensitive' });
    await fs.rm(source());
    const ordinary = join(root, 'shared', 'config.toml');
    await write(ordinary, stringify({ mcp_servers: servers }));
    await fs.symlink(ordinary, source(), 'file');
    const scan = await scanCodexConnectors({ home });
    expect(scan.count).toBe(6);
    expect((await importCodexConnectors({ home, selection: scan.items })).items.every((item) => item.status === 'imported')).toBe(true);
  });

  it('propagates cancellation and leaves the source and destination unchanged', async () => {
    const chosen = await selection();
    const controller = new AbortController(), reason = new Error('fixture-cancelled');
    controller.abort(reason);
    await expect(scanCodexConnectors({ home, signal: controller.signal })).rejects.toBe(reason);
    await expect(importCodexConnectors({ home, selection: chosen, signal: controller.signal })).rejects.toBe(reason);
    await expect(fs.stat(target())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent category imports so neither loses the other selection', async () => {
    const chosen = await selection();
    const result = await Promise.all([
      importCodexConnectors({ home, selection: chosen.slice(0, 3) }),
      importCodexConnectors({ home, selection: chosen.slice(3) }),
    ]);
    expect(result.flatMap((batch) => batch.items).every((item) => item.status === 'imported')).toBe(true);
    expect(parse(await fs.readFile(target(), 'utf8')).mcp_servers).toEqual(servers);
  });
});
