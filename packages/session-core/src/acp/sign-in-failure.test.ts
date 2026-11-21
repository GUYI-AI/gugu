import { describe, expect, it } from 'vitest';
import { isSignInFailure, isCodexRefreshTokenRevoked } from './sign-in-failure';
import { transcriptTurnOutcomeSchema } from './models/turns/turn';

const failure = (code: number, data?: unknown) => ({ name: 'RequestError', message: 'x', code, data }) as never;

describe('isSignInFailure', () => {
  it('retains the revoked sign-in reason across transcript serialization', () => {
    expect(transcriptTurnOutcomeSchema.parse({ kind: 'error', signInRequired: true, signInReason: 'revoked' }))
      .toEqual({ kind: 'error', signInRequired: true, signInReason: 'revoked' });
  });
  it.each(['Refresh token was revoked. Please sign in again.', 'refresh token has been revoked', 'refresh token revoked'])('recognizes the explicit revoked-token refusal: %s', (message) => {
    expect(isSignInFailure({ name: 'Error', message })).toBe(true);
    expect(isCodexRefreshTokenRevoked({ name: 'Error', message })).toBe(true);
    expect(isCodexRefreshTokenRevoked({ name: 'RequestError', message: 'Internal error', data: { message } })).toBe(true);
  });

  it('does not treat generic refresh, network, or token errors as revocation', () => {
    for (const message of ['Your access token could not be refreshed. Please sign in again.', 'refresh token request timed out', 'API token was revoked']) {
      expect(isCodexRefreshTokenRevoked({ name: 'Error', message })).toBe(false);
      expect(isSignInFailure({ name: 'Error', message })).toBe(false);
    }
  });
  it('tells a typed -32000 that names authentication from one that names something else', () => {
    expect(isSignInFailure(failure(-32000, { errorType: 'AuthenticationRequiredError' }))).toBe(true);
    expect(isSignInFailure(failure(-32000, { errorType: 'InvalidCredentialsError' }))).toBe(true);
    expect(isSignInFailure(failure(-32000, { errorType: 'ModelRegistryUnavailableError' }))).toBe(false);
    expect(isSignInFailure(failure(-32000, { errorType: 'McpServersNotReadyError' }))).toBe(false);
  });

  it('reads the bare ACP code as a sign-in refusal', () => {
    expect(isSignInFailure(failure(-32000))).toBe(true);
    expect(isSignInFailure(failure(-32000, { authMethods: [] }))).toBe(true);
  });

  it('does not read a typed harness failure sharing the code as one', () => {
    expect(isSignInFailure(failure(-32000, { errorType: 'ModelRegistryUnavailableError', retryErrorType: 'SERVER_ERROR' }))).toBe(false);
  });
});
