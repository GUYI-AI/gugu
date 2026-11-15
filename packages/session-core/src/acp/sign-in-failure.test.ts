import { describe, expect, it } from 'vitest';
import { isSignInFailure } from './sign-in-failure';

const failure = (code: number, data?: unknown) => ({ name: 'RequestError', message: 'x', code, data }) as never;

describe('isSignInFailure', () => {
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
