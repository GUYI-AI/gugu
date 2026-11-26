import { describe, expect, it } from 'vitest';
import { codexHttpStatus, isCodexKeyRefusal, withCodexHttpStatus } from './codex-http-status';

// The turn error app-server sent for a key the address refused (Codex 0.172, d22, 2026-11-26).
const refused = {
  message: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-stub***., url: http://127.0.0.1:39973/v1/responses',
  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
  additionalDetails: null,
};

describe('codexHttpStatus', () => {
  it('reads the status under whichever failure kind carries it', () => {
    expect(codexHttpStatus(refused)).toBe(401);
    expect(codexHttpStatus({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 403 } } })).toBe(403);
  });
  it('has no status for a classification without one', () => {
    for (const error of [{ codexErrorInfo: 'unauthorized' }, { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } }, { message: 'x' }, null, 'text']) {
      expect(codexHttpStatus(error)).toBeNull();
    }
  });
  it('lifts the status to the top level and leaves an error without one as it was', () => {
    expect(withCodexHttpStatus(refused)).toEqual({ ...refused, httpStatusCode: 401 });
    const plain = { message: 'stream disconnected' };
    expect(withCodexHttpStatus(plain)).toBe(plain);
  });
});

describe('isCodexKeyRefusal', () => {
  it('stops on 401 and 403 only', () => {
    expect(isCodexKeyRefusal(refused)).toBe(true);
    expect(isCodexKeyRefusal({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } })).toBe(true);
    for (const status of [400, 404, 408, 429, 500, 502, 503]) {
      expect(isCodexKeyRefusal({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } })).toBe(false);
    }
    expect(isCodexKeyRefusal({ codexErrorInfo: { responseStreamDisconnected: {} } })).toBe(false);
  });
});
