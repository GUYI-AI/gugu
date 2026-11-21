import { basename } from 'node:path'

/**
 * 读 transcript 失败的原因码。**稳定的机器码**，不是给人读的句子：界面按码查中英文案。
 * 桌面端的 `import-error-code.ts` 收的是它的超集，单测核对两边不漂。
 */
export const TRANSCRIPT_ACCESS_CODES = [
  'transcript-unreadable',
  'transcript-outside-roots',
  'transcript-empty',
  'transcript-no-identity'
] as const
export type TranscriptAccessCode = (typeof TRANSCRIPT_ACCESS_CODES)[number]

/**
 * 读 transcript 失败的带码错误。
 *
 * - `message` = `<码>:<文件名>`（沿用 `gugu-models:<原因>` 那种把码放进 message 的写法）：本机 IPC 与
 *   预览线程都只把 message 递过去，自定义属性到不了渲染层，所以码必须在 message 里。
 * - 完整路径**只**放在 `filePath` 上给日志用，❌ 不拼进 message —— 它会原样出现在用户界面里。
 */
export class TranscriptAccessError extends Error {
  readonly code: TranscriptAccessCode
  readonly filePath: string

  constructor(code: TranscriptAccessCode, filePath: string) {
    super(`${code}:${basename(filePath)}`)
    this.name = 'TranscriptAccessError'
    this.code = code
    this.filePath = filePath
  }
}
