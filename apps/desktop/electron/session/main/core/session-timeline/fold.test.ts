import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionRecordSource, createSessionTimeline, type SessionRecordLocator, type SessionTimeline } from '@gugu/session-core/session-record';
import { foldRecord } from './fold';

const FIXTURE = fileURLToPath(new URL('../../../../../../../packages/session-core/src/session-record/__fixtures__/claude-session.jsonl', import.meta.url));
const SESSION_ID = 'f1b2c3d4-0000-4000-8000-000000000001';
const disposers: Array<() => unknown> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });

async function stage() {
  const root = await mkdtemp(join(tmpdir(), 'fold-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '-work-repo'));
  const record = join(root, '-work-repo', `${SESSION_ID}.jsonl`);
  await writeFile(record, await readFile(FIXTURE, 'utf8'));
  const locator: SessionRecordLocator = { harness: 'claude', providerSessionId: SESSION_ID, roots: [root] };
  return { record, locator, checkpoint: join(root, 'archive', 'session.json') };
}

const open = async (locator: SessionRecordLocator, archive: Awaited<ReturnType<typeof foldRecord>>['archive'] = null) => {
  const timeline = await createSessionTimeline(createSessionRecordSource(locator), { sessionId: 'session', archive });
  disposers.push(() => timeline.dispose());
  return timeline;
};
const shown = (timeline: SessionTimeline) => {
  const { cursor: _cursor, ...rest } = timeline.getSnapshot({ limit: 1e6 });
  return rest;
};
const userLine = (parentUuid: string) => JSON.stringify({
  type: 'user', uuid: 'f1b2c3d4-0000-4000-8000-0000000000ff', parentUuid, sessionId: SESSION_ID, isSidechain: false,
  timestamp: '2026-11-21T00:00:00.000Z', message: { role: 'user', content: 'one more' },
});

describe('fold off the main thread', () => {
  it('the archive it hands over restores the timeline a fold on the main thread gives', async () => {
    const { locator, checkpoint } = await stage();
    const { archive } = await foldRecord({ locator, sessionId: 'session', checkpoint });
    expect(archive?.parser.transcript.committed.length).toBeGreaterThan(0);
    expect(shown(await open(locator, archive))).toEqual(shown(await open(locator)));
  });

  it('writes the archive as the checkpoint, rewrites it only after the record grew, and goes on from it', async () => {
    const { record, locator, checkpoint } = await stage();
    await (await foldRecord({ locator, sessionId: 'session', checkpoint })).write();
    const written = await stat(checkpoint);
    await (await foldRecord({ locator, sessionId: 'session', checkpoint })).write();
    expect((await stat(checkpoint)).mtimeMs).toBe(written.mtimeMs);

    const lines = (await readFile(record, 'utf8')).trim().split('\n');
    await appendFile(record, userLine(JSON.parse(lines.at(-1)!).uuid) + '\n');
    const grown = await foldRecord({ locator, sessionId: 'session', checkpoint });
    await grown.write();
    expect(JSON.parse(await readFile(checkpoint, 'utf8')).sourceBytes).toBe((await stat(record)).size);
    const restored = shown(await open(locator, grown.archive));
    expect(restored).toEqual(shown(await open(locator)));
    expect(JSON.stringify(restored)).toContain('one more');
  });

  it('removes a checkpoint that does not parse and reads the record whole', async () => {
    const { locator, checkpoint } = await stage();
    await mkdir(join(checkpoint, '..'), { recursive: true });
    await writeFile(checkpoint, '{"epoch":');
    const { archive } = await foldRecord({ locator, sessionId: 'session', checkpoint });
    await expect(stat(checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(shown(await open(locator, archive))).toEqual(shown(await open(locator)));
  });
});
