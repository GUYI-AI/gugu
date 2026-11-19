import { replica, replicaAccount } from '../../lib/replica'
import { createSelectStore, patch } from '../../lib/selectStore'
import { newestPackageOf } from '../../session/shared/extensions/app-card-state'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { chatPackageCards, newestSharedPackages, packageKey, PackageUnavailableError, readPackageSummary, type PackageCard, type SharedPackage } from './sharedPackages'
import type { ExtensionBundleSummary } from './summarizeExtensionBundle'

/** @@@chat-packages — App packages sent in chats (#6646, 摩擦单 F15 / F21 / F66), as replicas (@@@client-state-model). */

// ── how far a package's bytes have come (④, transient, account-owned) ────────────────────────────────────────────────

/** A key absent = its read reported nothing yet (not "none read"). */
export type PackageProgress = Readonly<Record<string, { done: number; total: number }>>

/** Byte progress of package reads in flight (owner 11-08). Account-owned: cleared on sign-out and account switch. */
export const packageProgress = createSelectStore<PackageProgress>({}, { scope: 'account' })

const noteProgress = (key: string, done: number, total: number) => patch(packageProgress, key, { done, total })
const forgetProgress = (key: string) => patch(packageProgress, key, undefined)

// ── what a package holds ─────────────────────────────────────────────────────────────────────────────────────────

/** Package key → sha256 of a copy this device may keep: a hint for how to read, not part of the value. */
const keptCopies = new Map<string, string>()

export function noteKeptCopy(key: string, sha256: string | null): void {
  if (sha256) keptCopies.set(key, sha256)
}

/** Bytes never change: read once. `{ok: false}` is an answer; bytes not there are an error (❌ remembered as unreadable). */
export const extensionPackageSummary = replica({
  name: 'extensionPackageSummary',
  scope: 'account',
  read: async (_owner: string, key: string): Promise<ExtensionBundleSummary> => {
    try {
      return await readPackageSummary(key, keptCopies.get(key) ?? null, (done, total) => noteProgress(key, done, total))
    } finally {
      forgetProgress(key)
    }
  },
  fresh: Infinity,
})

type SharedAppPackage = { appId: string; manifest: ExtensionManifest; card: PackageCard }

/** The newest package of each App shared in a chat (摩擦单 F15); refreshed by `message_created` (ExtensionForwardHost.tsx). */
export const sharedAppPackages = replica({
  name: 'sharedAppPackages',
  scope: 'account',
  read: async (owner: string, chatId: string): Promise<SharedAppPackage[]> => {
    const cards = await chatPackageCards(chatId, owner)
    if (replicaAccount().id !== owner) throw new Error('The account changed while the chat\'s packages were read')
    // A package whose bytes are not there offers no App (as one this build cannot read); any other failure fails the list.
    const read = await Promise.all(cards.map(async (card) => ({
      card,
      summary: await extensionPackageSummary.fetch(packageKey(card)).catch((error: unknown) => {
        if (error instanceof PackageUnavailableError) return null
        throw error
      }),
    })))
    const packages: SharedPackage[] = read.flatMap(({ card, summary }) => (summary?.ok ? [{ manifest: summary.manifest, card }] : []))
    return newestSharedPackages(packages).map(({ manifest, card }) => ({ appId: manifest.id, manifest, card }))
  },
  fresh: Infinity,
})

// ── the cards on screen (④, transient, interface-owned) ──────────────────────────────────────────────────────────

/** Packages the cards on screen show, by key (F21). Interface-owned: it empties as the cards unmount. */
export const shownPackages = createSelectStore<ReadonlyMap<string, SharedPackage>>(new Map())

export function showPackage(pkg: SharedPackage): () => void {
  const key = packageKey(pkg.card)
  shownPackages.publish(new Map(shownPackages.get()).set(key, pkg))
  shownPackages.notify()
  return () => {
    if (shownPackages.get().get(key) !== pkg) return
    const next = new Map(shownPackages.get())
    next.delete(key)
    shownPackages.publish(next)
    shownPackages.notify()
  }
}

export function newestShownPackage(shown: ReadonlyMap<string, SharedPackage>, id: string): SharedPackage | undefined {
  return newestPackageOf(shown.values(), id)
}
