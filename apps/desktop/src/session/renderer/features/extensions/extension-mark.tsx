import { observer } from 'mobx-react-lite';
import { Folder, LayoutGrid } from '@/lib/icons';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { cn } from '@renderer/utils/utils';
import { installedExtensionsStore, WORKSPACE_APP_ID } from './installed-extensions-store';

/**
 * An extension's own mark, or the generic one when it shipped none.
 *
 * `src` is a data URL main produced by re-encoding the declared file, so this
 * `<img>` draws pixels gugu wrote — the extension's bytes never reach the
 * privileged renderer. A decode that failed upstream arrives as no icon at all
 * rather than a broken image. Pure: it takes the URL, it does not read the
 * store, so the entry builders (which stay off the app-state graph) can use it.
 */
export function ExtensionMark({
  iconDataUrl,
  className,
}: {
  iconDataUrl: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', className)}
      aria-hidden
    >
      {iconDataUrl ? (
        <img src={iconDataUrl} alt="" className="size-3.5 rounded-sm object-contain" />
      ) : (
        <LayoutGrid className="size-3.5" />
      )}
    </span>
  );
}

/** A tab kind's mark wherever it shows; the Files App's is the folder glyph in the text colour, so it follows the theme. */
export const TabKindMark = observer(function TabKindMark({ kind, className }: { kind: string; className?: string }) {
  if (parseExtensionTabKind(kind)?.extensionId !== WORKSPACE_APP_ID) return <ExtensionMark iconDataUrl={installedExtensionsStore.allTabContributions.find((entry) => entry.kind === kind)?.iconDataUrl} className={className} />;
  return <span className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', className)} aria-hidden><Folder className="size-3.5" /></span>;
});
