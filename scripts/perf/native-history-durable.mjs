import assert from 'node:assert/strict';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export function quantiles(values) {
  assert(values.length && values.every(x => Number.isFinite(x) && x >= 0), 'Invalid samples');
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}

/** Adapter must invoke the real writer and report milestones AFTER its actual durable barriers. */
export async function measureWrites({ adapter, directory, mode, count = 100, warmup = 10, payloadBytes = 4096,
  expectedCanonicalRows = count + warmup, expectedDurableProjections = expectedCanonicalRows }) {
  assert(['before', 'after'].includes(mode));
  for (const n of [count, payloadBytes]) assert(Number.isSafeInteger(n) && n > 0);
  assert(Number.isSafeInteger(warmup) && warmup >= 0);
  assert(Number.isSafeInteger(expectedCanonicalRows) && expectedCanonicalRows > 0);
  assert(Number.isSafeInteger(expectedDurableProjections) && expectedDurableProjections > 0);
  assert(count + warmup <= 10000 && (count + warmup) * payloadBytes <= 1024 ** 3, 'Measurement case exceeds its explicit sample/input budget');
  await mkdir(directory); // Never reuse a database or silently remove existing evidence.
  const raw = await open(resolve(directory, 'writes.jsonl'), 'wx');
  let context;
  const samples = [];
  try {
    context = await adapter.open({ directory, mode });
    const meta = await context.metadata();
    assert.match(meta.sourceSha, /^[a-f0-9]{40}$/);
    assert(meta.writerEntry && meta.databasePath !== ':memory:');
    assert((await stat(meta.databasePath)).isFile(), 'A real disk database is required');
    assert.equal(meta.additionsEnabled, mode === 'after');
    assert.equal(meta.sqlite.journalMode.toLowerCase(), 'wal');
    assert([1, 2, 3].includes(meta.sqlite.synchronous), 'Do not benchmark with synchronous=OFF');
    await writeFile(resolve(directory, 'metadata.json'), JSON.stringify(meta, null, 2));
    for (let i = -warmup; i < count; i++) {
      const phases = [];
      const input = { index: i, text: 'x'.repeat(payloadBytes) };
      const started = performance.now();
      const mark = name => {
        assert(phases.length < 4, 'Too many stage callbacks');
        phases.push({ name, ms: performance.now() - started });
      };
      try {
        const result = await context.commit(input, mark);
        const elapsedMs = performance.now() - started;
        const identity = context.identity ? await context.identity(input, result) : result;
        assert(identity.rowId, 'Missing actual canonical row identity');
        if (mode === 'after') {
          assert(identity.receiptId && identity.projectionRef, 'Full durable path is not connected');
          assert.deepEqual(phases.map(x => x.name), ['source_durable', 'canonical_committed', 'projection_durable', 'ackable']);
        }
        assert(phases.every(x => Number.isFinite(x.ms) && x.ms >= 0 && x.ms <= elapsedMs));
        const sample = { mode, index: i, warmup: i < 0, payloadBytes, elapsedMs, phases, rowId: identity.rowId };
        await raw.write(`${JSON.stringify(sample)}\n`);
        if (i >= 0) samples.push(sample);
      } catch (error) {
        await raw.write(`${JSON.stringify({ mode, index: i, phases, elapsedThroughFailureMs: performance.now() - started, error: String(error) })}\n`);
        throw error;
      }
    }
    // Reopen/point-read actual rows and receipts; no generated assertion substitutes for readback.
    const verified = await context.verify();
    assert.equal(verified.canonicalRows, expectedCanonicalRows);
    if (mode === 'after') assert.equal(verified.durableProjections, expectedDurableProjections);
    const summary = { mode, meta, payloadBytes, count, warmup, expectedCanonicalRows, expectedDurableProjections,
      latency: quantiles(samples.map(x => x.elapsedMs)), verified };
    await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    return { summary, samples };
  } catch (error) {
    await writeFile(resolve(directory, 'failed.json'), JSON.stringify({ mode, completedSamples: samples.length, error: String(error) }, null, 2));
    throw error;
  } finally {
    try { await context?.close(); } finally { await raw.sync(); await raw.close(); }
  }
}

export function compareWrites(before, after) {
  assert.equal(before.summary.mode, 'before'); assert.equal(after.summary.mode, 'after');
  for (const key of ['payloadBytes', 'count', 'warmup', 'expectedCanonicalRows']) assert.equal(before.summary[key], after.summary[key]);
  assert.deepEqual(before.summary.meta.sqlite, after.summary.meta.sqlite, 'SQLite fsync configuration differs');
  assert.equal(before.samples.length, before.summary.count);
  assert.equal(after.samples.length, after.summary.count);
  const deltas = after.samples.map((sample, i) => {
    assert.equal(sample.index, before.samples[i].index);
    return sample.elapsedMs - before.samples[i].elapsedMs;
  }).sort((a, b) => a - b);
  assert(deltas.length && deltas.every(Number.isFinite));
  return { before: before.summary.latency, after: after.summary.latency,
    p50DifferenceMs: after.summary.latency.p50Ms - before.summary.latency.p50Ms,
    p95DifferenceMs: after.summary.latency.p95Ms - before.summary.latency.p95Ms,
    pairedDeltaP50Ms: deltas[Math.ceil(deltas.length * 0.5) - 1],
    pairedDeltaP95Ms: deltas[Math.ceil(deltas.length * 0.95) - 1] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--compare') {
    assert.equal(process.argv.length, 6, 'Usage: --compare BEFORE_DIRECTORY AFTER_DIRECTORY NEW_RESULT_FILE');
    const load = async directory => {
      const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'));
      const rows = (await readFile(resolve(directory, 'writes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert(rows.every(row => !row.error), 'Failed samples cannot be filtered out');
      return { summary, samples: rows.filter(row => row.warmup === false) };
    };
    const result = compareWrites(await load(process.argv[3]), await load(process.argv[4]));
    await writeFile(process.argv[5], JSON.stringify(result, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (i % 2 === 0) { assert(value.startsWith('--') && all[i + 1], 'Expected --key value'); pairs.push([value.slice(2), all[i + 1]]); }
    return pairs;
  }, []));
  const adapter = await import(pathToFileURL(resolve(args.adapter)).href);
  const result = await measureWrites({ adapter, directory: resolve(args.output), mode: args.mode,
    count: Number(args.count ?? 100), warmup: Number(args.warmup ?? 10), payloadBytes: Number(args.bytes ?? 4096),
    ...(args.rows ? { expectedCanonicalRows: Number(args.rows) } : {}),
    ...(args.projections ? { expectedDurableProjections: Number(args.projections) } : {}) });
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  }
}
