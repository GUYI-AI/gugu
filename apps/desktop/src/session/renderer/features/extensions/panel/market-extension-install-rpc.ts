import type { MarketSourceRef } from '@shared/extensions/market';
import type { InstallConsentAsk } from '../install-consent';
import type { ExtensionsApi } from '../extensions-host';

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
