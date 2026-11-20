import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformBuildMissingError, type MiseDistribution } from './mise-distribution';
import { sampleInstallArchive, selectInstallSources } from './install-source-race';
import { installProxyRoute, UnmeasurableInstallTransport } from './install-source-transport';

const target = { kind: 'mise' as const, package: '@vendor/agent', binary: 'agent', backend: { kind: 'platform-archive' as const, executables: {} } };
const source = { kind: 'automatic' as const, registries: ['official', 'npmmirror', 'huawei'], fallbackRegistry: 'official' };
const env = { HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,.internal.test' };
const release = (registry: string, version = '1.2.3'): MiseDistribution => ({ kind: 'platform-archive', tool: 'http:gugu-agent', version,
  installVersion: version + '-' + registry, executable: 'bin/agent', config: 'recipe-' + registry, sampleUrl: 'https://' + registry + '.test/archive?private=redacted' });

function delay(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

function fixtures(metadata: Record<string, number> = {}, body: Record<string, number> = {}) {
  vi.useFakeTimers();
  const routes: Array<string | null> = [];
  const transport = vi.fn((actualEnv) => ({ fetch: vi.fn(async (url: string, init?: RequestInit) => {
    routes.push(installProxyRoute(actualEnv, url));
    const id = new URL(url).hostname.split('.')[0];
    await delay(body[id] ?? 100, init?.signal);
    return new Response(new Uint8Array(524288), { status: 206, headers: { 'content-range': 'bytes 524288-1048575/1048576' } });
  }) }));
  const resolve = vi.fn(async (_target, registry = 'official', signal?: AbortSignal) => {
    await delay(metadata[registry] ?? 1, signal);
    return release(registry);
  });
  return { dependencies: { transport, resolve, now: () => Date.now() }, routes, resolve, transport };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('operation-owned install source selection', () => {
  it('first install has no settings query/cache prerequisite; metadata-fast official loses to body-fast mirror through the same proxy', async () => {
    const f = fixtures({ official: 1, npmmirror: 200, huawei: 20 }, { official: 1500, npmmirror: 100, huawei: 600 });
    const pending = selectInstallSources({ target, source, env }, f.dependencies);
    await vi.advanceTimersByTimeAsync(2000);
    const selection = await pending;
    expect(selection.attempts.map((c) => c.registry)).toEqual(['npmmirror', 'huawei', 'official']);
    expect(selection.attempts[0].distribution).toMatchObject({ installVersion: '1.2.3-npmmirror', config: 'recipe-npmmirror' });
    expect(selection.report.sources.find((s) => s.registry === 'npmmirror')!.elapsedMs).toBe(100);
    expect(f.transport).toHaveBeenCalledWith(env);
    expect(f.routes).toEqual([env.HTTPS_PROXY + '/', env.HTTPS_PROXY + '/', env.HTTPS_PROXY + '/']);
    expect(JSON.stringify(selection.report)).not.toMatch(/private|archive|7897/);
  });

  it('has no absolute speed threshold; ranks two valid slow partial samples relatively', async () => {
    const f = fixtures();
    f.transport.mockImplementation(() => ({ fetch: vi.fn(async (_url, init) => {
      let timer: ReturnType<typeof setTimeout>;
      const id = new URL(_url).hostname.split('.')[0];
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(id === 'official' ? 65536 : 131072));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        timer = setTimeout(() => controller.close(), 10_000);
      }, cancel() { clearTimeout(timer); } });
      return new Response(stream, { status: 206, headers: { 'content-range': 'bytes 524288-1048575/1048576' } });
    }) }));
    const pending = selectInstallSources({ target, source: { ...source, registries: ['official', 'npmmirror'] }, env }, f.dependencies);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await pending).attempts[0].registry).toBe('npmmirror');
  });

  it('five-second metadata timeout aborts all probes and falls back in default order', async () => {
    const f = fixtures({ official: 20_000, npmmirror: 20_000, huawei: 20_000 });
    const pending = selectInstallSources({ target, source, env }, f.dependencies);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.report.reason).toBe('no-throughput-sample-use-default-order');
    expect(result.attempts.map((c) => c.registry)).toEqual(source.registries);
    expect(f.resolve.mock.calls.every((args) => args[2]!.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caller cancellation closes probes and propagates cancellation instead of installing a fallback', async () => {
    const f = fixtures({ official: 20_000, npmmirror: 20_000, huawei: 20_000 });
    const controller = new AbortController();
    const pending = selectInstallSources({ target, source, env, signal: controller.signal }, f.dependencies);
    const assertion = expect(pending).rejects.toThrow('stop');
    controller.abort(new Error('stop'));
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('definite missing is excluded including all-missing=%s; unknown remains eligible', async (allMissing) => {
    const f = fixtures();
    f.resolve.mockImplementation(async (_target, registry) => {
      if (allMissing || registry === 'official') throw new PlatformBuildMissingError('not published');
      throw new Error('network unknown');
    });
    const result = await selectInstallSources({ target, source, env }, f.dependencies);
    expect(result.attempts.map((c) => c.registry)).toEqual(allMissing ? [] : ['npmmirror', 'huawei']);
  });

  it('an update excludes a faster mirror that would downgrade the installed runtime', async () => {
    const f = fixtures();
    f.resolve.mockImplementation(async (_target, registry) => release(registry, registry === 'npmmirror' ? '1.0.0' : '1.2.3'));
    const pending = selectInstallSources({ target, source, env, minimumVersion: '1.1.0' }, f.dependencies);
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).attempts.map((c) => c.registry)).toEqual(['official', 'huawei']);
  });

  it.each(['explicit', 'single', 'acp-registry', 'vendor-manifest'])('%s does not compete unrelated sources', async (kind) => {
    const f = fixtures();
    const input = { target, source, env };
    if (kind === 'explicit') input.source = { kind: 'explicit', registry: 'huawei' } as never;
    if (kind === 'single') input.source = { ...source, registries: ['official'] };
    if (kind === 'acp-registry' || kind === 'vendor-manifest') input.target = { ...target, backend: { kind } } as never;
    const result = await selectInstallSources(input, f.dependencies);
    expect(result.attempts).toHaveLength(1);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('unsupported proxy routing never measures direct as a substitute', async () => {
    const f = fixtures();
    f.resolve.mockRejectedValue(new UnmeasurableInstallTransport('unsupported-no-proxy'));
    const result = await selectInstallSources({ target, source, env: { ...env, ALL_PROXY: 'socks5://127.0.0.1:9999' } }, f.dependencies);
    expect(result.report.sources.every((s) => s.status === 'unmeasurable')).toBe(true);
    expect(result.report.reason).toBe('no-throughput-sample-use-default-order');
  });
});

describe('bounded archive sampling', () => {
  it.each([200, 416])('status %s cancels the body without reading a full archive', async (status) => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new ReadableStream({ cancel }), { status }));
    await expect(sampleInstallArchive('https://artifact.test', fetcher, new AbortController().signal)).rejects.toThrow('unmeasurable-range');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Range: 'bytes=-524288', 'Accept-Encoding': 'identity' } });
  });
  it('rejects incorrect Content-Range and insufficient early EOF', async () => {
    const fetcher = async () => new Response(new Uint8Array(1), { status: 206, headers: { 'content-range': 'bytes 524288-1048575/1048576' } });
    await expect(sampleInstallArchive('https://artifact.test', fetcher, new AbortController().signal)).rejects.toThrow('insufficient-sample');
    await expect(sampleInstallArchive('https://artifact.test', async () => new Response('', { status: 206, headers: { 'content-range': 'bytes 0-9/10' } }), new AbortController().signal)).rejects.toThrow();
  });
  it('a complete small archive is a valid bounded sample', async () => {
    const result = await sampleInstallArchive('https://artifact.test', async () => new Response(new Uint8Array(100), { status: 206, headers: { 'content-range': 'bytes 0-99/100' } }), new AbortController().signal);
    expect(result.bytes).toBe(100);
  });
});
