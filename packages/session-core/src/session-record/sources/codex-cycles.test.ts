import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { RecordEntry } from '../contract';
import { createCodexJsonlSource } from './codex-jsonl';
import { TailReader } from './tail-reader';

const cases: Array<{ name: string; edges: Record<string, string[]>; reads: number }> = [
  { name: 'self reference', edges: { root: ['root'] }, reads: 1 },
  { name: 'parent-child cycle', edges: { root: ['child'], child: ['root'] }, reads: 2 },
  { name: 'three-record cycle', edges: { root: ['child'], child: ['leaf'], leaf: ['root'] }, reads: 3 },
  { name: 'shared descendant on independent branches', edges: { root: ['left', 'right'], left: ['leaf'], right: ['leaf'], leaf: [] }, reads: 5 },
];

it.each(cases)('bounds $name and preserves readable child replies', async ({ edges, reads }) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-cycle-'));
  const entries: RecordEntry[] = [];
  let opened = 0;
  const read = TailReader.prototype.readFromStart;
  const spy = vi.spyOn(TailReader.prototype, 'readFromStart').mockImplementation(function (this: TailReader, sink) {
    // Fail before a regression can exhaust the test runner's memory or file descriptors.
    if (++opened > reads) throw new Error('Native history revisited an ancestor');
    return read.call(this, sink);
  });
  const source = createCodexJsonlSource({ harness: 'codex', providerSessionId: 'root', roots: [dir] }, { readMode: 'snapshot' });
  try {
    await mkdir(dir, { recursive: true });
    for (const [id, children] of Object.entries(edges)) {
      const rows = children.map(child => ({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'SubAgentActivity', id: `call-${id}-${child}`, agent_thread_id: child, agent_path: `/root/${child}`, kind: 'completed',
      } } }));
      const reply = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply-${id}` }] } };
      await writeFile(join(dir, `rollout-fixture-${id}.jsonl`), [...rows, reply].map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    await source.start({ onEntries(batch) { entries.push(...batch); }, onReset() {} });
    expect(opened).toBe(reads);
    for (const id of Object.keys(edges)) expect(JSON.stringify(entries)).toContain(`reply-${id}`);
    await source.catchUp?.();
  } finally {
    source.stop();
    spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
