import { AssistantMemoryContent } from '@/components/assistant/AssistantMemoryContent'
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import './phone-memory.css'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatCalendarDate } from '@/i18n/format'
import { Markdown } from '@/components/markdown/Markdown'
import { Button } from '@/components/ui/Button'
import { SquarePen, Trash2 } from '@/lib/icons'
import { isOwnerProfileNote, type MemoryKind } from '@/session/renderer/features/assistant/assistant-files'
import { readMemoryNotes, type MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { PhoneHealth } from './PhoneHealth'
import { PhoneMachineView, ReadView, type OpenedPageProps } from './PhoneMachineView'
import { deleteMemoryNote } from './phoneMemoryData'
import { machineKey, usePhoneRead, type PhoneRead } from './usePhoneRead'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'

type Translate = (key: string, options?: Record<string, unknown>) => string
type NotesRead = PhoneRead<{ notes: MemoryEntry[]; index: string | null }> & { reload: () => void }

function kindLabel(kind: MemoryKind, t: Translate, name: string): string {
  if (kind === 'user') return t('memory.filter.user')
  if (kind === 'feedback') return t('memory.filter.assistant', { name })
  if (kind === 'project') return t('memory.kind.project')
  if (kind === 'reference') return t('memory.kind.reference')
  return t('memory.filter.other')
}

function useTime() {
  const { i18n } = useTranslation('assistant')
  return (iso: string | null) =>
    iso ? formatCalendarDate(new Date(iso), i18n.language) : ''
}

/**
 * The phone's own screens under 记忆 (the assistant App draws 记忆 itself): the 健康 page (`gugu.assistant.open(…, "health")`),
 * and the note its rows open (`note:<文件名>`: the full text, edit in chat, delete).
 */
export function PhoneMemory(props: PhonePageProps) {
  const { sub, machine } = props
  const ready = machine.state === 'ready' ? machine.machine : null
  // 健康页与它点开的那一条共用一份读数(它记的 health_* 几条)。
  const notes = usePhoneRead(ready ? `memory|${machineKey(ready)}` : null, () => readMemoryNotes(ready!), 'read memory')
  if (sub === 'health') return <PhoneHealth {...props} healthNotes={notes} />
  if (sub?.startsWith('note:')) return <MemoryNote {...props} file={sub.slice('note:'.length)} notes={notes} />
  return null
}

/** 一条记忆的全文:正文、在对话中改(只填不发)、删(先确认;连同 MEMORY.md 里指向它的那一行),删完回首页重读。 */
function MemoryNote(props: PhonePageProps & { file: string; notes: NotesRead }) {
  const { t } = useTranslation('assistant')
  const { assistant, machine, notes, file } = props
  const opened = machine.state === 'ready' ? machine.machine : null
  const note = notes.state === 'ok' ? notes.data.notes.find((entry) => entry.file === file) ?? null : null
  if (opened && note) return <MemoryNoteBody {...props} machine={opened} note={note} />
  // 读到之前 / 读不到 / 已经不在了:页头先说是记忆,下面说清是哪一步。
  return (
    <div className="ta-page" data-testid="assistant-memory-detail">
      <PageHead title={t('nav.memory')} />
      <PhoneMachineView machine={machine} name={assistant.display_name}>
        {() => (
          <ReadView read={notes} failedTitle={t('memory.loadFailed')}>
            {() => <AssistantEmpty title={t('memory.goneTitle')}>{t('memory.gone')}</AssistantEmpty>}
          </ReadView>
        )}
      </PhoneMachineView>
    </div>
  )
}

function MemoryNoteBody({ assistant, askInChat, go, notes, machine, note }: OpenedPageProps & { notes: NotesRead; note: MemoryEntry }) {
  const { t } = useTranslation('assistant')
  const time = useTime()
  const [confirming, setConfirming] = useState(false)
  const name = assistant.display_name
  const aboutMe = isOwnerProfileNote(note)
  const title = aboutMe ? t('memory.filter.user') : note.title
  return (
    <div className="ta-page" data-testid="assistant-memory-detail">
      <PageHead title={title} sub={[aboutMe ? null : kindLabel(note.kind, t, name), note.modifiedAt ? t('memory.updated', { time: time(note.modifiedAt) }) : null].filter(Boolean).join(' · ')} />
      <div className="ta-card ta-prose" data-testid="assistant-memory-body">
        <AssistantMemoryContent machine={machine} entry={note}>{(current,error,loading) => error ? <span role="alert">{assistantPanelFailure(error,t)}</span> : loading ? <LoadingIndicator size="inline" /> : <Markdown trust="chat" content={current.body || t('memory.noContent')} />}</AssistantMemoryContent>
      </div>
      <p className="ta-page-sub ta-pad">{t('memory.createdBy', { name })}</p>
      <div className="ta-phone-row-actions">
        <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(aboutMe ? t('memory.editAboutMePrompt') : t('memory.editPrompt', { name: note.title }))} data-testid="assistant-memory-edit">
          <SquarePen />
          {t('memory.editInChat')}
        </Button>
        <Button variant="ghost" className="ta-pill-btn" data-tone="danger" onClick={() => setConfirming(true)} data-testid="assistant-memory-delete">
          <Trash2 />
          {t('common.delete')}
        </Button>
      </div>
      <PhoneConfirmDialog
          open={confirming}
          title={t('memory.deleteTitle')}
          body={t('memory.deleteBody', { name: title })}
          confirmLabel={t('common.delete')}
          failedText={t('memory.deleteFailed')}
          testId="assistant-memory-delete-dialog"
          onClose={() => setConfirming(false)}
          onConfirmed={() => { notes.reload(); go(null) }}
          onConfirm={async () => {
            await deleteMemoryNote(machine, note, () => reportAssistantAppChange(machine, assistant.id, { resource: 'memory', operation: 'removed',
              id: note.path, deviceId: machine.deviceId, before: { name: note.title, path: note.path } }))
          }}
        />

    </div>
  )
}
