import { useTranslation } from 'react-i18next';
import { ConsentBody } from '@/components/extensionBundle/ConsentDetails';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { pinsAutoUpdate } from '@shared/extensions/market-entries';
import type { MarketSourceRef } from '@shared/extensions/market';
import { type InstallConsentAsk, installConsentPrompt } from '../install-consent';
import type { ExtensionsApi } from '../extensions-host';
import { useMarketDetailConfirmation } from './market-detail-dialog';

type InstallApi = Pick<ExtensionsApi, 'installFromMarket'>;

export async function prepareMarketInstall(api: InstallApi, ref: MarketSourceRef) {
  const result = await api.installFromMarket({ ref, consent: { kind: 'return' } });
  if (!result.success || !result.data) throw new Error(result.error);
  if (result.data.outcome !== 'ask') throw new Error('Market install preparation did not return a package');
  return result.data;
}

export async function commitMarketInstall(api: InstallApi, ask: InstallConsentAsk) {
  const result = await api.installFromMarket({
    ref: { extensionId: ask.manifest.id, version: ask.manifest.version },
    consent: { kind: 'given', digest: ask.manifestDigest },
  });
  return {
    success: !!result.success && result.data?.outcome === 'confirmed',
    error: result.error,
  };
}

export type ConfirmMarketInstall = (ask: InstallConsentAsk, asks: boolean) => Promise<boolean>;

export function useConfirmMarketInstall(offeredVersion: string, machine?: string): ConfirmMarketInstall {
  const confirm = useMarketDetailConfirmation();
  const { translate } = useSessionMessages();
  const { t } = useTranslation('messaging');
  return (ask, asks) => {
    const pins = pinsAutoUpdate(ask.manifest.version, offeredVersion);
    const downgrade = ask.installed && compareExtensionVersions(ask.manifest.version, ask.installed.version) < 0;
    if (!asks && !pins && !downgrade) return Promise.resolve(true);
    const prompt = installConsentPrompt(machine ? { ...ask, machine } : ask, ask.manifest);
    return confirm({
      ...prompt,
      description: (
        <>
          {ask.installed || !prompt.details ? prompt.description : <ConsentBody description={prompt.description} details={prompt.details} />}
          {pins && <p className="mt-2 text-foreground-muted">{translate('extensions.pinHint')}</p>}
          {ask.given && <p className="mt-2 text-foreground-muted">{ask.given.first
            ? t('chatArea.appEnable.devicesHint')
            : t('chatArea.appEnable.addsChat', { name: ask.given.chat.name })}</p>}
        </>
      ),
    });
  };
}
