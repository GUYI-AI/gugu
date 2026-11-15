import { replica } from '../../lib/replica'
import { createSelectStore } from '../../lib/selectStore'
import { observeRendererSession } from '../../lib/sessionPublication'
import { newestPackageOf } from '../../session/shared/extensions/app-card-state'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { chatPackageCards, newestSharedPackages, packageKey, readPackageSummary, type PackageCard, type SharedPackage } from './sharedPackages'
import type { ExtensionBundleSummary } from './summarizeExtensionBundle'

/**
 * @@@chat-packages — App packages sent in chats (#6646, 摩擦单 F15 / F21 / F66), as replicas (@@@client-state-model, PR 3:
 * replaces the `sharedPackages` module store).
 */

// ── how far a package's bytes have come (④, transient, account-owned) ────────────────────────────────────────────────

/** Per package key: bytes read so far and in all. A key absent = its read reported nothing yet (not "none read"). */
export type PackageProgress = Readonly<Record<string, { done: number; total: number }>>

/**
 * The byte progress of the package reads in flight, for every card of that package (owner 11-08: the card says how far).
 * Owned by the signed-in account (it names that account's attachments): cleared on sign-out and account switch.
 */
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
/** The account boundary, as the replica follows it: a real sign-out or another person signing in clears (a session merely absent does not). */
export function followProgressAccount(event: string, account: string | null): void {
  const switched = account !== null ? progressAccount !== null && account !== progressAccount : event === 'SIGNED_OUT'
  if (account !== null || event === 'SIGNED_OUT') progressAccount = account
  if (!switched) return
  packageProgress.publish({})
  packageProgress.notify()
}
observeRendererSession(({ event, session }) => followProgressAccount(event, session?.user.id ?? null))

// ── what a package holds ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A package's summary, keyed by the package (its source key) and the message's record of its bytes: the bytes never change,
 * so it is read once (`fresh: Infinity`) and kept as long as the account. `{ok: false}` is an answer (not a package this
 * build reads, deleted from the folder); a read that failed is the reading's error, read again on retry.
 */
export const extensionPackageSummary = replica({
  name: 'extensionPackageSummary',
  scope: 'account',
  read: async (_owner: string, key: string, sha256: string | null): Promise<ExtensionBundleSummary> => {
    try {
      return await readPackageSummary(key, sha256, (done, total) => noteProgress(key, done, total))
    } finally {
      forgetProgress(key)
    }
  },
  fresh: Infinity,
})

/** One App's newest package shared in a chat. An array (❌ a Map: a replica's value is plain data). */
export type SharedAppPackage = { appId: string; manifest: ExtensionManifest; card: PackageCard }

/**
 * The newest package of each App shared in a chat's messages (摩擦单 F15: the offer in the group's panel; the via-App
 * badge's offer). Log push: an account revision `message_created` with a `.guguext` attachment refreshes the chat
 * (ExtensionForwardHost.tsx). Not kept across restarts (grows with the chat).
 */
export const sharedAppPackages = replica({
  name: 'sharedAppPackages',
  scope: 'account',
  read: async (owner: string, chatId: string): Promise<SharedAppPackage[]> => {
    const cards = await chatPackageCards(chatId, owner)
    const read = await Promise.all(cards.map(async (card) => ({ card, summary: await extensionPackageSummary.fetch(packageKey(card), null) })))
    const packages: SharedPackage[] = read.flatMap(({ card, summary }) => (summary.ok ? [{ manifest: summary.manifest, card }] : []))
    return newestSharedPackages(packages).map(({ manifest, card }) => ({ appId: manifest.id, manifest, card }))
  },
  fresh: Infinity,
})

// ── the cards on screen (④, transient, interface-owned) ──────────────────────────────────────────────────────────

/**
 * The packages the cards on screen show, by package key (F21: an older card says a newer one is here). Owned by the
 * interface (what is drawn now), not the account: it empties as the cards unmount.
 */
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
