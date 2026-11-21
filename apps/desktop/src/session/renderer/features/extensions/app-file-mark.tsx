import { observer } from 'mobx-react-lite';
import { FileMark } from '@gugu/session-ui/file-mark';
import type { FileOpenContext } from '@shared/extensions/manifest';
import { peekInstalledAppsTracked } from './installed-extensions';

/**
 * A file as a tab shows it, the way the folder list draws the same file: the icon the App opening it declared for its
 * kind (`fileIcons`), else the host's file mark — never the App's own icon (owner 10-17, manifest.ts `fileIcons`).
 */
export const AppFileMark = observer(function AppFileMark({ kind, fileName, context, size }: {
  kind?: string | null; fileName: string; context: FileOpenContext; size: number;
}) {
  const icon = kind ? peekInstalledAppsTracked()?.fileIcon(kind, fileName, context) ?? null : null;
  return icon
    ? <img src={icon} alt="" aria-hidden="true" className="shrink-0" style={{ width: size, height: size }} />
    : <FileMark name={fileName} size={size} className="shrink-0 text-foreground-muted" />;
});
