import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { observer } from 'mobx-react-lite'
import { Folder } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { useDevicesStore } from '@/store/devicesContext'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { useMachineLabel } from '../agent-watch/useMachineLabel'
import { ReadView } from './PhoneMachineView'
import type { PhoneRead } from './usePhoneRead'
import { phoneProjectRows, type PhoneProjectEntry } from './phoneProjectRows'

/** accountProjectsStore 这一刻的读数,按助理库页的读法说(读不到、但有上次的 = 列着上次的、上面一句读不到)。 */
function storeRead(): PhoneRead<null> & { reload: () => void } {
  const reload = () => { void accountProjectsStore.refresh() }
  const { status, error, projects } = accountProjectsStore
  if (status === 'ready') return { state: 'ok', data: null, reload }
  if (status === 'loading') return { state: 'loading', reload }
  const failure = new Error(error ?? 'account projects unreadable')
  return projects.length ? { state: 'ok', data: null, refreshError: failure, reload } : { state: 'error', error: failure, reload }
}

const Stale = () => {
  const { t } = useTranslation('assistant')
  return <span className="text-foreground-error" data-testid="assistant-project-stale">{t('library.stale')}</span>
}

/**
 * 「助理 → 工作区」:项目只读 accountProjectsStore,文件夹只读设备 store 里各台发布的那份(与伙伴、新建页同一份),
 * ❌ 这一页自己再读、再轮询。
 */
export const PhoneProjects = observer(function PhoneProjects({ detail = false,onOpen }: { detail?: boolean; onOpen?: () => void; machine?: unknown }) {
  const { t } = useTranslation('assistant')
  const { devices } = useDevicesStore()
  // 个人助理宿主与新建页、任务页同一个判据(不是助理住在哪:住在人自己电脑上的助理不能把那台的项目藏掉)。
  const { isHome } = useMachineLabel()
  const accountList = accountProjectsStore.projects
  const projects = useMemo(() => phoneProjectRows(accountList,devices,isHome),[accountList,devices,isHome])
  const read = storeRead()
  const [selected, setSelected] = useState<string | null>(null)
  const current = selected ? projects.find(project => project.id === selected) : null
  if (!detail) return <AssistantRow leading={<Folder />} title={t('library.workspace')} testId="assistant-library-workspace" onClick={onOpen}
    detail={read.state === 'ok' ? t('library.items',{ count: projects.length }) : t(read.state === 'error' ? 'library.failed' : 'library.loading')} />
  if (current) return <PhoneProjectIndex project={current} onBack={() => setSelected(null)} />
  return <div className="ta-page" data-testid="assistant-library-page-workspace">
    <PageHead title={t('library.workspace')} />
    <ReadView read={read} failedTitle={t('library.failed')}>{() => projects.length
      ? <AssistantSection>{projects.map(project => <AssistantRow key={project.id} leading={<Folder />} title={project.label}
        detail={project.stale ? <>{project.rootPath ? `${project.rootPath} · ` : null}<Stale /></> : project.rootPath ?? undefined}
        testId={`assistant-project-${project.id}`} onClick={() => setSelected(project.id)} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.noGuguProjects')}</AssistantEmpty>}</ReadView>
  </div>
})

/** Folder identity is part of device_projects; opening a project performs no device request. */
function PhoneProjectIndex({ project,onBack }: { project: PhoneProjectEntry; onBack: () => void }) {
  const { t } = useTranslation('assistant')
  return <div className="ta-page" data-testid="assistant-project-cloud-index">
    <PageHead title={project.label} action={<Button variant="ghost" onClick={onBack}>{t('library.backToIndex')}</Button>} />
    {project.folders.length ? <AssistantSection>{project.folders.map((folder,index) => <AssistantRow key={`${folder.workspaceId}:${index}`}
      leading={<Folder />} title={folder.path.split(/[/\\]/).filter(Boolean).at(-1) ?? folder.path}
      detail={folder.stale ? <>{`${folder.path} · `}<Stale /></> : folder.path} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.emptyContent')}</AssistantEmpty>}
  </div>
}
