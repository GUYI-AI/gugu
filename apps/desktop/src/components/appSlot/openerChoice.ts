import type { InstalledApps } from '../../session/renderer/features/extensions/installed-extensions'
import { localizedManifestText } from '../../session/shared/extensions/catalog'
import type { FileOpenerCandidate } from '../../session/shared/extensions/file-openers'

/** An App as the panel names it to the person: in the interface language, as its manifest says it there. */
export const appNameOf = (candidate: Pick<FileOpenerCandidate, 'app'>, locale: string) => localizedManifestText(candidate.app, locale).name

/** The Apps on this device that may open something: main's list on the desktop, the phone's App store on the phone. */
export const enabledApps = (installed: InstalledApps) => installed.manifests.filter((manifest) => installed.isEnabled(manifest.id))

/**
 * The App kept to open this kind of file (「Always」, 摩擦单 F73), as this window knows it — kept by main on the desktop, by
 * the phone's App store on the phone (`appsHere.setOpenWithDefault`); the replica holds this window's copy of either.
 */
export function rememberedOpener(installed: InstalledApps, key: string): string | null {
  return installed.openWithDefaults[key] ?? null
}
