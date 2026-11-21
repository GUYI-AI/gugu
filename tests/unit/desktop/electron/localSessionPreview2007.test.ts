import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readBoundedLocalSessionPreview } from '../../../../apps/desktop/electron/sessionpage/local-session-preview';
import { transcriptPrefixMetadata } from '../../../../apps/desktop/electron/sessionpage/transcript-prefix-metadata';

const observed = vi.hoisted(() => ({ reads: [] as Array<{ position: number; length: number }>,
  afterRead: null as (() => Promise<void>) | null }));
vi.mock('@gugu/session-core/session-record/window-cache/file-source', async original => {
  const actual = await original<typeof import('../../../../packages/session-core/src/session-record/window-cache/file-source')>();
  return { ...actual, async openWindowByteSource(path: string) {
    const source = await actual.openWindowByteSource(path);
    return { ...source, async read(target: Uint8Array, offset: number, length: number, position: number) {
      observed.reads.push({ position, length });
      const count = await source.read(target, offset, length, position);
      const hook = observed.afterRead; observed.afterRead = null; await hook?.();
      return count;
    } };
  } };
});
const roots: string[] = [];
afterEach(async () => {
  observed.reads.length = 0; observed.afterRead = null;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(engine: 'claude-code' | 'codex' = 'claude-code') {
  const root = await mkdtemp(join(tmpdir(), 'preview2007-')); roots.push(root);
  const native = join(root, 'native'), directory = join(native, engine === 'codex' ? 'sessions' : 'projects');
  await mkdir(directory, { recursive: true });
  return { root, filePath: join(directory, 'session.jsonl'), engine,
    scanOptions: { nativeHomes: { 'claude-code': [native], codex: [native] } } };
}
const message = (text: string, role = 'user') => JSON.stringify({ type: role, sessionId: 'native-id', cwd: '/work', message: { role, content: text } });

it.each([512 * 1024 * 1024, 596_177_689, 2 * 1024 * 1024 * 1024])('reads at most two 64KiB windows of a sparse %i-byte source', async size => {
  const input = await fixture(), file = await open(input.filePath, 'w');
  const head = message('开头') + '\n', tail = '\n' + message('最新的中文消息', 'assistant') + '\n';
  try { await file.write(head, 0, 'utf8'); await file.truncate(size); await file.write(tail, size - Buffer.byteLength(tail), 'utf8'); }
  finally { await file.close(); }
  const result = await readBoundedLocalSessionPreview(input);
  expect(result).toMatchObject({ providerSessionId: 'native-id', cwd: '/work', turnCount: null, incomplete: true,
    head: [{ content: '开头' }], tail: [{ content: '最新的中文消息' }] });
  expect(result.io.sourceBytes).toBe(128 * 1024);
  expect(observed.reads.every(read => read.position < 64 * 1024 || read.position >= size - 64 * 1024)).toBe(true);
  expect(result.io.outputBytes).toBeLessThanOrEqual(32 * 1024);
});

it('retains exact short-file counts, title precedence, envelopes and no repeated physical head/tail records', async () => {
  const input = await fixture();
  await writeFile(input.filePath, [message('第一条'), '{bad json}',
    JSON.stringify({ type: 'custom-title', customTitle: '用户标题' }),
    JSON.stringify({ type: 'ai-title', aiTitle: '不要覆盖' }),
    message('第二条', 'assistant'), message('第三条'), message('第四条', 'assistant')].join('\n'));
  const result = await readBoundedLocalSessionPreview(input);
  expect(result).toMatchObject({ turnCount: 4, incomplete: false, title: '用户标题' });
  expect(result.head.map(turn => turn.content)).toEqual(['第一条', '第二条', '第三条']);
  expect(result.tail.map(turn => turn.content)).toEqual(['第四条']);
  expect(result.io.sourceBytes).toBeLessThan(64 * 1024);
});

it('uses the same parser rules for sidechains, machine injections and user-only fallback titles', async () => {
  const input = await fixture();
  await writeFile(input.filePath, [message('先出现的助手', 'assistant'),
    message('<local-command-stdout>不要导入</local-command-stdout>'),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: 'wrong-id', message: { role: 'user', content: '旁支' } }),
    message('真实用户')].join('\n'));
  const result = await readBoundedLocalSessionPreview(input);
  expect(result.title).toBe('真实用户');
  expect(result.head.map(turn => turn.content)).toEqual(['先出现的助手', '真实用户']);
  expect(result.providerSessionId).toBe('native-id');
});

