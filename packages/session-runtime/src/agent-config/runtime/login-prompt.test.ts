import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isInputPrompt, LoginOutputReader } from './login-prompt';

/** 2026-11-12 在 MBP 上用隔离的 HOME 跑真 CLI 抓下来的原始输出(含颜色与超链接序列),逐字节。 */
const capture = (name: string) => readFileSync(new URL(`./__fixtures__/login-output/${name}`, import.meta.url), 'utf8');

/** 一个字一个字地喂:提示必须在任何切分下都判得一样。 */
function readAll(text: string, chunk = 1): LoginOutputReader {
  const reader = new LoginOutputReader();
  for (let index = 0; index < text.length; index += chunk) reader.push(text.slice(index, index + chunk));
  return reader;
}

describe('真 CLI 的登录输出(#2507)', () => {
  it.each([1, 7, 4096])('Claude 2.1.296 `auth login`:停在「Paste code here if prompted >」⇒ 要码(每段 %i 字)', (chunk) => {
    expect(readAll(capture('claude-2.1.296-auth-login.txt'), chunk).reading()).toMatchObject({
      awaitingInput: true,
      inputKind: 'code',
      userCode: null,
    });
  });

  it.each([1, 7, 4096])('Codex 0.160.0 `login --device-auth`:设备码在下一行、不要码(每段 %i 字)', (chunk) => {
    expect(readAll(capture('codex-0.160.0-login-device-auth.txt'), chunk).reading()).toMatchObject({
      userCode: 'CKN2-AUWY2',
      awaitingInput: false,
    });
  });

  it.each([1, 7, 4096])('Kimi 0.41.0 `login`:「paste the URL above and enter code: W1DF-PXG1」是带去网页的码,不是要码(每段 %i 字)', (chunk) => {
    expect(readAll(capture('kimi-0.41.0-login.txt'), chunk).reading()).toMatchObject({
      userCode: 'W1DF-PXG1',
      awaitingInput: false,
    });
  });

  it.each([1, 7, 4096])('OpenCode 1.18.28 `auth login -p opencode`:clack 输入框要的是 API key(每段 %i 字)', (chunk) => {
    expect(readAll(capture('opencode-1.18.28-auth-login-p-opencode.txt'), chunk).reading()).toMatchObject({
      awaitingInput: true,
      inputKind: 'key',
    });
  });

  it.each([1, 7, 4096])('MiMo 0.1.13 `auth login -p xiaomi`:给链接后停在「Paste code here if prompted >」⇒ 要码(每段 %i 字)', (chunk) => {
    expect(readAll(capture('mimocode-0.1.13-auth-login-p-xiaomi.txt'), chunk).reading()).toMatchObject({
      awaitingInput: true,
      inputKind: 'code',
      userCode: null,
    });
  });

  it.each([1, 7, 4096])('Copilot 1.0.109 `login --device-code`:设备码与链接同一行、剪贴板转义不算输出、不要码(每段 %i 字)', (chunk) => {
    const reader = readAll(capture('copilot-1.0.109-login-device-code.txt'), chunk);
    expect(reader.reading()).toMatchObject({ userCode: 'D7E7-AB5E', awaitingInput: false });
    expect(reader.tail()).not.toMatch(/\]52;/);
  });

  it.each([1, 7, 4096])('Kilo 7.8.27 `auth login -p kilo`:码已经带在链接里,只等授权、不要码(每段 %i 字)', (chunk) => {
    expect(readAll(capture('kilo-7.8.27-auth-login-p-kilo.txt'), chunk).reading()).toMatchObject({
      awaitingInput: false,
    });
  });

  it.each([1, 7, 4096])('Hermes 2026.9.24 `auth add nous --type oauth`:「If prompted, enter code: NF3L-YTKR」是带去网页的码,不是要码(每段 %i 字)', (chunk) => {
    expect(readAll(capture('hermes-2026.9.24-auth-add-nous.txt'), chunk).reading()).toMatchObject({
      userCode: 'NF3L-YTKR',
      awaitingInput: false,
    });
  });

  it('OpenCode 不带 -p:停在选供应商的菜单上 ⇒ 不是要码(没有终端时这条路走不通,得在命令里指定供应商)', () => {
    expect(readAll(capture('opencode-1.18.28-auth-login-picker.txt'), 4096).reading().awaitingInput).toBe(false);
  });
});

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

  it('shortens long links in the failure lines so the reason stays visible', () => {
    const reader = readAll(capture('claude-2.1.296-auth-login.txt'), 4096);
    reader.push('fakecode\r\nLogin failed: Request failed with status code 400\r\n');
    expect(reader.tail()).toContain("If the browser didn't open, visit: https://claude.com/…");
    expect(reader.tail()).not.toContain('client_id');
    expect(reader.tail()).toContain('Login failed: Request failed with status code 400');
  });
});

describe('isInputPrompt', () => {
  it.each([
    'Paste code here if prompted >',
    'Enter the authorization code:',
    'Paste the authorization code here:',
    '请粘贴网页上的授权码：',
    'Verification code:',
  ])('treats "%s" as a request for a code', (line) => {
    expect(isInputPrompt(line)).toBe(true);
  });

  it.each([
    'Waiting for authentication...',
    'Open https://example.com/device?code=ABCD and enter the code shown',
    'If the browser did not open, paste the URL above and enter code: W1DF-PXG1',
    '2. Enter this one-time code (expires in 15 minutes)',
    'Logged in successfully',
  ])('does not treat "%s" as a request for a code', (line) => {
    expect(isInputPrompt(line)).toBe(false);
  });
});
