import { FileMark } from '@gugu/session-ui/file-mark'
import { resolveFileIconClass } from '@gugu/session-chat-ui/file-icons'

/**
 * The devicon class for a file, from the one map chat uses (`resolveFileIconClass`).
 *
 * @@@chrome-is-ink (Refs #6106) — ❌ 别在这里留 devicon 的 `colored`:它才是上品牌色的那个类
 * (`devicon.min.css`:`.devicon-rust-original.colored{color:#000}`),色值写死、不随主题走。
 * 不带 `colored` 时 devicon 继承 `currentColor` ⇒ 跟着宿主的墨色走,身份区分交给字形本身。
 */
const inkIconClass = (filename: string) => resolveFileIconClass(filename)?.replace(/\s*\bcolored\b/, '')

interface FileIconProps {
  filename: string;
  className?: string;
  size?: number;
}

/** A code file's devicon when it has one; otherwise its family's mark (`FileMark`, the table every file icon reads). */
export function FileIcon({ filename, className, size = 12 }: FileIconProps) {
  const deviconClass = inkIconClass(filename);
  if (deviconClass) {
    return (
      <i className={deviconClass} style={{ fontSize: size, lineHeight: 1 }} aria-hidden="true" />
    );
  }
  return <FileMark name={filename} size={size} className={className ?? 'shrink-0 text-foreground-passive'} />;
}
