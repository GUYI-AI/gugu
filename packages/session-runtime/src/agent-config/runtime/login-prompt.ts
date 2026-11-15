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
 * 「把码贴回来」的提示 —— 必须**停在最后一行、以提示符收尾**(`:` `>` `：` `?`)。
 * 只看词会误判:Kimi 印的是「If the browser did not open, paste the URL above and enter code: W1DF-PXG1」
 * (码是让人带去网页的,不是要人贴回来);Codex 印「2. Enter this one-time code」同理(2026-11-12 真 CLI 实录)。
 */
const PROMPT_WORDS = [
  /\b(paste|enter|input|type)\b[^\n]{0,80}\b(code|token|key)\b/i,
  /(粘贴|输入|填写)[^\n]{0,40}(授权码|验证码|代码|密钥|code|token|key)/i,
  /\b(authorization|auth|verification|one-time)\s+code\b/i,
  /\bapi\s*key\b/i,
];
const PROMPT_END = /[:>：?？]\s*$/;
/** clack(opencode / mimo / kilo 的 `auth login`)的输入框:`◆  Enter your API key` 下面跟着 `│  _`、`└`。 */
const CLACK_ACTIVE = /^[◆▲]\s+(.*)$/;
const CLACK_TAIL = /^([│|└]|$)/;
const KEY_WORDS = /\b(api\s*key|token|key)\b|密钥/i;

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
  /** 要的是网页给的授权码,还是一把 API key(opencode「Enter your API key」)—— 输入框的说法跟着变。 */
  inputKind: 'code' | 'key';
};

export function stripTerminalCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function normalize(raw: string): string {
  return stripTerminalCodes(raw).replace(/\r\n?/g, '\n');
}

/** 原文里最后一个 ESC 若还没收尾(序列被切在段尾),只读到它之前。 */
function completeEnd(raw: string): number {
  const escape = raw.lastIndexOf('\x1b');
  if (escape < 0) return raw.length;
  const rest = raw.slice(escape);
  ANSI_PATTERN.lastIndex = 0;
  const match = ANSI_PATTERN.exec(rest);
  ANSI_PATTERN.lastIndex = 0;
  return match && match.index === 0 ? raw.length : escape;
}

export class LoginOutputReader {
  private raw = '';
  private text = '';
  /** 人提交过输入时**原文**读到的位置:之后出现的提示才算「又在要码」。 */
  private inputMark = -1;
  private promptCount = 0;
  private promptOpen = false;
  private code: string | null = null;
  private kind: 'code' | 'key' = 'code';

  /** 读一段输出;读数变了返回 true。 */
  push(chunk: string): boolean {
    const before = this.reading();
    // 颜色 / 超链接序列可能被切在两段之间:在**累积的原文**上剥,没收尾的那一截留到下一段再剥。
    this.raw += chunk;
    if (this.raw.length > MAX_TEXT) {
      const drop = this.raw.length - MAX_TEXT;
      this.raw = this.raw.slice(drop);
      this.inputMark = Math.max(-1, this.inputMark - drop);
    }
    this.text = normalize(this.raw.slice(0, completeEnd(this.raw)));
    // 设备码只从**印完整**的行里读:半行读出来的是半个码(Kimi 实录:`W1DF-PXG` + `1`)。
    this.code ??= findUserCode(this.text.slice(0, this.text.lastIndexOf('\n') + 1));
    this.updatePrompt();
    return !sameReading(before, this.reading());
  }

  /** 人把码交上去了:提示关掉,直到之后的输出里**再**出现一次提示。 */
  noteInput(): boolean {
    const wasAwaiting = this.promptOpen;
    this.inputMark = this.raw.length;
    this.promptOpen = false;
    return wasAwaiting;
  }

  reading(): LoginOutputReading {
    return {
      userCode: this.code,
      awaitingInput: this.promptOpen,
      inputPromptCount: this.promptCount,
      inputKind: this.kind,
    };
  }

  /** 最后几行原话(登录失败时摆给用户)。 */
  tail(): string {
    return tailOf(this.text);
  }

  /**
   * 「还在要码吗」每段输出都重判(❌ 一旦开了就一直开):提示后面又印了别的东西 = 它不在等输入了。
   * 交过码之后只看交码之后的输出 —— 回显那一行(「…prompted > abc123」)不以提示符收尾,不会重开。
   */
  private updatePrompt(): void {
    const fresh = this.inputMark >= 0
      ? normalize(this.raw.slice(this.inputMark, completeEnd(this.raw)))
      : this.text;
    const prompt = activePrompt(fresh);
    if (!prompt) {
      this.promptOpen = false;
      return;
    }
    this.kind = KEY_WORDS.test(prompt) ? 'key' : 'code';
    if (this.promptOpen) return;
    this.promptOpen = true;
    this.promptCount += 1;
  }
}

/** 输出停在哪个「要输入」的提示上;没有就 null。 */
export function activePrompt(text: string): string | null {
  const lines = text.split('\n').map((line) => line.trim());
  while (lines.length > 0 && !lines.at(-1)) lines.pop();
  const last = lines.at(-1);
  if (!last) return null;
  if (isInputPrompt(last)) return last;
  // clack:最后一个活动框(◆)之后只剩框线 / 输入光标 / 收尾 └ ⇒ 它在等输入。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const active = line.match(CLACK_ACTIVE);
    if (active) {
      const after = lines.slice(index + 1);
      const waiting = after.every((rest) => CLACK_TAIL.test(rest));
      return waiting && PROMPT_WORDS.some((pattern) => pattern.test(active[1]!)) ? active[1]! : null;
    }
    if (!CLACK_TAIL.test(line)) return null;
  }
  return null;
}

export function isInputPrompt(line: string): boolean {
  const text = line.replace(URL_PATTERN, ' ').trim();
  return PROMPT_END.test(text) && PROMPT_WORDS.some((pattern) => pattern.test(text));
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

/**
 * 失败时摆给人看的最后几行。长链接收成「来源/…」:Claude 失败时最后几行里夹着一条四百多字的授权链接,
 * 原样摆出来把真正的原因(「Login failed: Request failed with status code 400」)挤出窗口(2026-11-12 真机实录)。
 */
function tailOf(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(URL_PATTERN, shortUrl).trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-TAIL_LINES)
    .join('\n');
}

function shortUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return url;
  }
}

function sameReading(a: LoginOutputReading, b: LoginOutputReading): boolean {
  return (
    a.userCode === b.userCode &&
    a.awaitingInput === b.awaitingInput &&
    a.inputPromptCount === b.inputPromptCount &&
    a.inputKind === b.inputKind
  );
}
