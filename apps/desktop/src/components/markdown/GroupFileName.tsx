import { useMemo } from 'react'
import { displayNameOf } from '@shared/extensions/file-openers'
import { mobxReadable } from '@/lib/mobxReadable'
import { useSelect } from '@/lib/selectStore'
import { chatClaimantHere } from './chatClaimant'

/**
 * The words of a link to a group's file, read the way the file list reads that file (摩擦单 F39): a link written as the
 * file's name — the folder App's tools, `gugu.dispatch`'s `refs` — shows it without the suffix an App here claims it
 * by (`guess` for `guess.draw-guess.json`), the whole name on hover. Only what shows changes: the link and the words in
 * the message stay as written; words no App here claims as a file show as they are. By the Apps on this device, as the
 * list is — so two people may read one message differently.
 */
export function GroupFileName({ name }: { name: string }) {
  // The installed Apps' claims (a MobX store until it becomes a replica), read through the MobX adapter.
  const claims = useMemo(() => mobxReadable(() => {
    const claim = chatClaimantHere(name)
    return claim ? displayNameOf(name, claim.suffix) : null
  }), [name])
  const shown = useSelect(claims, (value) => value, Object.is)
  return shown !== null && shown !== name ? <span title={name}>{shown}</span> : <>{name}</>
}
