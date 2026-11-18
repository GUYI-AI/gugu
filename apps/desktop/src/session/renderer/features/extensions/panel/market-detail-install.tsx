import { useTranslation } from 'react-i18next';
import { ConsentBody } from '@/components/extensionBundle/ConsentDetails';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { pinsAutoUpdate } from '@shared/extensions/market-entries';
import { type InstallConsentAsk, installConsentPrompt } from '../install-consent';
import { consentPrompt } from '../extension-consent';
import { useMarketDetailConfirmation } from './market-detail-dialog';

export type ConfirmMarketInstall = (
  ask: InstallConsentAsk, asks: boolean, target?: { machine: string; offeredVersion: string },
) => Promise<boolean>;

export function useConfirmMarketInstall(offeredVersion: string): ConfirmMarketInstall {
  const confirm = useMarketDetailConfirmation();
  const { translate, locale } = useSessionMessages();
  const { t } = useTranslation('messaging');
  return (ask, asks, target) => {
    const pins = pinsAutoUpdate(ask.manifest.version, target?.offeredVersion ?? offeredVersion);
    const downgrade = ask.installed && compareExtensionVersions(ask.manifest.version, ask.installed.version) < 0;
    if (!asks && !pins && !downgrade) return Promise.resolve(true);
    const prompt = ask.installed
      ? consentPrompt(ask.installed, ask.revokedPermissions, ask.manifest, translate, locale, ask.market?.releaseNotes, target?.machine)
      : installConsentPrompt(target ? { ...ask, machine: target.machine } : ask, ask.manifest);
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
