// #6264 在别的机器上建会话 / 起会话失败时给人看的那一句,以及会话打开后转录末尾那一行。
//
// 机器报的是原因码(`remoteFailureKind` 归类);这里按界面语言说「哪台机器、出了什么事、接下来做什么」。
// 原文 ❌ 进这里的任何一句 —— 它在那台机器的日志里、这台桌面的日志里,转录那一行的悬停里只放原因码。
// 纯函数(翻译函数注入),每条判据都有单测。

/** 出错对象上的业务码(SessionpageRpcError 在 gugu 侧 bundle,按形状读);没有 = 传输层失败。 */
export function remoteErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : null;
}

export type RemoteStartCondition = {
  code: 'start-failed' | 'auth-required' | 'harness-missing';
  label: string;
  /** 悬停看的:原因码(排查用)。 */
  detail: string;
  /** 这一行带不带「再试一次」。 */
  retry: boolean;
  /**
   * 这一行句子里那段「在这里登录」(#6264 在那台机器上登录这家):有就由面板接到登录窗口上。
   * `restart` = 登上之后顺手把这条没开起来的会话再开一次(人要的本来就是它开起来)。
   */
  signIn?: { label: string; restart: boolean };
};

/**
 * 这一家在那台机器上能不能从这里登录(面板按插件声明与宿主能力算好传进来):
 *  · `here` —— 声明了不靠回跳的登录,在咕咕里就能登;
 *  · `instructions` —— 这家有登录命令但只能到那台机器的终端里敲,点开看怎么登;
 *  · `null` —— 产品里没有这家的登录动作(或宿主给不了),只说事实。
 */
export type RemoteSignInReach = 'here' | 'instructions' | null;

