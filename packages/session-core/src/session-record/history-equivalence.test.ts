import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRecordLocator, SessionTimeline } from './contract';
import { createSessionRecordSource, createSessionTimeline, type TimelineArchive } from './index';

/**
 * The history gate: every way a timeline is built from a record gives what one fold of the whole record gives.
 * - paging: the first screen, then older pages up to the top;
 * - growing: the record read while it grows, chunk by chunk (a running session), each moment equal to a fold of what
 *   was written so far;
 * - resuming: an archive taken at a cut, then the record grown and opened again from that archive.
 * Extra records (real ones, kept off the repo) come in through `HISTORY_GATE_RECORDS`: a JSON list of
 * `{ harness, providerSessionId, file }`.
 */

const disposers: Array<() => unknown> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

type Staged = { locator: SessionRecordLocator; file: string; lines: string[] };
type Layout = (root: string, id: string) => string;

const LAYOUT: Record<string, Layout> = {
  claude: (root, id) => join(root, 'project', `${id}.jsonl`),
  codex: (root, id) => join(root, '2026', '06', '18', `rollout-2026-06-18T07-03-21-${id}.jsonl`),
  qwen: (root, id) => join(root, '-Users-someone-proj', 'chats', `${id}.jsonl`),
  codebuddy: (root, id) => join(root, 'Users-someone-proj', `${id}.jsonl`),
  pi: (root, id) => join(root, '--work-proj--', `2026-08-28T06-16-23-489Z_${id}.jsonl`),
  copilot: (root, id) => join(root, id, 'events.jsonl'),
};

const FIXTURES: Array<{ harness: keyof typeof LAYOUT; fixture: string; id?: string }> = [
  { harness: 'claude', fixture: 'claude-session.jsonl' },
  { harness: 'claude', fixture: 'claude-rewound-session.jsonl' },
  { harness: 'claude', fixture: 'claude-revert-noresend.jsonl' },
  { harness: 'claude', fixture: 'claude-revert-resend.jsonl' },
  { harness: 'claude', fixture: 'claude-steered-session.jsonl' },
  { harness: 'claude', fixture: 'claude-final-fragments.jsonl' },
  { harness: 'codex', fixture: 'codex-rollout.jsonl', id: '019ed98a-a0ce-7f63-a9aa-04e0760a80c2' },
  { harness: 'codex', fixture: 'codex-steered-rollout.jsonl', id: '019ed98a-a0ce-7f63-a9aa-04e0760a80c3' },
  { harness: 'codex', fixture: 'codex-rolled-back.jsonl', id: '019ed98a-a0ce-7f63-a9aa-04e0760a80c4' },
  { harness: 'qwen', fixture: 'qwen-session.jsonl' },
  { harness: 'codebuddy', fixture: 'codebuddy-session.jsonl' },
  { harness: 'pi', fixture: 'pi-session-aborted.jsonl' },
  { harness: 'pi', fixture: 'pi-session-error.jsonl' },
  { harness: 'copilot', fixture: 'copilot-aborted.jsonl', id: 'b1e2c3d4-0000-4000-8000-00000000c0a1' },
  { harness: 'copilot', fixture: 'copilot-error.jsonl', id: 'b1e2c3d4-0000-4000-8000-00000000c0a2' },
  { harness: 'copilot', fixture: 'copilot-subagent.jsonl', id: 'b1e2c3d4-0000-4000-8000-00000000c0a3' },
];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'history-gate-'));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The record's own session id: the file's for Claude, Qwen and CodeBuddy, the header's for Pi. */
function idOf(harness: string, lines: string[], given?: string): string {
  if (given) return given;
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>;
    const id = harness === 'pi' ? record.id : record.sessionId;
    if (typeof id === 'string') return id;
  }
  throw new Error(`no session id in the ${harness} fixture`);
}

async function stage(harness: string, lines: string[], id: string, upTo = lines.length): Promise<Staged> {
  const root = await temp();
  const file = LAYOUT[harness]!(root, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.slice(0, upTo).map((line) => `${line}\n`).join(''));
  return { locator: { harness: harness as SessionRecordLocator['harness'], providerSessionId: id, roots: [root] }, file, lines };
}

async function open(locator: SessionRecordLocator, archive: TimelineArchive | null = null): Promise<SessionTimeline> {
  const timeline = await createSessionTimeline(createSessionRecordSource(locator), { sessionId: 'gate', archive });
  disposers.push(() => timeline.dispose());
  return timeline;
}