it('does not parse/return a giant JSON record or fabricate its message count', async () => {
  const input = await fixture('codex');
  await writeFile(input.filePath, JSON.stringify({ type: 'session_meta', payload: { id: 'codex-id', cwd: '/original', base_instructions: 'x'.repeat(200_000) } }) + '\n');
  const result = await readBoundedLocalSessionPreview(input);
  expect(result).toMatchObject({ providerSessionId: 'codex-id', cwd: '/original', turnCount: null, incomplete: true, oversizedTail: true, head: [], tail: [] });
  expect(result.io.sourceBytes).toBe(128 * 1024);
  expect(result.io.examinedRecords).toBe(0);
});

it('preserves split UTF-8 and filters Codex machine injection/event duplicates', async () => {
  const input = await fixture('codex');
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'codex-id', cwd: '/work' } });
  const response = (role: string, text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  await writeFile(input.filePath, [meta, response('user', '# AGENTS.md instructions\n机器注入'),
    response('user', '中文问题'), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '重复' } }), response('assistant', '中文回答')].join('\n'));
  const result = await readBoundedLocalSessionPreview(input);
  expect(result.head.map(turn => turn.content)).toEqual(['中文问题', '中文回答']);
  expect(result.turnCount).toBe(2);
});

it('charges examined records across both windows and does not claim a count after the record limit', async () => {
  const input = await fixture();
  await writeFile(input.filePath, Array.from({ length: 150 }, (_, index) => message(`msg-${index}`)).join('\n'));
  const result = await readBoundedLocalSessionPreview(input);
  expect(result.turnCount).toBeNull(); expect(result.io.examinedRecords).toBe(128);
  expect(result.head.map(turn => turn.content)).toEqual(['msg-0', 'msg-1', 'msg-2']);
  expect(result.tail.map(turn => turn.content)).toEqual(['msg-147', 'msg-148', 'msg-149']);
});

it('rejects a symlink outside scan roots before source I/O', async () => {
  const input = await fixture();
  await writeFile(join(input.root, 'outside.jsonl'), message('private'));
  await symlink(join(input.root, 'outside.jsonl'), input.filePath);
  await expect(readBoundedLocalSessionPreview(input)).rejects.toThrow('transcript-outside-roots:session.jsonl');
  expect(observed.reads).toEqual([]);
});

it('names a missing file by file name only: the code travels, the full path does not', async () => {
  const input = await fixture();
  const failure = await readBoundedLocalSessionPreview(input).catch((error: Error) => error);
  expect(failure).toMatchObject({ name: 'TranscriptAccessError', code: 'transcript-unreadable', message: 'transcript-unreadable:session.jsonl', filePath: input.filePath });
  expect((failure as Error).message).not.toContain(input.root);
  expect(observed.reads).toEqual([]);
});

it('reports a complete transcript without any user or assistant turn as transcript-empty', async () => {
  const input = await fixture(); await writeFile(input.filePath, JSON.stringify({ type: 'summary', sessionId: 'native-id', cwd: '/work' }) + '\n');
  await expect(readBoundedLocalSessionPreview(input)).rejects.toThrow('transcript-empty:session.jsonl');
});

it('reports cancellation and source truncation rather than a successful empty preview', async () => {
  const input = await fixture(); await writeFile(input.filePath, message('hello'));
  const controller = new AbortController(); controller.abort();
  await expect(readBoundedLocalSessionPreview(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(observed.reads).toEqual([]);
  observed.afterRead = () => writeFile(input.filePath, '');
  await expect(readBoundedLocalSessionPreview(input)).rejects.toThrow('changed');
});

it('only accepts complete metadata scalars at their actual JSON paths', () => {
  expect(transcriptPrefixMetadata('{"message":{"content":"\\"sessionId\\":\\"fake\\""},"sessionId":"real","cwd":"/work","body":"unfinished', 'claude-code'))
    .toEqual({ providerSessionId: 'real', cwd: '/work' });
  expect(transcriptPrefixMetadata('{"payload":{"id":"real","cwd":"/w"},"type":"session_meta","body":"unfinished', 'codex'))
    .toEqual({ providerSessionId: 'real', cwd: '/w' });
  expect(transcriptPrefixMetadata('{"sessionId":"fake" "cwd":"/wrong"}', 'claude-code')).toEqual({});
  expect(transcriptPrefixMetadata('{"sessionId":"fake","body":INVALID}', 'claude-code')).toEqual({});
  expect(transcriptPrefixMetadata('{"sessionId":"unterminated', 'claude-code')).toEqual({});
});
