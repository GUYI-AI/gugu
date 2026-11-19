import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversionRouterPool, ccSwitchCandidates, harnessBaseUrl, isConversionHarness, launchConversionRouter } from './conversion-router';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// A stand-in for cc-switch-cli: `provider` records its arguments, `proxy serve` prints the bound address and waits.
async function fakeBinary(): Promise<{ executable: string; scratchRoot: string; log: string; settings: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gugu-router-test-'));
  roots.push(root);
  const log = join(root, 'calls.log');
  const settings = join(root, 'settings.log');
  const executable = join(root, 'cc-switch');
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "HOME=$HOME CFG=$CC_SWITCH_CONFIG_DIR $*" >> '${log}'
prev=; for arg; do [ "$prev" = --config-file ] && cat "$arg" >> '${settings}'; prev=$arg; done
case "$*" in
  *"proxy serve"*) echo "Listening on http://127.0.0.1:43219"; trap 'exit 0' TERM; while :; do sleep 1; done ;;
  *) exit 0 ;;
esac
`);
  await chmod(executable, 0o755);
  return { executable, scratchRoot: join(root, 'routers'), log, settings };
}

describe.skipIf(process.platform === 'win32')('conversion router', () => {
  it('configures the provider with the relay token in a private directory and removes it on stop', async () => {
    const { executable, scratchRoot, log, settings } = await fakeBinary();
    const router = await launchConversionRouter({ executable, scratchRoot, harness: 'claude', upstream: 'http://127.0.0.1:5000/r/a/openai-chat-completions', relayKey: 'sk-gugu-relay' });
    expect(router.endpoint).toBe('http://127.0.0.1:43219');
    const calls = await readFile(log, 'utf8');
    expect(calls).toContain(`HOME=${router.directory} CFG=${join(router.directory, 'state')}`);
    // The token never appears on a command line, and its settings file is gone once the provider is added.
    expect(calls).not.toContain('sk-gugu-relay');
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000/r/a/openai-chat-completions/chat/completions#', ANTHROPIC_AUTH_TOKEN: 'sk-gugu-relay' },
    });
    expect(await readdir(router.directory)).not.toContain('provider.json');
    expect(calls).toContain('--api-format openai_chat');
    expect(calls).toContain('proxy serve --listen-address 127.0.0.1 --listen-port 0');
    await router.stop();
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it('refuses an upstream that is not the local relay', async () => {
    const { executable, scratchRoot } = await fakeBinary();
    await expect(launchConversionRouter({ executable, scratchRoot, harness: 'codex', upstream: 'https://provider.test/v1', relayKey: 'k' })).rejects.toThrow('local relay');
  });

  it('reuses one router per harness and record, and closes them all', async () => {
    const { executable, scratchRoot } = await fakeBinary();
    const pool = new ConversionRouterPool({ executable, scratchRoot }, 60_000, () => {});
    const upstream = 'http://127.0.0.1:5000/r/a/openai-chat-completions';
    const first = await pool.acquire('codex', 'a', upstream, 'k');
    const again = await pool.acquire('codex', 'a', upstream, 'k');
    expect(again.router).toBe(first.router);
    await expect(pool.acquire('codex', 'a', upstream, 'other')).rejects.toThrow('changed');
    await pool.close();
    expect(await readdir(scratchRoot)).toEqual([]);
  });
});

it('finds the bundled binary and gives each harness the base URL its client expects', () => {
  const input = { env: {}, platform: 'darwin' as const, arch: 'arm64', isPackaged: true, resourcesPath: '/App/Resources', appPath: '/App/app' };
  expect(ccSwitchCandidates(input)).toEqual(['/App/Resources/cc-switch-bundle/cc-switch', '/App/app/cc-switch-bundle/cc-switch', '/App/app/cc-switch-bundle/mac-arm64/cc-switch']);
  expect(ccSwitchCandidates({ ...input, platform: 'win32', env: { GUGU_CC_SWITCH_BIN: 'C:\\cc.exe' } })[0]).toBe('C:\\cc.exe');
  expect(harnessBaseUrl('claude', { endpoint: 'http://127.0.0.1:1' })).toBe('http://127.0.0.1:1');
  expect(harnessBaseUrl('codex', { endpoint: 'http://127.0.0.1:1' })).toBe('http://127.0.0.1:1/v1');
  expect(isConversionHarness('claude')).toBe(true);
  expect(isConversionHarness('pi')).toBe(false);
});