/** What a fold of the whole record shows. Images go by count: an archive carries them as refs (`toolImage`). */
function shown(timeline: SessionTimeline) {
  const { cursor: _cursor, ...rest } = timeline.getSnapshot({ limit: 1e9 });
  return normalize(rest);
}
function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, field: unknown) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return field;
    const { images, imageRefs, ...rest } = field as { images?: unknown[]; imageRefs?: unknown[] };
    const count = (images?.length ?? 0) + (imageRefs?.length ?? 0);
    return images || imageRefs ? { ...rest, images: count } : field;
  })) as T;
}

async function folded(harness: string, lines: string[], id: string, upTo = lines.length) {
  const { locator } = await stage(harness, lines, id, upTo);
  const timeline = await open(locator);
  const view = shown(timeline);
  timeline.dispose();
  return view;
}

/** Cut points that land on line starts: a third and two thirds in, and one line before the end. */
const cutsOf = (lines: string[]) => [...new Set([Math.floor(lines.length / 3), Math.floor((2 * lines.length) / 3), lines.length - 1])]
  .filter((cut) => cut > 0 && cut < lines.length);

async function checkPaging(staged: Staged, whole: ReturnType<typeof shown>) {
  const timeline = await open(staged.locator);
  const first = timeline.getSnapshot({ limit: 3 });
  const pages = [first.turns];
  let hasOlder = first.hasOlder;
  while (hasOlder) {
    const page = timeline.getOlder({ beforeTurnId: pages[0]![0]!.id, limit: 3 });
    pages.unshift(page.turns);
    hasOlder = page.hasOlder;
  }
  expect(normalize(pages.flat())).toEqual(whole.turns);
}

async function checkGrowing(harness: string, lines: string[], id: string) {
  const cut = Math.max(1, Math.floor(lines.length / 4));
  const staged = await stage(harness, lines, id, cut);
  const timeline = await open(staged.locator);
  const step = Math.max(1, Math.ceil((lines.length - cut) / 4));
  for (let at = cut; at < lines.length;) {
    const next = Math.min(lines.length, at + step);
    await appendFile(staged.file, lines.slice(at, next).map((line) => `${line}\n`).join(''));
    at = next;
    await timeline.catchUp();
    expect(shown(timeline), `after line ${at}`).toEqual(await folded(harness, lines, id, at));
  }
}

async function checkResuming(harness: string, lines: string[], id: string, whole: ReturnType<typeof shown>) {
  for (const cut of cutsOf(lines)) {
    const staged = await stage(harness, lines, id, cut);
    const before = await open(staged.locator);
    const archive = await before.archive?.() ?? null;
    before.dispose();
    await appendFile(staged.file, lines.slice(cut).map((line) => `${line}\n`).join(''));
    const after = await open(staged.locator, archive);
    expect(shown(after), `archive at line ${cut}`).toEqual(whole);
  }
}

async function fixtureLines(name: string): Promise<string[]> {
  const text = await readFile(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
  return text.split('\n').filter((line) => line.trim());
}

describe('history gate: every way to build a timeline equals one fold of the record', () => {
  for (const { harness, fixture, id: given } of FIXTURES) {
    describe(`${harness} ${fixture}`, () => {
      it('paging to the top', async () => {
        const lines = await fixtureLines(fixture);
        const id = idOf(harness, lines, given);
        const staged = await stage(harness, lines, id);
        await checkPaging(staged, await folded(harness, lines, id));
      });
      it('growing, at every chunk', async () => {
        const lines = await fixtureLines(fixture);
        await checkGrowing(harness, lines, idOf(harness, lines, given));
      });
      it('resuming from an archive', async () => {
        const lines = await fixtureLines(fixture);
        const id = idOf(harness, lines, given);
        await checkResuming(harness, lines, id, await folded(harness, lines, id));
      });
    });
  }

  const extra = JSON.parse(process.env.HISTORY_GATE_RECORDS ?? '[]') as Array<{ harness: string; providerSessionId: string; file: string }>;
  for (const record of extra) {
    it(`real record: ${record.harness} ${record.providerSessionId.slice(0, 8)}`, async () => {
      const lines = (await readFile(record.file, 'utf8')).split('\n').filter((line) => line.trim());
      const whole = await folded(record.harness, lines, record.providerSessionId);
      await checkPaging(await stage(record.harness, lines, record.providerSessionId), whole);
      await checkResuming(record.harness, lines, record.providerSessionId, whole);
      await checkGrowing(record.harness, lines, record.providerSessionId);
    }, 600_000);
  }
});
