import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from '@gugu/core/local/childProcess';
import { guguReasonInText } from '@gugu/session-core/session-record/contract';
import { log } from '@main/lib/logger';
import { ConversionRouterPool, ccSwitchCandidates, harnessBaseUrl, isConversionHarness, launchConversionRouter } from './conversion-router';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// A stand-in for cc-switch-cli: `provider` records its arguments, `proxy serve` prints the bound address and waits.
async function fakeBinary(providerAddExit = 0): Promise<{ executable: string; scratchRoot: string; log: string; settings: string }> {
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
  *"provider add"*) exit ${providerAddExit} ;;
  *) exit 0 ;;
esac
`);
  await chmod(executable, 0o755);
  return { executable, scratchRoot: join(root, 'routers'), log, settings };
}

describe.skipIf(process.platform === 'win32')('conversion router', () => {
  it('reports an actionable startup reason when the converter cannot add its provider', async () => {
    const { executable, scratchRoot } = await fakeBinary(7);
    const error = await launchConversionRouter({
      executable, scratchRoot, harness: 'codex', upstream: 'http://127.0.0.1:5000/r/a/openai-chat-completions',
      relayKey: 'private-relay-key',
    }).then(() => null, (reason: Error) => reason);

    expect(guguReasonInText(error?.message)).toBe('conversion-start-failed');
    expect(error).toMatchObject({ phase: 'add-provider', exitCode: 7 });
    expect(error?.message).not.toContain('private-relay-key');
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it('allows a Windows provider add over ten seconds and reports the phase that exhausts the shared deadline', async () => {
    const { executable, scratchRoot } = await fakeBinary();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const stageLog = vi.mocked(log.warn).mockClear();
    const addStarted = Promise.withResolvers<void>();
    const switchStarted = Promise.withResolvers<void>();
    const delayedExit = (delay: number, started: () => void) => () => {
      const child = new EventEmitter() as ChildProcess;
      setTimeout(() => child.emit('close', 0), delay);
      started();
      return child;
    };
    vi.spyOn(childProcess, 'spawn')
      .mockImplementationOnce(delayedExit(12_000, addStarted.resolve))
      .mockImplementationOnce(delayedExit(19_000, switchStarted.resolve));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const startup = launchConversionRouter({
        executable, scratchRoot, harness: 'codex', upstream: 'http://127.0.0.1:5000/r/a/openai-chat-completions',
        relayKey: 'private-relay-key',
      });
      const failure = startup.then(() => null, (reason: Error) => reason);
      await addStarted.promise;
      Object.defineProperty(process, 'platform', platform);
      await vi.advanceTimersByTimeAsync(12_000);
      // The settings file is removed between steps. Race to fail quickly if the add budget wasn't honored.
      const progressed = await Promise.race([switchStarted.promise.then(() => true), failure.then(() => false)]);
      expect(progressed).toBe(true);
      await vi.advanceTimersByTimeAsync(19_000);
      const error = await failure;
      expect(guguReasonInText(error?.message)).toBe('conversion-switch-provider-timeout');
      expect(stageLog.mock.calls).toEqual([
        ['Local model protocol converter provider setup', expect.objectContaining({ phase: 'add-provider', elapsedMs: 12_000, outcome: 'finished' })],
        ['Local model protocol converter provider setup', expect.objectContaining({ phase: 'switch-provider', elapsedMs: 18_000, outcome: 'timeout' })],
      ]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

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
