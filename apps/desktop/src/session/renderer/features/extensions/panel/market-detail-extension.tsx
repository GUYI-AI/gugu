import { useQuery } from '@tanstack/react-query';
import { History, Image, KeyRound } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { ExpandableImage } from '@renderer/lib/ui/expandable-image';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { declaredPermissions, localizedManifestText, manifestLanguages } from '@shared/extensions/catalog';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import type { MarketListItem, MarketSourceRef } from '@shared/extensions/market';
import { describePermissions } from '../extension-consent';
import type { AppLifecycle } from './app-lifecycle-button';
import { shortDate, VersionHistorySection } from './app-version-history';
import { ExtensionMonogram } from './extension-monogram';
import { pendingLabel, type ExtensionPendingAction } from './extension-pending';
import { MarketDetailCard, useMarketDetailConfirmation } from './market-detail-dialog';
import { MarketExtensionDevices } from './market-detail-extension-devices';
import { type ConfirmMarketInstall, useConfirmMarketInstall } from './market-detail-install';
import { useVersionHistory } from './use-version-history';
import type { ReactNode } from 'react';

export function MarketExtensionDetail({
  item, installedVersion, icon, lifecycle, pending, pendingPercent, canChangeVersion, onLifecycle, onInstall, onUninstall,
}: {
  item: MarketListItem;
  installedVersion?: string;
  icon?: string;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  canChangeVersion: boolean;
  onLifecycle: () => void;
  onInstall: (ref: MarketSourceRef, confirm: ConfirmMarketInstall) => void;
  onUninstall?: () => void;
}) {
  const { translate, locale } = useSessionMessages();
  const { api } = useLibraryHost().extensions;
  const { manifest, cloud, ref } = item;
  const text = localizedManifestText(manifest, locale);
  const permissions = declaredPermissions(manifest);
  const confirm = useMarketDetailConfirmation();
  const confirmInstall = useConfirmMarketInstall(cloud.version);
  const { state: history, retry: retryHistory } = useVersionHistory(api, manifest.id);
  const listing = useQuery({
    queryKey: ['market-detail-listing', manifest.id, cloud.version],
    queryFn: async () => {
      const result = await api.marketListing({ extensionId: manifest.id, version: cloud.version });
      if (!result.success || !result.data) throw new Error(result.error);
      return result.data;
    },
    retry: false,
  });
  const shots = listing.data?.screenshots;
  const textLanguage = manifestLanguages(manifest, locale)[0]?.locale;
  const about = textLanguage ? listing.data?.about[textLanguage] : undefined;
  const install = (version: string) => onInstall({ extensionId: manifest.id, version }, confirmInstall);

  const uninstall = async () => {
    if (onUninstall && await confirm({
      title: translate('extensions.uninstallConfirmTitle', { name: text.name }),
      description: translate('extensions.uninstallConfirmDescription', { name: text.name }),
      confirmLabel: translate('extensions.uninstallAction'),
      variant: 'destructive',
    })) onUninstall();
  };

  const update = lifecycle?.kind === 'update' ? lifecycle.version : undefined;
  const actions = pending ? (
    <Button disabled aria-busy data-testid="market-detail-primary">
      <Spinner size="sm" />
      {pending === 'installing' && update ? translate('marketDetail.updating') : pendingLabel(pending, translate, pendingPercent)}
    </Button>
  ) : lifecycle?.kind === 'word' ? (
    <span className="text-sm text-foreground-muted" title={lifecycle.title} data-testid="market-detail-primary">{lifecycle.text}</span>
  ) : lifecycle ? (
    <Button data-testid="market-detail-primary" onClick={lifecycle.kind === 'get' ? () => onInstall(ref, confirmInstall) : update ? () => install(update) : onLifecycle}>
      {update ? translate('extensions.updateTo', { version: update })
        : translate(lifecycle.kind === 'get' ? 'extensions.installAction' : lifecycle.kind === 'enable' ? 'extensions.enable' : 'extensions.open')}
    </Button>
  ) : undefined;

  const versionNotice = cloud.newerNeedsApp
    ? translate('extensions.newerNeedsApp', { version: cloud.newerNeedsApp })
    : installedVersion && compareExtensionVersions(cloud.version, installedVersion) > 0
      ? translate('marketDetail.yourVersion', { version: installedVersion })
      : null;
  return (
    <MarketDetailCard
      name={text.name}
      publisher={translate('extensions.official')}
      icon={<ExtensionMonogram name={text.name} iconDataUrl={cloud.iconUrl ?? icon} />}
      actions={actions}
      devices={<MarketExtensionDevices item={item} />}
      facts={[
        { label: translate('extensions.stripVersion'), value: `v${cloud.version}` },
        { label: translate('extensions.factUpdated'), value: shortDate(cloud.publishedAt, locale) },
        { label: translate('extensions.stripNeedsApp'), value: translate('extensions.stripAndUp', { version: cloud.minAppVersion }) },
        { label: translate('extensions.detailPermissions'), value: permissions.length
          ? translate('extensions.stripPermissionsCount', { count: permissions.length })
          : translate('extensions.stripPermissionsNone') },
      ]}
      subtitle={about ? <MarkdownRenderer content={about} onOpenLink={(url) => { confirmOpenExternalLink(url); return true; }} /> : text.subtitle}
      notice={versionNotice ? <p data-testid="market-detail-version-notice" className="w-fit rounded-md bg-background-2 px-2.5 py-1.5 text-sm text-foreground-muted">{versionNotice}</p> : undefined}
      onUninstall={onUninstall && !pending ? () => void uninstall() : undefined}
    >
      {permissions.length > 0 && (
        <DetailSection title={translate('marketDetail.uses')} icon={<KeyRound />}>
          <p className="whitespace-pre-line rounded-2xl border border-border px-4 py-3 text-foreground-muted">
            {describePermissions(manifest, translate)}
          </p>
        </DetailSection>
      )}
      {!!shots?.length && (
        <DetailSection title={translate('extensions.preview')} icon={<Image />}>
          <div className="grid grid-cols-3 gap-3" data-image-gallery="">
            {shots.map((src, index) => (
              <ExpandableImage key={src} className="aspect-[16/10] w-full rounded-xl object-cover object-left-top" src={src} alt={translate('extensions.screenshotOf', { name: text.name, index: index + 1 })} loading="lazy" />
            ))}
          </div>
        </DetailSection>
      )}
      <DetailSection title={translate('extensions.detailVersionHistory')} icon={<History />}>
        <div className="mk-vers overflow-hidden rounded-2xl border border-border px-2">
          <VersionHistorySection
            state={history}
            onReadAgain={retryHistory}
            extensionId={manifest.id}
            installedVersion={installedVersion}
            offeredVersion={cloud.version}
            locale={locale}
            translate={translate}
            onOpenExternal={confirmOpenExternalLink}
            foldedCount={3}
            onInstallVersion={canChangeVersion && !pending ? install : undefined}
          />
        </div>
        <p className="mt-2 text-xs text-foreground-muted">{translate('extensions.pinHint')}</p>
      </DetailSection>
    </MarketDetailCard>
  );
}

function DetailSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-base font-semibold [&>svg]:size-4 [&>svg]:text-foreground-muted">{icon}{title}</h3>
      {children}
    </section>
  );
}
