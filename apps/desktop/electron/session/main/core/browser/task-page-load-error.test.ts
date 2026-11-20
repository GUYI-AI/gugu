import { describe, expect, it } from 'vitest';
import { taskPageLoadFailure } from '../../../../server/task-page-load-error';

describe('a failed page load as the built-in browser reports it', () => {
  it('reads the names Chrome puts on its error page into Electron codes', () => {
    expect(taskPageLoadFailure('net::ERR_CERT_AUTHORITY_INVALID')).toEqual({ errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID' });
    expect(taskPageLoadFailure('ERR_CONNECTION_REFUSED')).toEqual({ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' });
    expect(taskPageLoadFailure(' ERR_NAME_NOT_RESOLVED\n')).toEqual({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED' });
  });

  it('treats a bodyless HTTP error response as the built-in browser does', () => {
    expect(taskPageLoadFailure('HTTP ERROR 502')).toEqual({ errorCode: -379, errorDescription: 'ERR_HTTP_RESPONSE_CODE_FAILURE' });
  });

  it('keeps the name of an error it has no code for, with the generic failure code', () => {
    expect(taskPageLoadFailure('net::ERR_SOMETHING_NEW')).toEqual({ errorCode: -2, errorDescription: 'ERR_SOMETHING_NEW' });
    expect(taskPageLoadFailure('')).toEqual({ errorCode: -2, errorDescription: 'ERR_FAILED' });
    expect(taskPageLoadFailure('Your connection is not private')).toEqual({ errorCode: -2, errorDescription: 'ERR_FAILED' });
  });
});
