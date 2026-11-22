import { useState } from 'react';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { cn } from '@renderer/utils/utils';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { pinsAutoUpdate } from '@shared/extensions/market-entries';
import { marketCompatText, type MarketVersionHistoryEntry } from '@shared/extensions/market';
import type { SessionTranslate } from '../extension-consent';
import { retryOf, type Reading } from '@/lib/replica';
import { messageForUser } from '@/lib/userFacingError';

const HISTORY_FOLDED = 5;

export function shortDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function VersionHistorySection({
  reading,
  extensionId,
  installedVersion,
  offeredVersion,
  locale,
  translate,
  onInstallVersion,
  onOpenExternal,
  foldedCount = HISTORY_FOLDED,
  showReleaseNotes = true,
}: {
  /** The App's `marketVersionHistory` reading: its failure is said here with its own retry. */
  reading: Reading<MarketVersionHistoryEntry[]>;
  extensionId: string;
  installedVersion: string | undefined;
  /** 市场给这台机器的那一版,这个 App 还在自动更新时才给:比它旧的那几版一装上就不再自动更新,按钮上说一句。 */
  offeredVersion: string | null;
  locale: string;
  translate: SessionTranslate;
  /** Absent: the versions are only read here (the App is installed; versions are changed on its settings page). */
  onInstallVersion?: (version: string) => void;
  onOpenExternal: (url: string) => void;
  foldedCount?: number;
  showReleaseNotes?: boolean;
}) {
  const [all, setAll] = useState(false);
  if (reading.state === 'unknown') {
    return <p className="text-foreground-passive">{translate('extensions.loading')}</p>;
  }
  const retry = retryOf(reading);
  const failure = reading.error
    ? <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-foreground-muted">{reading.error.message === 'history unreadable' ? translate('extensions.historyUnavailable') : messageForUser(reading.error)}</p>{retry ? <button type="button" className="xp-link" onClick={retry}>{translate('settings.readAgain')}</button> : null}</div> : null;
  if (reading.state === 'error') return failure;
  const versions = reading.value;
  if (versions.length === 0) {
    return <>{failure}<p className="text-foreground-muted">{translate('extensions.historyNone')}</p></>;
  }
  // 默认最近五版,装着的那一版总在;其余点开。
  const shown = all ? versions : versions.filter((entry, index) => index < foldedCount || entry.version === installedVersion);
  return (
    <>
    {failure}
    <ul className="xp-history">
      {shown.map((entry) => (
        <VersionHistoryRow
          key={entry.version}
          entry={entry}
          showReleaseNotes={showReleaseNotes}
          extensionId={extensionId}
          installedVersion={installedVersion}
          pins={pinsAutoUpdate(entry.version, offeredVersion)}
          locale={locale}
          translate={translate}
          onInstallVersion={onInstallVersion}
          onOpenExternal={onOpenExternal}
        />
      ))}
    </ul>
    {shown.length < versions.length ? (
      <button type="button" className="xp-link xp-history-more" onClick={() => setAll(true)} data-testid="extension-history-more">
        {translate('extensions.historyShowAll', { count: versions.length })}
      </button>
    ) : null}
    </>
  );
}

/**
 * 一版一行:版本 · 日期 · 这版第一句 · 右边一个词。右边那个词:装着的写「装着的这一版」;比装着的新 =「更新」,
 * 旧 =「改用 vX」(原型的版本历史);没装 =「安装」;装不了的写原因;撤回的那版把原因放在句子那一格、右边什么都不放。
 */
function VersionHistoryRow({
  entry,
  showReleaseNotes,
  extensionId,
  installedVersion,
  pins,
  locale,
  translate,
  onInstallVersion,
  onOpenExternal,
}: {
  entry: MarketVersionHistoryEntry;
  showReleaseNotes: boolean;
  extensionId: string;
  installedVersion: string | undefined;
  /** 装上它,这个 App 就不再自动更新(`pinsAutoUpdate`)。 */
  pins: boolean;
  locale: string;
  translate: SessionTranslate;
  /** Absent: the versions are only read here (the App is installed; versions are changed on its settings page). */
  onInstallVersion?: (version: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isInstalled = entry.version === installedVersion;
  const yankedReason = entry.yanked ? translate('extensions.historyYanked', { note: entry.yanked.reason }) : null;
  const compatReason = entry.platformRefusal
    ? translate('extensions.platformVersionUnavailable')
    : entry.compat
    ? marketCompatText(entry.compat, translate)
    : null;
  const firstLine = (entry.releaseNotes.split(/\r?\n/).find((line) => line.trim() !== '') ?? '')
    .trim()
    .replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, '');
  const actionLabel = !installedVersion
    ? translate('extensions.installAction')
    : compareExtensionVersions(entry.version, installedVersion) > 0
      ? translate('extensions.updateAction')
      : translate('extensions.historyUse');

  return (
    <li data-testid={`extension-history-${extensionId}-${entry.version}`}>
      <div className={cn("xp-history-row", !showReleaseNotes && "xp-history-row-compact")}>
        <span className={cn('xp-history-version', entry.yanked && 'is-yanked')}>{showReleaseNotes ? entry.version : `v${entry.version}`}</span>
        <span className="xp-history-date">{shortDate(entry.publishedAt, locale)}</span>
        {showReleaseNotes && (yankedReason ? (
          <span className="xp-history-note is-warn">{yankedReason}</span>
        ) : (
          <button
            type="button"
            className={cn('xp-history-note', expanded && 'is-open')}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '' : firstLine}
          </button>
        ))}
        <span className="xp-history-action">
          {isInstalled ? (
            <span className="xp-state">{translate('extensions.stripThisInstalled')}</span>
          ) : yankedReason ? (showReleaseNotes ? null : <span className="xp-state">{yankedReason}</span>) : compatReason ? (
            <span className="xp-state">{compatReason}</span>
          ) : onInstallVersion ? (
            <button
              type="button"
              className="xp-link"
              title={pins ? translate('extensions.pinHint') : undefined}
              onClick={() => onInstallVersion(entry.version)}
            >
              {actionLabel}
            </button>
          ) : null}
        </span>
      </div>
      {expanded && !yankedReason ? (
        <div className="xp-history-body">
          <MarkdownRenderer content={entry.releaseNotes} onOpenLink={(url) => { onOpenExternal(url); return true; }} />
        </div>
      ) : null}
    </li>
  );
}
