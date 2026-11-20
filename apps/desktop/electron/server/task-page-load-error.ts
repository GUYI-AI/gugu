/** A main-frame load failure as the built-in browser reports it (Electron's `did-fail-load`): a numeric code and the error's name. */
export type TaskPageLoadFailure = { errorCode: number; errorDescription: string };

/** Chrome's own error page is what a headless Chrome shows for a failed load; its error line is read into Electron's terms. */
export const CHROME_ERROR_PAGE_URL = 'chrome-error://chromewebdata/';

// The net errors people meet, by Chromium's code. Others keep their name with the generic failure code.
const NET_ERRORS: Record<string, number> = {
  ERR_CONNECTION_CLOSED: -100, ERR_CONNECTION_RESET: -101, ERR_CONNECTION_REFUSED: -102, ERR_CONNECTION_FAILED: -104,
  ERR_NAME_NOT_RESOLVED: -105, ERR_INTERNET_DISCONNECTED: -106, ERR_SSL_PROTOCOL_ERROR: -107, ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CONNECTION_TIMED_OUT: -118, ERR_NAME_RESOLUTION_FAILED: -137, ERR_TIMED_OUT: -7, ERR_NETWORK_CHANGED: -21,
  ERR_CERT_COMMON_NAME_INVALID: -200, ERR_CERT_DATE_INVALID: -201, ERR_CERT_AUTHORITY_INVALID: -202, ERR_CERT_INVALID: -207,
  ERR_UNSAFE_PORT: -9, ERR_INVALID_URL: -300, ERR_TOO_MANY_REDIRECTS: -310, ERR_EMPTY_RESPONSE: -324, ERR_INVALID_AUTH_CREDENTIALS: -338,
  ERR_HTTP_RESPONSE_CODE_FAILURE: -379, ERR_INSECURE_RESPONSE: -501,
};

/** The error line of Chrome's error page: `net::ERR_X`, `ERR_X`, or `HTTP ERROR 502` for a bodyless error response. */
export function taskPageLoadFailure(errorLine: string): TaskPageLoadFailure {
  const line = errorLine.trim();
  if (/^HTTP ERROR \d+/i.test(line)) return { errorCode: NET_ERRORS.ERR_HTTP_RESPONSE_CODE_FAILURE!, errorDescription: 'ERR_HTTP_RESPONSE_CODE_FAILURE' };
  const name = /^(?:net::)?(ERR_[A-Z0-9_]+)$/i.exec(line)?.[1]?.toUpperCase();
  if (!name) return { errorCode: -2, errorDescription: 'ERR_FAILED' };
  return { errorCode: NET_ERRORS[name] ?? -2, errorDescription: name };
}

/** Run in Chrome's error page: the line that names the error. */
export const READ_CHROME_ERROR_SCRIPT = `(() => {
  const named = typeof loadTimeData !== 'undefined' && loadTimeData.data_ && loadTimeData.data_.errorCode;
  const shown = document.querySelector('.error-code');
  return String(named || (shown && shown.textContent) || '');
})()`;
