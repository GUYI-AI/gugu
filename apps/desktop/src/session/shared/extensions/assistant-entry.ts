import type { AppPlatform } from './app-platforms';
import type { ExtensionManifest } from './manifest';
import { isOfficialMarketSource, type MarketCodeSource } from './market';
import { PHONE_BINDING_API_VERSION } from './phone-binding';
import { BINDING_ACTION_CAPABILITY } from './unread-binding';

/**
 * The one decision "the assistant's place → the product's assistant App, or the built-in pages" (#1925 entry switch). Both
 * hosts ask it with what they know of the installed App; nothing else decides it. Built-in until every condition holds, so a
 * person without the App, or with one that is not the official one, keeps exactly the built-in assistant.
 *
 * Trust is the #1931 rule for the product's assistant App (electron `assistant-rules-trust.ts` on its branch): its id, from
 * the market, its code in gugu's own market repository, no fork in use, switched on. Then what the place needs of it: the
 * platform declared, its main page placed beside the conversation (`contributes.conversationSurface`) with the binding's
 * `surface` action granted, and on a phone the binding's phone API (49). The desktop entry switch is to call this same
 * function (or move its trust list here); it must not keep a second copy of the rule.
 */
export const ASSISTANT_APP_ID = 'gugu-assistant';

/** What a host knows of the installed assistant App. */
export interface AssistantAppInstall {
  manifest: Pick<ExtensionManifest, 'id' | 'version' | 'apiVersion' | 'platforms' | 'contributes' | 'permissions'>;
  origin: string | undefined;
  /** Where in the market its code was, as recorded when it was installed from there; null: no record. */
  marketSource: Pick<MarketCodeSource, 'repo' | 'path'> | null;
  /** The variant in use: `upstream` unless a fork is switched on (a phone has no forks). */
  activeVariant: string;
  enabled: boolean;
  /** The kind of its main page (`<id>.<tab>`, `installedExtensionsStore.mainTabOf`); null: it has none. */
  mainTabKind: string | null;
}

export type AssistantLayerEntry =
  | { entry: 'app'; extensionId: string; tabKind: string; binding: string }
  | { entry: 'built-in'; reason: string };

/** What the trust conditions look at: the installed App's id, where it came from, where its code was, the variant in use. */
export interface AssistantAppProvenance {
  manifest: Pick<ExtensionManifest, 'id' | 'version'>;
  origin: string | undefined;
  marketSource: Pick<MarketCodeSource, 'repo' | 'path'> | null;
  activeVariant: string;
}

/**
 * The one list of conditions for trusting the installed App as the product's assistant App (#1931): each names why it is
 * not. The desktop's rules provider (electron `assistant-rules-trust.ts`) and the assistant's place on both hosts read it.
 * What they record of an install, all: the desktop's rules provider adds the signed release's proof checked again over the
 * bytes on disk (its own, node-side), which a phone does not run.
 */
export const ASSISTANT_APP_TRUST: readonly ((install: AssistantAppProvenance) => string | null)[] = Object.freeze([
  (install: AssistantAppProvenance) => install.manifest.id === ASSISTANT_APP_ID ? null : `it is ${install.manifest.id}, not ${ASSISTANT_APP_ID}`,
  (install: AssistantAppProvenance) => install.origin === 'market' ? null : `it was installed from ${install.origin ?? 'an unrecorded place'}, not the market`,
  (install: AssistantAppProvenance) => !install.marketSource ? 'there is no record of where in the market its code was'
    : isOfficialMarketSource(install.marketSource) ? null : `its code is at ${install.marketSource.repo}, not in gugu's market repository`,
  (install: AssistantAppProvenance) => install.activeVariant === 'upstream' ? null : `its fork "${install.activeVariant}" is in use`,
  (install: AssistantAppProvenance) => {
    const folder = `releases/${ASSISTANT_APP_ID}/${install.manifest.version}`;
    return install.marketSource?.path === folder ? null : `its code is at ${install.marketSource?.path}, not in its signed release folder ${folder}`;
  },
]);

/** Why the installed App is not the product's assistant App to trust (or is switched off), or null. */
export function assistantAppDistrust(install: AssistantAppInstall): string | null {
  for (const condition of ASSISTANT_APP_TRUST) {
    const reason = condition(install);
    if (reason) return reason;
  }
  return install.enabled ? null : 'it is switched off';
}

/** The assistant's place on `platform`: the App's main page (with the binding it is placed beside), or built-in and why. */
export function assistantLayerEntry(install: AssistantAppInstall | null, platform: AppPlatform): AssistantLayerEntry {
  if (!install) return { entry: 'built-in', reason: 'the assistant App is not installed' };
  const distrust = assistantAppDistrust(install);
  if (distrust) return { entry: 'built-in', reason: distrust };
  const { manifest } = install;
  if (!(manifest.platforms ?? []).includes(platform)) return { entry: 'built-in', reason: `it does not declare ${platform}` };
  const surface = manifest.contributes.conversationSurface;
  const binding = manifest.permissions?.bindings?.[0];
  if (!surface || binding?.name !== surface.binding || !binding.actions.includes('surface')) {
    return { entry: 'built-in', reason: 'its main page is not placed beside the conversation' };
  }
  const granted = manifest.permissions?.capabilities ?? [];
  if (!granted.includes(BINDING_ACTION_CAPABILITY.unread) || !granted.includes(BINDING_ACTION_CAPABILITY.surface)) {
    return { entry: 'built-in', reason: 'the conversation binding is not granted' };
  }
  if (platform === 'phone' && manifest.apiVersion < PHONE_BINDING_API_VERSION) {
    return { entry: 'built-in', reason: `its conversation binding on a phone needs apiVersion ${PHONE_BINDING_API_VERSION}` };
  }
  if (!install.mainTabKind?.startsWith(`${manifest.id}.`)) return { entry: 'built-in', reason: 'it has no main page' };
  return { entry: 'app', extensionId: manifest.id, tabKind: install.mainTabKind, binding: surface.binding };
}
