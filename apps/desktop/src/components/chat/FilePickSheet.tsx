import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatCalendarDay, metadataSeparator } from '@/i18n/format'
import { FilePlus2 } from '@/lib/icons'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentTypeKey } from '@gugu/core/shared/ui/attachmentType'
import { FileMark } from '@gugu/session-ui/file-mark'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@/session/shared/extensions/host-actions'
import { fileMatches, type FilePicked } from '@/session/shared/extensions/app-file-pick-core'
import { useMobileShell } from '../../hooks/useMobileShell'
import { ChatPickSheet, type ChatPickRow } from './ChatPickSheet'
import { takeFilePickAsks, type FilePickAsked } from './filePickAsk'

const UPLOAD = 'upload:new'

/**
 * API 62 `gugu.files.pick`: the chat's files the host listed, drawn by the shell over whatever is on screen
 * (ExtensionConsentSheet), in the dispatch sheet's clothes (ChatPickSheet). A file row says what a file in a message says
 * (FileAttachmentCard: its mark, size and kind), with where it is in the folder and when it last changed; newest first,
 * a search keeps the files whose path has it (the host's `files.search` match). One file: a tap picks it. Several: ticked,
 * then the button. 「从电脑添加…」 last, when the host offers it. The App hears only what was picked.
 */
export function FilePickSheet() {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const [asked, setAsked] = useState<FilePickAsked | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const open = useRef<FilePickAsked | null>(null)

  // Answered once: by the person, by running out, or by the next ask taking the sheet.
  const finish = useCallback((picked: FilePicked) => {
    open.current?.answer(picked)
    open.current = null
    setAsked(null)
  }, [])
  useEffect(() => takeFilePickAsks((next) => {
    open.current?.answer(null)
    open.current = next
    setAsked(next)
    setSelected(new Set())
    setQuery('')
  }), [])
  useEffect(() => {
    if (!asked) return
    const timer = setTimeout(() => finish(null), INSTALL_CONSENT_HUMAN_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [asked, finish])

  if (!asked) return null
  const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  const rows: ChatPickRow[] = asked.files.filter((entry) => fileMatches(entry, query)).map((entry) => {
    const type = attachmentTypeKey({ fileName: entry.name, mimeType: entry.contentType })
    return {
      id: entry.id,
      name: entry.name,
      mark: <FileMark name={entry.name} mime={entry.contentType} size={mobile ? 24 : 20} className="shrink-0 self-center text-[var(--text-secondary)]" />,
      hint: [folderOf(entry.path), entry.size === null ? null : formatAttachmentSize(entry.size), type ? t(`attachmentView.types.${type}`) : null].filter(Boolean).join(metadataSeparator()),
      trailing: formatCalendarDay(entry.updatedAt),
    }
  })
  if (asked.upload) rows.push({ id: UPLOAD, name: t(mobile ? 'filePick.uploadPhone' : 'filePick.upload'), mark: <FilePlus2 size={mobile ? 24 : 20} className="shrink-0 self-center text-[var(--text-secondary)]" /> })
  const ids = [...selected]
  return (
    <ChatPickSheet
      title={asked.title ?? t('filePick.title')}
      onClose={() => finish(null)}
      testId="file-pick-sheet"
      rows={rows}
      selected={selected}
      single={!asked.multiple}
      onToggle={(id) => {
        if (id === UPLOAD) return finish({ upload: true })
        if (!asked.multiple) return finish({ ids: [id] })
        setSelected((current) => {
          const next = new Set(current)
          if (!next.delete(id)) next.add(id)
          return next
        })
      }}
      query={query}
      onQuery={setQuery}
      placeholder={t('filePick.search')}
      empty={t('filePick.empty')}
      picked={ids.length > 0 ? t('filePick.picked', { count: ids.length }) : undefined}
      actionLabel={asked.action ?? t('filePick.action')}
      actionDisabled={ids.length === 0}
      onAction={() => finish({ ids })}
    />
  )
}
