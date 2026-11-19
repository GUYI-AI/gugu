import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { observer } from 'mobx-react-lite'
import { Folder } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { groupFoldersStore, type GroupWithFolders } from '@/session/renderer/features/folders/group-folders-store'
import { ReadView } from './PhoneMachineView'
import type { PhoneRead } from './usePhoneRead'

/** groupFoldersStore at this moment, as the assistant library reads things (unreadable but read before = the last list, with a line). */
function storeRead(): PhoneRead<null> & { reload: () => void } {
  const reload = () => { void groupFoldersStore.refresh() }
  const { status, error, groups } = groupFoldersStore
  if (status === 'ready') return { state: 'ok', data: null, reload }
  if (status === 'loading') return { state: 'loading', reload }
  const failure = new Error(error ?? 'group folders unreadable')
  return groups.length ? { state: 'ok', data: null, refreshError: failure, reload } : { state: 'error', error: failure, reload }
}

const Stale = () => {
  const { t } = useTranslation('assistant')
  return <span className="text-foreground-error" data-testid="assistant-project-stale">{t('library.stale')}</span>
}

/**
 * 「助理 → 工作区」: the groups with a folder on my machines (groupFoldersStore, the same list as the group picker), each
 * with its folders. `onOpenGroup` = open the group (the desktop); absent = the group's folders listed here (the phone).
 */
export const PhoneProjects = observer(function PhoneProjects({ detail = false, onOpen, onOpenGroup }: { detail?: boolean; onOpen?: () => void; machine?: unknown; onOpenGroup?: (chatId: string) => void }) {
  const { t } = useTranslation('assistant')
  const groups = groupFoldersStore.groups
  const read = storeRead()
  const [selected, setSelected] = useState<string | null>(null)
  const current = selected ? groups.find(group => group.chatId === selected) : null
  if (!detail) return <AssistantRow leading={<Folder />} title={t('library.workspace')} testId="assistant-library-workspace" onClick={onOpen}
    detail={read.state === 'ok' ? t('library.items', { count: groups.length }) : t(read.state === 'error' ? 'library.failed' : 'library.loading')} />
  if (current) return <GroupFolderIndex group={current} stale={groupFoldersStore.status === 'error'} onBack={() => setSelected(null)} />
  return <div className="ta-page" data-testid="assistant-library-page-workspace">
    <PageHead title={t('library.workspace')} />
    <ReadView read={read} failedTitle={t('library.failed')}>{() => groups.length
      ? <AssistantSection>{groups.map(group => {
        const first = group.folders[0]?.path
        const stale = groupFoldersStore.status === 'error' && group.folders.some(folder => folder.offline)
        return <AssistantRow key={group.chatId} leading={<Folder />} title={group.name}
          detail={stale ? <>{first ? `${first} ` : null}<Stale /></> : first}
          testId={`assistant-project-${group.chatId}`} onClick={() => (onOpenGroup ? onOpenGroup(group.chatId) : setSelected(group.chatId))} />
      })}</AssistantSection>
      : <AssistantEmpty>{t('library.noGuguProjects')}</AssistantEmpty>}</ReadView>
  </div>
})

/** A group's folders on my machines; opening it asks no machine. */
function GroupFolderIndex({ group, stale, onBack }: { group: GroupWithFolders; stale: boolean; onBack: () => void }) {
  const { t } = useTranslation('assistant')
  return <div className="ta-page" data-testid="assistant-project-cloud-index">
    <PageHead title={group.name} action={<Button variant="ghost" onClick={onBack}>{t('library.backToIndex')}</Button>} />
    {group.folders.length ? <AssistantSection>{group.folders.map(folder => <AssistantRow key={`${folder.deviceId ?? 'local'}:${folder.id}`}
      leading={<Folder />} title={folder.path.split(/[/\\]/).filter(Boolean).at(-1) ?? folder.path}
      detail={stale && folder.offline ? <>{`${folder.path} `}<Stale /></> : folder.path} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.emptyContent')}</AssistantEmpty>}
  </div>
}
