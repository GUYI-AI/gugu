import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAcceptanceCommitObserver } from '../../packages/session-runtime/src/acp-agents/node/acceptance-commit-observer.ts';

const pin = '5ce3a6bfa76c47d3be66c3062db9a70cb6f49711';
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'commit-observe-'));
  const ready = Promise.withResolvers(), errors = [];
  const observer = createAcceptanceCommitObserver({ GUGU_COMMIT_OBSERVE_DIR: directory, GUGU_COMMIT_OBSERVE_SOURCE_PIN: pin }, error => errors.push(error), ready.resolve);
  try {
    const file = await ready.promise, endpoint = JSON.parse(await readFile(file, 'utf8'));
    const call = async (path, method = 'POST', token = endpoint.token) => {
      const response = await fetch(endpoint.url + path, { method, headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, value: await response.json() };
    };
    await run({ observer, directory, endpoint, file, call, errors });
  } finally { observer.close(); await rm(directory, { recursive: true, force: true }); }
}
test('disabled observer creates no runtime or output', () => {
  assert.equal(createAcceptanceCommitObserver({}, () => {}), undefined);
});
test('separate worker monotonic stamps lie within the same host parent interval', async () => {
  const before = process.hrtime.bigint();
  const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(process.hrtime.bigint().toString())']);
  const after = process.hrtime.bigint(), stamp = BigInt(child.stdout);
  assert.ok(stamp >= before && stamp <= after);
});
test('actual loopback control retains only metadata and writes once after stop, including empty-window bounds', async () => {
  await fixture(async ({ observer, directory, file, call, errors }) => {
    assert.equal((await call('/start?case=tools', 'POST', 'wrong')).status, 403);
    observer.record({ sessionId: 'outside', providerId: 'codex', source: 'live' });
    const start = await call('/start?case=tools'); assert.equal(start.status, 200);
    assert.equal((await call('/start?case=tools')).status, 409);
    const event = { sessionId: 'A', providerId: 'codex', source: 'live', turn: { text: 'SECRET BODY' } };
    observer.record(event); event.sessionId = 'mutated';
    observer.record({ sessionId: 'A', providerId: 'codex', source: 'revision' });
    observer.record({ sessionId: 'B', providerId: 'claude', source: 'backfill' });
    observer.record({ sessionId: 'B', providerId: 'claude', source: 'replay' });
    assert.equal((await readdir(directory)).length, 1);
    const end = (await call('/stop')).value, raw = JSON.parse(await readFile(end.file, 'utf8'));
    assert.equal(raw.complete, true); assert.equal(raw.events.length, 3); assert.equal(raw.excludedReplay, 1);
    assert.equal(JSON.stringify(raw).includes('SECRET BODY'), false); assert.equal(raw.events[0].sessionId, 'A');
    for (const row of raw.events) {
      assert.deepEqual(Object.keys(row), ['sessionId', 'provider', 'source', 'monoNs']);
      assert.ok(BigInt(row.monoNs) >= BigInt(raw.startMonoNs) && BigInt(row.monoNs) <= BigInt(raw.endMonoNs));
    }
    assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(end.file)).mode & 0o777, 0o600);
    assert.equal((await call('/stop')).status, 409);
    await call('/start?case=normal'); const empty = (await call('/stop')).value;
    const zero = JSON.parse(await readFile(empty.file, 'utf8'));
    assert.equal(zero.events.length, 0); assert.ok(BigInt(zero.endMonoNs) >= BigInt(zero.startMonoNs));
    assert.deepEqual(errors, []);
  });
});
test('worker close exports an incomplete capture rather than a successful observation', async () => {
  await fixture(async ({ observer, directory, call }) => {
    await call('/start?case=background'); observer.record({ sessionId: 'A', source: 'live' }); observer.close();
    const [file] = await readdir(directory), raw = JSON.parse(await readFile(join(directory, file), 'utf8'));
    assert.equal(raw.complete, false); assert.equal(raw.reason, 'worker_closed'); assert.equal(raw.events[0].provider, null);
  });
});
test('the shipped control command starts and stops the real observer', async () => {
  await fixture(async ({ observer, file }) => {
    const command = fileURLToPath(new URL('./control-turn-commit-observer.mjs', import.meta.url));
    const call = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [command, ...args])).stdout);
    assert.equal((await call('start', file, 'normal')).active.count, 0);
    observer.record({ sessionId: 'C', providerId: 'claude', source: 'live' });
    const stopped = await call('stop', file); assert.equal(stopped.count, 1); assert.equal(stopped.complete, true);
    assert.equal((await call('status', file)).active, null);
  });
});
