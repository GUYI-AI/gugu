import { describe, expect, it } from 'vitest';
import { isInputPrompt, LoginOutputReader } from './login-prompt';

describe('LoginOutputReader (#2507)', () => {
  it('opens the code box when the CLI stops on a paste-back prompt without a trailing newline', () => {
    const reader = new LoginOutputReader();
    reader.push('Browser didn\'t open? Use the url below to sign in:\r\n\r\n');
    reader.push('\x1b[2mhttps://claude.ai/oauth/authorize?code=true&client_id=x\x1b[0m\r\n\r\n');
    expect(reader.reading().awaitingInput).toBe(false);
    expect(reader.push('Paste code here if prompted > ')).toBe(true);
    expect(reader.reading()).toMatchObject({ awaitingInput: true, inputPromptCount: 1 });
  });

  it('closes the box once the code is submitted and the echoed line does not reopen it', () => {
    const reader = new LoginOutputReader();
    reader.push('Paste code here if prompted > ');
    expect(reader.noteInput()).toBe(true);
    reader.push('\x1b[2K\rPaste code here if prompted > abc123#state');
    expect(reader.reading()).toMatchObject({ awaitingInput: false, inputPromptCount: 1 });
  });

  it('reopens the box when the CLI asks again after a rejected code', () => {
    const reader = new LoginOutputReader();
    reader.push('Paste code here if prompted > ');
    reader.noteInput();
    reader.push('abc\r\nOAuth error: invalid code\r\nPaste code here if prompted > ');
    expect(reader.reading()).toMatchObject({ awaitingInput: true, inputPromptCount: 2 });
  });

  it('reads a device code printed on the line after its label', () => {
    const reader = new LoginOutputReader();
    reader.push('1. Open this link in your browser\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n');
    reader.push('2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mWDJB-MJHT2\x1b[0m\n');
    expect(reader.reading()).toMatchObject({ userCode: 'WDJB-MJHT2', awaitingInput: false });
  });

  it('reads a device code printed on the same line', () => {
    const reader = new LoginOutputReader();
    reader.push('Please visit https://github.com/login/device and enter code: 1A2B-C3D4\n');
    expect(reader.reading().userCode).toBe('1A2B-C3D4');
  });

  it('does not mistake URL fragments, dates or plain words for a device code', () => {
    const reader = new LoginOutputReader();
    reader.push('Opening https://auth.example.com/AB12-CD34/authorize?code=XYZ1-ABCD\n');
    reader.push('Code expires 2026-11-12\n');
    reader.push('Waiting for the authorization code...\n');
    expect(reader.reading().userCode).toBeNull();
    expect(reader.reading().awaitingInput).toBe(false);
  });

  it('keeps the last lines as the failure reason and does not publish on spinner redraws', () => {
    const reader = new LoginOutputReader();
    reader.push('Starting login\n');
    expect(reader.push('\r⠋ Waiting for authorization')).toBe(false);
    expect(reader.push('\r⠙ Waiting for authorization')).toBe(false);
    reader.push('\nError: token exchange failed (403)\n');
    expect(reader.tail()).toContain('Error: token exchange failed (403)');
  });
});

describe('isInputPrompt', () => {
  it.each([
    'Paste code here if prompted >',
    'Enter the authorization code:',
    'Paste the API token from the page above',
    '请粘贴网页上的授权码：',
    'Verification code:',
  ])('treats "%s" as a request for a code', (line) => {
    expect(isInputPrompt(line)).toBe(true);
  });

  it.each([
    'Waiting for authentication...',
    'Open https://example.com/device?code=ABCD and enter the code shown',
    'Logged in successfully',
  ])('does not treat "%s" as a request for a code', (line) => {
    expect(isInputPrompt(line)).toBe(false);
  });
});
