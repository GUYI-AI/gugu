import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentBytes, cachedAttachmentCopy, sourceKeyOf } from '../../lib/attachmentBytes'
import { chatService } from '../../lib/chat'
import type { AttachmentPackage } from '../../session/shared/extensions/attachment-install'
import { rendererLogger } from '../../lib/log'
import { newestPackageOf } from '../../session/shared/extensions/app-card-state'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { summarizeExtensionBundle, type ExtensionBundleSummary } from './summarizeExtensionBundle'

declare const __APP_VERSION__: string

const log = rendererLogger('chat/extension-bundle')

/**
 * A package sent in a chat, as a card knows it (#7290): where its bytes are — an old card's public URL, or the group
 * folder's item / the message itself (read like any attachment, `attachmentBytes`) — and the message it came in.
 */
export interface PackageCard {
  source: AttachmentSource
  messageId: string
}

/** One package, whichever card shows it: the identity its summary and the cards on screen are kept by. */
export function packageKey(card: PackageCard): string {
  return sourceKeyOf(card.source)
}

/** How an install names it: by its message, old cards and new (the host reads who published it there, #7290). */
export function installPackageOf(card: PackageCard): AttachmentPackage {
  return { messageId: card.messageId }
}

/** The source a package key names back (`packageKey` ∘ this = the key): what its summary is read from. */
export function sourceOfPackageKey(key: string): AttachmentSource {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  if (kind === 'url') return { kind: 'url', url: rest }
  if (kind === 'msg') return { kind: 'message', messageId: rest }
  if (kind === 'attachment') return { kind: 'attachment', attachmentId: rest }
  if (kind === 'item') {
    const at = rest.lastIndexOf('@')
    return { kind: 'item', itemId: rest.slice(0, at), version: Number(rest.slice(at + 1)) }
  }
  throw new Error(`Not a chat package: ${key}`)
}

/**
 * What a package holds, read from its bytes. A copy this device keeps (`sha256`) is read from disk: no signing, no download.
 * `ok: false` (not a package this build reads) is an answer; bytes not there throw `PackageUnavailableError`; neither is kept.
 */
export async function readPackageSummary(key: string, sha256: string | null, progress: (done: number, total: number) => void): Promise<ExtensionBundleSummary> {
  const kept = await cachedAttachmentCopy(sha256).catch(() => null)
  const bytes = kept ? null : await attachmentBytes(sourceOfPackageKey(key), 'full', undefined, undefined, progress)
  if (bytes && bytes.status !== 'ready') throw new PackageUnavailableError(bytes.status)
  const summary = await summarizeExtensionBundle(new Uint8Array(await (kept ?? bytes!.blob).arrayBuffer()), __APP_VERSION__)
  if (!summary.ok) log.warn({ package: key, problem: summary.problem }, 'extension package in chat could not be read')
  return summary
}

/** A package's bytes are not there (deleted from the group folder, expired, missing): no App to offer from it. */
export class PackageUnavailableError extends Error {
  constructor(status: string) {
    super(`the package is not in the group folder (${status})`)
    this.name = 'PackageUnavailableError'
  }
}

/** A package somebody sent in a chat: the App it holds, and its card. */
export interface SharedPackage {
  manifest: ExtensionManifest
  card: PackageCard
}

/** The `.guguext` cards among this chat's attachments, newest first. */
export async function chatPackageCards(chatId: string, userId: string): Promise<PackageCard[]> {
  return (await chatService.getChatFiles(chatId, userId)).flatMap((file) =>
    /\.guguext$/i.test(file.fileName) && file.source.kind !== 'gone' ? [{ source: file.source, messageId: file.messageId }] : [],
  )
}

/** The newest package of each App among these (摩擦单 F15 / F21): one per App id, the highest version. */
export function newestSharedPackages(packages: readonly SharedPackage[]): SharedPackage[] {
  return [...new Set(packages.map((pkg) => pkg.manifest.id))].map((id) => newestPackageOf(packages, id)!)
}
