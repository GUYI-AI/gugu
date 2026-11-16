import { replica, replicaAccount } from '../../lib/replica'
import { createSelectStore } from '../../lib/selectStore'
import { observeRendererSession } from '../../lib/sessionPublication'
import { newestPackageOf } from '../../session/shared/extensions/app-card-state'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { chatPackageCards, newestSharedPackages, packageKey, PackageUnavailableError, readPackageSummary, type PackageCard, type SharedPackage } from './sharedPackages'
import type { ExtensionBundleSummary } from './summarizeExtensionBundle'

/** @@@chat-packages — App packages sent in chats (#6646, 摩擦单 F15 / F21 / F66), as replicas (@@@client-state-model). */

// ── how far a package's bytes have come (④, transient, account-owned) ────────────────────────────────────────────────

/** Per package key: bytes read so far and in all. A key absent = its read reported nothing yet (not "none read"). */
export type PackageProgress = Readonly<Record<string, { done: number; total: number }>>

/** Byte progress of package reads in flight (owner 11-08). Account-owned: cleared on sign-out and account switch. */
export const packageProgress = createSelectStore<PackageProgress>({})

function noteProgress(key: string, done: number, total: number): void {
  packageProgress.publish({ ...packageProgress.get(), [key]: { done, total } })
  packageProgress.notify()
}

function forgetProgress(key: string): void {
  if (!(key in packageProgress.get())) return
  const { [key]: _done, ...rest } = packageProgress.get()
  packageProgress.publish(rest)
  packageProgress.notify()
}

let progressAccount: string | null = null
/** A real sign-out or another account signing in clears (a session merely absent does not), as the replica does. */
export function followProgressAccount(event: string, account: string | null): void {
  const switched = account !== null ? progressAccount !== null && account !== progressAccount : event === 'SIGNED_OUT'
  if (account !== null || event === 'SIGNED_OUT') progressAccount = account
  if (!switched) return
  packageProgress.publish({})
  packageProgress.notify()
}
observeRendererSession(({ event, session }) => followProgressAccount(event, session?.user.id ?? null))

// ── what a package holds ─────────────────────────────────────────────────────────────────────────────────────────

/** Package key → sha256 of a copy this device may keep (noted by the card): a hint for how to read, not part of the value. */
const keptCopies = new Map<string, string>()

export function noteKeptCopy(key: string, sha256: string | null): void {
  if (sha256) keptCopies.set(key, sha256)
}

/**
 * A package's summary by its source key; the bytes never change, so read once. `{ok: false}` (not a package this build
 * reads) is an answer; bytes not there or not read are an error, read again on retry (❌ remembered as unreadable).
 */
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

/** One App's newest package shared in a chat. An array (❌ a Map: a replica's value is plain data). */
export type SharedAppPackage = { appId: string; manifest: ExtensionManifest; card: PackageCard }

/** The newest package of each App shared in a chat (摩擦单 F15); refreshed by `message_created` (ExtensionForwardHost.tsx). */
export const sharedAppPackages = replica({
  name: 'sharedAppPackages',
  scope: 'account',
  read: async (owner: string, chatId: string): Promise<SharedAppPackage[]> => {
    const cards = await chatPackageCards(chatId, owner)
    // The summaries are read and kept for the account signed in now: another one since the cards were read ⇒ ❌ go on.
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

/** A card showing this package; the returned function takes it back. */
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

/** The newest package of this App among the cards on screen. */
export function newestShownPackage(shown: ReadonlyMap<string, SharedPackage>, id: string): SharedPackage | undefined {
  return newestPackageOf(shown.values(), id)
}
