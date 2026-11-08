// Acceptance-only instrumentation. This file and its boot hook must not merge into a product branch.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

type Metadata = { sessionId: string; providerId?: string; source: 'live' | 'revision' | 'backfill' | 'replay' };
type Row = { sessionId: string; provider: string | null; source: Exclude<Metadata['source'], 'replay'>; monoNs: string };
type Capture = { id: string; label: string; startMonoNs: string; events: Row[]; excludedReplay: number; overflow: number };
const limit = 500_000;

/** No event-time file writes, timers, turn retention, subscriptions or runtime calls. */
export function createAcceptanceCommitObserver(env: NodeJS.ProcessEnv, report: (error: unknown) => void,
  ready: (endpointFile: string) => void = () => {}) {
  const directory = env.GUGU_COMMIT_OBSERVE_DIR;
  if (!directory) return undefined;
  const sourcePin = env.GUGU_COMMIT_OBSERVE_SOURCE_PIN;
  if (!isAbsolute(directory) || !sourcePin || !/^[a-f0-9]{40}$/.test(sourcePin))
    throw new Error('Acceptance observer requires an absolute output directory and exact source pin');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workerId = randomUUID(), token = randomUUID(), endpointFile = join(directory, `worker-${process.pid}-${workerId}.json`);
  let capture: Capture | undefined, closed = false;
  const diagnostics = (error: unknown) => { try { report(error); } catch { /* Observation must not change runtime outcomes. */ } };
  const status = () => ({ workerId, pid: process.pid, sourcePin, clock: 'process.hrtime.bigint',
    active: capture ? { id: capture.id, label: capture.label, startMonoNs: capture.startMonoNs,
      count: capture.events.length, excludedReplay: capture.excludedReplay, overflow: capture.overflow } : null });
  const stop = (reason: string) => {
    if (!capture) throw new Error('No observation is active');
    const selected = capture, endMonoNs = process.hrtime.bigint().toString();
    const file = join(directory, `capture-${selected.id}.json`);
    // Exactly one raw write, after the observation interval. Keep the capture on I/O failure.
    writeFileSync(file, JSON.stringify({ version: 1, ...status(), ...selected, endMonoNs,
      complete: reason === 'stop' && selected.overflow === 0, reason }), { flag: 'wx', mode: 0o600 });
    capture = undefined;
    return { file, id: selected.id, startMonoNs: selected.startMonoNs, endMonoNs,
      count: selected.events.length, complete: reason === 'stop' && selected.overflow === 0 };
  };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end('{}'); return; }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let result: unknown;
      if (request.method === 'GET' && url.pathname === '/status') result = status();
      else if (request.method === 'POST' && url.pathname === '/start') {
        const label = url.searchParams.get('case');
        if (closed || capture || !label || !['normal', 'tools', 'background'].includes(label))
          throw new Error('Expected an idle observer and case=normal|tools|background');
        capture = { id: randomUUID(), label, startMonoNs: process.hrtime.bigint().toString(), events: [], excludedReplay: 0, overflow: 0 };
        result = status();
      } else if (request.method === 'POST' && url.pathname === '/stop') result = stop('stop');
      else { response.writeHead(404).end('{}'); return; }
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(409).end(JSON.stringify({ error: String(error) })); }
  });
  server.on('error', diagnostics);
  server.listen(0, '127.0.0.1', () => {
    if (closed) return;
    const address = server.address();
    if (!address || typeof address === 'string') { diagnostics(new Error('Missing observer address')); return; }
    try {
      writeFileSync(endpointFile, JSON.stringify({ version: 1, workerId, pid: process.pid, sourcePin,
        url: `http://127.0.0.1:${address.port}`, token }), { flag: 'wx', mode: 0o600 }); ready(endpointFile);
    } catch (error) { diagnostics(error); server.close(); }
  });
  server.unref();
  return {
    record(event: Metadata): void {
      const selected = capture; if (!selected || closed) return;
      if (event.source === 'replay') { selected.excludedReplay++; return; }
      if (selected.events.length >= limit) { selected.overflow++; return; }
      selected.events.push({ sessionId: event.sessionId, provider: event.providerId ?? null,
        source: event.source, monoNs: process.hrtime.bigint().toString() });
    },
    close(): void {
      if (closed) return; closed = true;
      try { if (capture) stop('worker_closed'); } catch (error) { diagnostics(error); }
      server.close(); server.closeIdleConnections();
      try { rmSync(endpointFile, { force: true }); } catch (error) { diagnostics(error); }
    },
  };
}
