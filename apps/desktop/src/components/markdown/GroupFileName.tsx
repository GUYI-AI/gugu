import { displayNameOf } from '@shared/extensions/file-openers'
import { useInstalledApps } from '@/session/renderer/features/extensions/installed-extensions'
import { HERE_HOST } from '../appSlot/hereHost'
import { chatClaimantHere } from './chatClaimant'

/**
 * The words of a link to a group's file, read the way the file list reads that file (摩擦单 F39): a link written as the
 * file's name — the folder App's tools, `gugu.dispatch`'s `refs` — shows it without the suffix an App here claims it
 * by (`guess` for `guess.draw-guess.json`), the whole name on hover. Only what shows changes: the link and the words in
 * the message stay as written; words no App here claims as a file show as they are. By the Apps on this device, as the
 * list is — so two people may read one message differently.
 */
export function GroupFileName({ name }: { name: string }) {
  const installed = useInstalledApps(HERE_HOST)
  // Not known yet (or unreadable): the words as written — the message's own text, not a guess at a claim.
  const claim = installed.state === 'value' ? chatClaimantHere(installed.value, name) : null
  const shown = claim ? displayNameOf(name, claim.suffix) : null
  return shown !== null && shown !== name ? <span title={name}>{shown}</span> : <>{name}</>
}
