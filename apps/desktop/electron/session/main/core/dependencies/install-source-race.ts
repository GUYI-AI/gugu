import semver from 'semver';
import { DEFAULT_NPM_REGISTRY_ID } from '@gugu/session-core/deps';
import type { InstallSourceIntent } from '@gugu/session-core/deps/runtime';
import { anySignal } from '@gugu/core/shared/anySignal';
import { PlatformBuildMissingError, resolveMiseDistribution, type MiseDistribution, type MiseTarget } from './mise-distribution';
import { createInstallTransport, UnmeasurableInstallTransport, type InstallFetch } from './install-source-transport';

const SELECTION_MS = 5_000;
const BODY_MS = 2_000;
const SAMPLE_BYTES = 512 * 1024;
const MIN_BYTES = 64 * 1024;

type SourceFact = {
  registry: string;
  status: 'measured' | 'unknown' | 'missing' | 'older-version' | 'unmeasurable';
  version?: string;
  bytes?: number;
  elapsedMs?: number;
  bytesPerSecond?: number;
};
export type InstallSourceCandidate = { registry?: string; distribution?: MiseDistribution };
export type InstallSourceSelection = {
  attempts: InstallSourceCandidate[];
  report: { reason: string; selected: string | null; sources: SourceFact[] };
};
type Input = { target: MiseTarget; source?: InstallSourceIntent; env: NodeJS.ProcessEnv; signal?: AbortSignal; minimumVersion?: string };
type Dependencies = {
  resolve: typeof resolveMiseDistribution;
  transport: typeof createInstallTransport;
  now: () => number;
};

/** The original source race stays the one owner of concurrent probes and stable ranking. */
export type InstallSourceProbe = SourceFact & { order: number };

export function rankInstallSources(probes: readonly InstallSourceProbe[], fallback?: string): string[] {
  const usable = probes.filter((probe) => probe.status !== 'missing' && probe.status !== 'older-version');
  const measured = usable.filter((probe) => probe.status === 'measured');
  const silent = usable.filter((probe) => probe.status !== 'measured');
  return [
    ...measured.sort((a, b) => b.bytesPerSecond! - a.bytesPerSecond! || a.order - b.order),
    ...silent.sort((a, b) => (measured.length ? 0 : Number(b.registry === fallback) - Number(a.registry === fallback)) || a.order - b.order),
  ].map((probe) => probe.registry);
}

/** Concurrent as before; the callback now supplies actual archive bytes/time, not metadata latency. */
export async function probeInstallSources<T extends SourceFact>(registries: readonly string[], probe: (registry: string) => Promise<T>): Promise<Array<T & { order: number }>> {
  return Promise.all(registries.map(async (registry, order) => ({ ...await probe(registry), order })));
}

/** One bounded sample of the exact artifact in the selected release recipe, not its metadata. */
export async function sampleInstallArchive(url: string, fetcher: InstallFetch, signal: AbortSignal, now = () => performance.now()) {
  const started = now();
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop.abort(); }, BODY_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bytes = 0;
  let expected = 0;
  let finished = false;
  try {
    const response = await fetcher(url, {
      headers: { Range: 'bytes=-' + SAMPLE_BYTES, 'Accept-Encoding': 'identity' },
      signal: anySignal([signal, stop.signal]),
    });
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const [start, end, total] = range?.slice(1).map(Number) ?? [];
    const valid = response.status === 206 && [start, end, total].every(Number.isSafeInteger)
      && total > 0 && start === Math.max(0, total - SAMPLE_BYTES) && end === total - 1
      && [null, 'identity'].includes(response.headers.get('content-encoding'));
    if (!valid || !response.body) {
      await response.body?.cancel();
      throw new Error('unmeasurable-range');
    }
    expected = end - start + 1;
    reader = response.body.getReader();
    while (bytes < expected) {
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      if (chunk.value.byteLength > expected - bytes) throw new Error('oversized-range');
      bytes += chunk.value.byteLength;
    }
    finished ||= bytes === expected;
  } catch (error) {
    signal.throwIfAborted();
    if (!timedOut || bytes === 0) throw error;
  } finally {
    clearTimeout(timer);
    stop.abort();
    await reader?.cancel().catch(() => {});
  }
  const elapsedMs = Math.max(1, now() - started);
  if ((!finished && !timedOut) || bytes < Math.min(MIN_BYTES, expected)) throw new Error('insufficient-sample');
  return { bytes, elapsedMs, bytesPerSecond: bytes * 1000 / elapsedMs };
}

/** No process/UI cache. Every automatic install and update owns one selection and its cancellation. */
export async function selectInstallSources(input: Input, dependencies: Partial<Dependencies> = {}): Promise<InstallSourceSelection> {
  input.signal?.throwIfAborted();
  const source = input.source;
  const single = (registry: string | undefined, reason: string): InstallSourceSelection => ({
    attempts: [{ registry }], report: { selected: registry ?? null, reason, sources: [] },
  });
  if (input.target.backend.kind !== 'npm' && input.target.backend.kind !== 'platform-archive') return single(undefined, 'single-origin');
  if (source?.kind === 'explicit') return single(source.registry, 'explicit-source');
  const fallback = source?.fallbackRegistry ?? DEFAULT_NPM_REGISTRY_ID;
  const registries = [...new Set(source?.registries.length ? source.registries : [fallback])].slice(0, 3);
  if (registries.length < 2) return single(registries[0], 'single-source');
  const resolve = dependencies.resolve ?? resolveMiseDistribution;
  const now = dependencies.now ?? (() => performance.now());
  const transport = (dependencies.transport ?? createInstallTransport)(input.env);
  const timeout = new AbortController();
  const signal = anySignal([input.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), SELECTION_MS);
  const distributions = new Map<string, MiseDistribution>();
  let sources: InstallSourceProbe[];
  try {
    sources = await probeInstallSources(registries, async (registry): Promise<SourceFact> => {
      let distribution: MiseDistribution | undefined;
      try {
        distribution = await resolve(input.target, registry, signal, process.platform, process.arch, undefined, transport.fetch);
        signal.throwIfAborted();
        if (input.minimumVersion && semver.valid(input.minimumVersion) && semver.lt(distribution.version, input.minimumVersion)) {
          return { registry, version: distribution.version, status: 'older-version' };
        }
        distributions.set(registry, distribution);
        if (!distribution.sampleUrl) return { registry, version: distribution.version, status: 'unmeasurable' };
        const sample = await sampleInstallArchive(distribution.sampleUrl, transport.fetch, signal, now);
        return { registry, version: distribution.version, status: 'measured', ...sample };
      } catch (error) {
        return { registry, ...(distribution ? { version: distribution.version } : {}),
          status: error instanceof PlatformBuildMissingError ? 'missing'
            : error instanceof UnmeasurableInstallTransport ? 'unmeasurable' : 'unknown' };
      }
    });
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
  input.signal?.throwIfAborted();
  const order = rankInstallSources(sources, fallback);
  const measured = sources.some((fact) => fact.status === 'measured');
  return {
    attempts: order.map((registry) => ({ registry, distribution: distributions.get(registry) })),
    // Only allowlisted ids, version and numeric readings. No URLs, proxy values or raw errors.
    report: { reason: measured ? 'highest-observed-throughput' : order.length ? 'no-throughput-sample-use-default-order' : 'no-compatible-platform-release',
      selected: order[0] ?? null, sources },
  };
}
