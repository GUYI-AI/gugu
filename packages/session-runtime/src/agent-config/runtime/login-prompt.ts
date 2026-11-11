/**
 * 终端登录(`cli-login`)的输出读取器 —— 把 `<cli> login` 印出来的东西读成界面要的三样(#2507):
 *  · `userCode`:设备码流程里要用户**带去浏览器**输入的那串码(如 `ABCD-EFGH`);
 *  · `awaitingInput`:CLI 正停在「把网页给的授权码贴回来」的提示上,界面据此给一个输入框;
 *  · `tail()`:最后几行原话,登录失败时原样摆给用户(厂商自己说的原因)。
 *
 * owner 2026-11-12:「有链接就给个链接，搞完之后如果需要验证码，就给个输入框让你填码……
 * 不用打开个类似终端的东西还需要我手填」。⇒ 登录窗口不再摆终端,这三样是终端里唯一需要人看/动的东西。
 *
 * ⚠️ 只读**剥过颜色序列**的文本;`\r` 当换行(进度行、Ink 重绘都靠它)。
 * ⚠️ 提示行常常**不带换行**(停在那里等输入),所以 `awaitingInput` 看的是「最后一行」,含未完成的那一行。
 */

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_78=>])/g;
const MAX_TEXT = 16_384;
const TAIL_LINES = 6;

/**
 * 「把码贴回来」的提示。
 *  · 强:「paste / 粘贴 … code / token」—— 只可能是在要人往这里贴;
 *  · 弱:「enter / input / type / 输入 … code」—— 也常是**设备码流程的说明**(「Enter this one-time code」
 *    指的是在浏览器里输入),所以必须以提示符收尾(`:` `>` `：` `?`)才算。
 */
const STRONG_PROMPT = [/\bpaste\b[^\n]{0,80}\b(code|token|key)\b/i, /粘贴[^\n]{0,40}(授权码|验证码|代码|code|token|key)/i];
const WEAK_PROMPT = [
  /\b(enter|input|type)\b[^\n]{0,80}\b(code|token)\b/i,
  /(输入|填写)[^\n]{0,40}(授权码|验证码|代码|code|token)/i,
  /\b(authorization|auth|verification|one-time)\s+code\b/i,
];
const PROMPT_END = /[:>：?？]\s*$/;

/** 提到「码」的那一行(设备码就在它本行冒号后,或紧跟的下一行)。 */
const CODE_MENTION = /(code|验证码|授权码|代码|用户码)/i;
/** 设备码的样子:大写字母数字分组、至少一个连字符(`ABCD-EFGH`、`WDJB-MJHT`、`1A2B-3C4D5`)。 */
const USER_CODE = /\b([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,3})\b/;
const URL_PATTERN = /https?:\/\/\S+/gi;

/**
 * 随登录状态发布的那一份。❌ 不含 `tail`:转圈的 CLI 每秒重绘十几次,随每段输出发布就是十几次状态推送;
 * 原话只在进程退出那一刻要(`tail()`)。
 */
export type LoginOutputReading = {
  userCode: string | null;
  awaitingInput: boolean;
  /** 第几次提示要码(重新要一次 = 上一次的码没被接受);没提示过为 0。 */
  inputPromptCount: number;
};

export function stripTerminalCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export class LoginOutputReader {
  private text = '';
  /** 人提交过输入之后的位置:之后出现的提示才算「又在要码」。 */
  private inputMark = -1;
  private promptCount = 0;
  private promptOpenAt = -1;
  private code: string | null = null;

  /** 读一段输出;读数变了返回 true。 */
  push(chunk: string): boolean {
    const before = this.reading();
    this.text += stripTerminalCodes(chunk).replace(/\r\n?/g, '\n');
    if (this.text.length > MAX_TEXT) {
      const drop = this.text.length - MAX_TEXT;
      this.text = this.text.slice(drop);
      this.inputMark = Math.max(-1, this.inputMark - drop);
      this.promptOpenAt = Math.max(-1, this.promptOpenAt - drop);
    }
    this.code ??= findUserCode(this.text);
    this.updatePrompt();
    return !sameReading(before, this.reading());
  }

  /** 人把码交上去了:提示关掉,直到之后的输出里**再**出现一次提示。 */
  noteInput(): boolean {
    const wasAwaiting = this.promptOpenAt >= 0;
    this.inputMark = this.text.length;
    this.promptOpenAt = -1;
    return wasAwaiting;
  }

  reading(): LoginOutputReading {
    return {
      userCode: this.code,
      awaitingInput: this.promptOpenAt >= 0,
      inputPromptCount: this.promptCount,
    };
  }

  /** 最后几行原话(登录失败时摆给用户)。 */
  tail(): string {
    return tailOf(this.text);
  }

  private updatePrompt(): void {
    if (this.promptOpenAt >= 0) return;
    const start = this.inputMark >= 0 ? this.inputMark : 0;
    const fresh = this.text.slice(start);
    const last = lastLine(fresh);
    if (!last || !isInputPrompt(last)) return;
    // 提交之后回显的那一行(「…prompted > abc123」)不是新的提示:提示必须以提示语收尾。
    if (this.inputMark >= 0 && !PROMPT_END.test(last)) return;
    this.promptOpenAt = this.text.length;
    this.promptCount += 1;
  }
}

export function isInputPrompt(line: string): boolean {
  const text = line.replace(URL_PATTERN, ' ').trim();
  if (STRONG_PROMPT.some((pattern) => pattern.test(text))) return true;
  return PROMPT_END.test(text) && WEAK_PROMPT.some((pattern) => pattern.test(text));
}

function findUserCode(text: string): string | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(URL_PATTERN, ' ');
    if (!CODE_MENTION.test(line)) continue;
    const sameLine = line.match(USER_CODE)?.[1];
    if (sameLine && hasLetterAndDigitOrDash(sameLine)) return sameLine;
    // 码在下一行(codex `--device-auth`:「2. Enter this one-time code …」下一行缩进着码)。
    for (let next = index + 1; next < Math.min(lines.length, index + 3); next += 1) {
      const candidate = lines[next]!.trim();
      if (!candidate) continue;
      const match = candidate.replace(URL_PATTERN, ' ').match(USER_CODE)?.[1];
      if (match && candidate.length <= match.length + 4 && hasLetterAndDigitOrDash(match)) return match;
      break;
    }
  }
  return null;
}

function hasLetterAndDigitOrDash(code: string): boolean {
  return /[A-Z]/.test(code) && code.includes('-');
}

function lastLine(text: string): string | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

function tailOf(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-TAIL_LINES)
    .join('\n');
}

function sameReading(a: LoginOutputReading, b: LoginOutputReading): boolean {
  return (
    a.userCode === b.userCode &&
    a.awaitingInput === b.awaitingInput &&
    a.inputPromptCount === b.inputPromptCount
  );
}
