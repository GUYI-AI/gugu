import { useState } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { PaneHeader } from '../ui/Pane'
import { Sheet } from '../ui/Sheet'
import { ChevronLeft } from '@/lib/icons'
import './contacts-letter-picker.css'
import { useTranslation } from 'react-i18next'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')

/** 首字母跳转:手机一颗「A–Z」开字母格,桌面贴在列表右缘的一条字母栏(调用方给列表留出右边距)。 */
export function ContactsAzIndex({ mobile, present, onPick }: { mobile: boolean; present: Set<string>; onPick: (letter: string) => void }) {
  if (mobile) return <ContactsLetterPicker present={present} onPick={onPick} />
  return <div className="pointer-events-none absolute inset-y-3 right-1 flex w-4 flex-col items-center justify-center">{LETTERS.map((letter) => { const has = present.has(letter); return <Button variant="ghost" size="sm" key={letter} onClick={() => onPick(letter)} disabled={!has} className={cn('!min-h-[13px] !w-[15px] !p-0 text-[9px]', has ? 'pointer-events-auto text-[var(--muted-fg)]' : 'pointer-events-none text-[var(--text-tertiary)]')}>{letter}</Button> })}</div>
}

/** A touch-sized index replaces 27 tiny hit targets, without changing contact ordering. */
export function ContactsLetterPicker({ present, onPick }: { present: Set<string>; onPick: (letter: string) => void }) {
  const { t } = useTranslation('contacts')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="lg" variant="secondary" className="gg-contacts-letter-trigger" aria-label={t('panel.jumpToLetter')} onClick={() => setOpen(true)}>A–Z</Button>
      {open && <Sheet onClose={() => setOpen(false)} ariaLabel={t('panel.jumpToLetter')} mobileFitContent>
        <div className="gg-contacts-letter-picker">
          <PaneHeader mobile title={t('panel.jumpToLetter')} titleLevel="panel" leading={<IconButton size="md" aria-label={t('panel.backToContacts')} onClick={() => setOpen(false)}><ChevronLeft /></IconButton>} />
          <div className="gg-contacts-letter-grid">
            {LETTERS.map((letter) => <Button key={letter} size="lg" variant="ghost" disabled={!present.has(letter)} onClick={() => { onPick(letter); setOpen(false) }}>{letter}</Button>)}
          </div>
        </div>
      </Sheet>}
    </>
  )
}
