import { useState } from 'react';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { cn } from '@renderer/utils/utils';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { pinsAutoUpdate } from '@shared/extensions/market-entries';
import { marketCompatText, type MarketVersionHistoryEntry } from '@shared/extensions/market';
import type { SessionTranslate } from '../extension-consent';

export type Loadable<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

const HISTORY_FOLDED = 5;

export function shortDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function VersionHistorySection({
  state,
  extensionId,
  installedVersion,
  offeredVersion,
  locale,
  translate,
  onInstallVersion,
  onOpenExternal,
}: {
  state: Loadable<MarketVersionHistoryEntry[]>;
  extensionId: string;
  installedVersion: string | undefined;
  /** 市场给这台机器的那一版,这个 App 还在自动更新时才给:比它旧的那几版一装上就不再自动更新,按钮上说一句。 */
  offeredVersion: string | null;
  locale: string;
  translate: SessionTranslate;
  /** Absent: the versions are only read here (the App is installed; versions are changed on its settings page). */
  onInstallVersion?: (version: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (state.status === 'idle' || state.status === 'loading') {
    return <p className="text-foreground-passive">{translate('extensions.loading')}</p>;
  }
  if (state.status === 'error') {
    return <p className="text-foreground-muted">{translate('extensions.historyUnavailable')}</p>;
  }
  if (state.data.length === 0) {
    return <p className="text-foreground-muted">{translate('extensions.historyNone')}</p>;
  }
  // 默认最近五版,装着的那一版总在;其余点开。
  const shown = all ? state.data : state.data.filter((entry, index) => index < HISTORY_FOLDED || entry.version === installedVersion);
  return (
    <>
    <ul className="xp-history">
      {shown.map((entry) => (
        <VersionHistoryRow
          key={entry.version}
          entry={entry}
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
    {shown.length < state.data.length ? (
      <button type="button" className="xp-link xp-history-more" onClick={() => setAll(true)} data-testid="extension-history-more">
        {translate('extensions.historyShowAll', { count: state.data.length })}
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
  extensionId,
  installedVersion,
  pins,
  locale,
  translate,
  onInstallVersion,
  onOpenExternal,
}: {
  entry: MarketVersionHistoryEntry;
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
      <div className="xp-history-row">
        <span className={cn('xp-history-version', entry.yanked && 'is-yanked')}>{entry.version}</span>
        <span className="xp-history-date">{shortDate(entry.publishedAt, locale)}</span>
        {yankedReason ? (
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
        )}
        <span className="xp-history-action">
          {isInstalled ? (
            <span className="xp-state">{translate('extensions.stripThisInstalled')}</span>
          ) : yankedReason ? null : compatReason ? (
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
