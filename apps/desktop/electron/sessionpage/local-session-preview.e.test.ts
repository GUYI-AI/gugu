import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { transcriptPrefixMetadata } from './transcript-prefix-metadata';
import { readBoundedLocalSessionPreview } from './local-session-preview';

const io = vi.hoisted(() => ({ reads: [] as Array<{ position: number; length: number }> }));
vi.mock('@gugu/session-core/session-record/window-cache/file-source', async (original) => {
  const actual = await original<typeof import('../../../../../../packages/session-core/src/session-record/window-cache/file-source')>();
  return { ...actual, async openWindowByteSource(path: string) {
    const source = await actual.openWindowByteSource(path);
    return { ...source, async read(target: Uint8Array, offset: number, length: number, position: number) {
      io.reads.push({ position, length }); return source.read(target, offset, length, position);
    } };
  } };
});

const directories: string[] = [];
afterEach(async () => { io.reads.length = 0; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-import-preview-')); directories.push(root);
  const records = join(root, 'native', 'projects'); await mkdir(records, { recursive: true });
  const path = join(records, 'session.jsonl'); await writeFile(path, text);
  return { root, path, options: { nativeHomes: { 'claude-code': [join(root, 'native')], codex: [join(root, 'native')] } } };
}

it('reads metadata ahead of an unfinished giant JSON string without trusting nested body text', () => {
  expect(transcriptPrefixMetadata('{"type":"session_meta","payload":{"id":"native-id","cwd":"/work","base_instructions":"unfinished', 'codex'))
    .toEqual({ providerSessionId: 'native-id', cwd: '/work' });
  expect(transcriptPrefixMetadata(JSON.stringify({ message: { text: '"sessionId":"fake"' }, sessionId: 'real', cwd: '/work' }), 'claude-code'))
    .toEqual({ providerSessionId: 'real', cwd: '/work' });
});

it('routes a giant imported tail into independent locating while preserving real metadata', async () => {
  const first = JSON.stringify({ type: 'user', uuid: 'first', sessionId: 'native-id', cwd: '/work', message: { role: 'user', content: 'hello' } });
  const giant = JSON.stringify({ type: 'assistant', uuid: 'last', sessionId: 'native-id', cwd: '/work', message: { role: 'assistant', content: 'x'.repeat(180_000) } });
  const input = await fixture(first + '\n' + giant + '\n'), schedule = vi.fn();
  const preview = await readBoundedLocalSessionPreview(input.root, { filePath: input.path, engine: 'claude-code' }, input.options, schedule);
  expect(preview).toMatchObject({ providerSessionId: 'native-id', cwd: '/work', turnCount: null });
  expect(preview.head[0]).toMatchObject({ role: 'user', content: 'hello' });
  expect(preview.pendingLongRecords).toHaveLength(1);
  expect(preview.pendingLongRecords[0]).not.toHaveProperty('role');
  expect(schedule).toHaveBeenCalledOnce();
  expect(schedule.mock.calls[0][1].scanBefore).toBeGreaterThan(0);
  expect(io.reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(128 * 1024 + 64);
  expect(io.reads.every(read => read.length <= 64 * 1024)).toBe(true);
});

it('returns an exact count only when the complete source fits the bounded decoded page', async () => {
  const record = JSON.stringify({ type: 'user', uuid: 'first', sessionId: 'native-id', cwd: '/work', message: { role: 'user', content: 'hello' } });
  const input = await fixture(record + '\n');
  expect(await readBoundedLocalSessionPreview(input.root, { filePath: input.path, engine: 'claude-code' }, input.options))
    .toMatchObject({ turnCount: 1, head: [{ role: 'user', content: 'hello' }], pendingLongRecords: [] });
});

it('rejects a symlink outside the native scan roots before preview or task scheduling', async () => {
  const input = await fixture('{}\n'), outside = join(input.root, 'outside.jsonl');
  await writeFile(outside, '{}\n'); const link = join(input.root, 'native', 'projects', 'link.jsonl'); await symlink(outside, link);
  const schedule = vi.fn();
  await expect(readBoundedLocalSessionPreview(input.root, { filePath: link, engine: 'claude-code' }, input.options, schedule)).rejects.toThrow('允许的扫描目录');
  expect(schedule).not.toHaveBeenCalled();
});
