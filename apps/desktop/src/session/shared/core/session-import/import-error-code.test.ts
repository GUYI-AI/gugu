import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_ACCESS_CODES } from '@gugu/core/local/agent/transcriptAccessError';
import { IMPORT_ERROR_CODES, importError, importErrorMessage, parseImportError } from './import-error-code';

describe('import error codes', () => {
  it('cover every transcript access code core can throw', () => {
    for (const code of TRANSCRIPT_ACCESS_CODES) expect(IMPORT_ERROR_CODES).toContain(code);
  });

  it('round-trip code and name through the message', () => {
    for (const code of IMPORT_ERROR_CODES) {
      expect(parseImportError(importErrorMessage(code, 'imp-8.jsonl'))).toEqual({ code, name: 'imp-8.jsonl' });
    }
    expect(parseImportError(importErrorMessage('session-no-id'))).toEqual({ code: 'session-no-id', name: '' });
  });

  it('keeps a name that itself contains a colon or a line break', () => {
    expect(parseImportError('project-open-failed:a:b\nc')).toEqual({ code: 'project-open-failed', name: 'a:b\nc' });
  });

  it('importError carries the same message plus the code for in-process callers', () => {
    const error = importError('session-no-cwd');
    expect(error.message).toBe('session-no-cwd:');
    expect(error.code).toBe('session-no-cwd');
  });

  it('leaves anything that is not one of our codes alone', () => {
    expect(parseImportError('读不到索引')).toBeNull();
    expect(parseImportError('目录已经不在了：/w')).toBeNull();
    expect(parseImportError('unknown-code:x')).toBeNull();
    expect(parseImportError('Failed to read: transcript-empty:x.jsonl')).toBeNull();
    expect(parseImportError('')).toBeNull();
  });
});
