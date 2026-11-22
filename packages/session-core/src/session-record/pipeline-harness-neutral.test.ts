import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { SessionRecordHarness } from './contract';

/**
 * Downstream of the adapters, the pipeline is one path for every harness: the record tree, the tail reader and the
 * timeline (fold, pages, archive) and the reducer never ask which harness wrote a line. Adding a harness adds an
 * adapter under `sources/` and a case in `index.ts`, and changes nothing here.
 */
const HARNESSES: Record<SessionRecordHarness, true> = { claude: true, codex: true, opencode: true, copilot: true, hermes: true, qwen: true, pi: true, codebuddy: true, gugu: true };
const PIPELINE = ['./timeline.ts', './journal-turns.ts', './runtime-turn.ts', './sources/record-tree.ts', './sources/jsonl-tail-source.ts', './sources/tail-reader.ts'];
const REDUCER = '../acp/reducer/';

it('no module downstream of the adapters branches on a harness', async () => {
  const reducer = (await readdir(fileURLToPath(new URL(REDUCER, import.meta.url)))).filter((name) => name.endsWith('.ts') && !name.includes('.test.'));
  const files = [...PIPELINE, ...reducer.map((name) => REDUCER + name)];
  const named = new RegExp(`['"\`](${Object.keys(HARNESSES).join('|')})['"\`]|\\.harness\\b|\\bharness\\s*[!=]==`);
  const hits: string[] = [];
  for (const file of files) {
    const lines = (await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).split('\n');
    lines.forEach((line, index) => { if (named.test(line.replace(/\/\/.*$|^\s*\*.*$/, ''))) hits.push(`${file}:${index + 1}`); });
  }
  expect(hits).toEqual([]);
});
