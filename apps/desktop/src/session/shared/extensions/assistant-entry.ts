import type { AppPlatform } from './app-platforms';
import { isGuguOwnApp } from './first-run';
import type { ExtensionManifest } from './manifest';
import type { MarketCodeSource } from './market';
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
 * `surface` action granted, and on a phone the binding's phone API (48). The desktop entry switch is to call this same
 * function (or move its trust list here); it must not keep a second copy of the rule.
 */
export const ASSISTANT_APP_ID = 'gugu-assistant';

/** What a host knows of the installed assistant App. */
export interface AssistantAppInstall {
  manifest: Pick<ExtensionManifest, 'id' | 'apiVersion' | 'platforms' | 'contributes' | 'permissions'>;
  origin: string | undefined;
  /** Where in the market its code was, as recorded when it was installed from there; null: no record. */
  marketSource: Pick<MarketCodeSource, 'repo'> | null;
  /** The variant in use: `upstream` unless a fork is switched on (a phone has no forks). */
  activeVariant: string;
  enabled: boolean;
  /** The kind of its main page (`<id>.<tab>`, `installedExtensionsStore.mainTabOf`); null: it has none. */
  mainTabKind: string | null;
}

export type AssistantLayerEntry =
  | { entry: 'app'; extensionId: string; tabKind: string; binding: string }
  | { entry: 'built-in'; reason: string };

/** Why the installed App is not the product's assistant App to trust, or null. */
export function assistantAppDistrust(install: AssistantAppInstall): string | null {
  if (install.manifest.id !== ASSISTANT_APP_ID) return `it is ${install.manifest.id}, not ${ASSISTANT_APP_ID}`;
  if (install.origin !== 'market') return `it was installed from ${install.origin ?? 'an unrecorded place'}, not the market`;
  if (!install.marketSource) return 'there is no record of where in the market its code was';
  if (!isGuguOwnApp(install.marketSource)) return `its code is at ${install.marketSource.repo}, not in gugu's market repository`;
  if (install.activeVariant !== 'upstream') return `its fork "${install.activeVariant}" is in use`;
  if (!install.enabled) return 'it is switched off';
  return null;
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
