import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importError } from '@shared/core/session-import/import-error-code';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({ log: { warn } }));
const { logTranscriptFailure } = await import('./transcript-failure-log');

const PATH = '/Users/someone/.claude/projects/-work/imp-8.jsonl';

describe('logTranscriptFailure', () => {
  beforeEach(() => warn.mockReset());

  it('logs the full path of a transcript failure and rethrows the same error untouched', async () => {
    // 预览线程只递回 message:这里拿到的是只带文件名的错,完整路径只能取自请求参数。
    const failure = new Error('transcript-unreadable:imp-8.jsonl');
    await expect(logTranscriptFailure('preview', PATH, async () => { throw failure; })).rejects.toBe(failure);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[session-import] preview failed: transcript-unreadable', { filePath: PATH });
    expect(failure.message).not.toContain('/Users/someone');
  });

  it('only transcript failures are logged here; the other codes log their own context where they are thrown', async () => {
    await expect(logTranscriptFailure('import', PATH, async () => { throw importError('session-no-id'); })).rejects.toThrow('session-no-id:');
    await expect(logTranscriptFailure('import', PATH, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a successful result through without logging', async () => {
    await expect(logTranscriptFailure('preview', PATH, async () => 42)).resolves.toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });
});
