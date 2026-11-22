import { useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStableHandler } from '@/hooks/useStableHandler'
import { SectionLabel } from '../ui/SectionLabel'
import { sectionCount, type ContactsSection } from './contactsSections'
import { useContactRowRenderers, type ContactsRowHandlers } from './ContactRows'
import { agentFamiliesUnnest, buildAgentForest, useAgentParents } from './contactsAgentTree'
import { AgentFamilies } from './AgentFamilies'
import { ContactsGrid } from './ContactsGrid'
import { DropHighlightLayer } from '@renderer/lib/drop-highlight'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import { sessionSkinClassName } from '../sessionpage/sessionSkin'
import { ContactsAgentSectionState, ContactsGroupSectionState, ContactsPersonSectionState } from './ContactsSectionState'
import { ContactsCreateAgentButton } from './ContactsCreateAgentButton'
import { ContactsPageFrame } from './ContactsPageFrame'

// 右边整块是这一组的总览,全部排在同一套列轨上(ContactsGrid):agent 按派生关系成家族、一个家族一格(AgentFamilies),
// 人和群一行一格。点一行,详情在 ContactsPageFrame 右边那一列抽屉里打开,总览不换页。

const addClass =
  'inline-grid h-[var(--control-h-sm)] w-[var(--control-h-sm)] cursor-pointer place-items-center rounded-[var(--radius-control)] border-0 bg-transparent text-[var(--muted-fg)] hover:bg-[var(--hover)] hover:text-[var(--fg)]'
export function ContactsSectionPane({ section, rows, detail, onCloseDetail, onCreateAgent, onCreateGroup, onAddContact }: {
  section: ContactsSection
  rows: ContactsRowHandlers
  detail: ReactNode | null
  onCloseDetail: () => void
  onCreateAgent?: () => void
  onCreateGroup: () => void
  onAddContact: () => void
}) {
  const { t } = useTranslation('contacts')
  const render = useContactRowRenderers(rows)
  const parents = useAgentParents()
  const forest = buildAgentForest(section.agents, parents)
  // 身份稳定:agent 节点是 memo 的(@@@map-node-memo),换了函数身份等于每次重画所有节点。
  const onSelectAgent = useStableHandler(rows.onSelectContact)
  const agentMenu = useStableHandler(render.agentMenu)
  const empty = sectionCount(section) === 0
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme)
  return (
    <ContactsPageFrame
      testId="contacts-section-pane"
      title={section.title}
      subtitle={t('sectionPane.count', { count: sectionCount(section) })}
      actions={section.primary ? <ContactsCreateAgentButton className={addClass} onCreate={onCreateAgent} /> : undefined}
      drawer={detail}
      onCloseDrawer={onCloseDetail}
    >
      {/* gg-c-sec-body:屏幕外的人行 / 群行跳过布局与绘制(tokens.css @@@contacts-offscreen-rows),几百个群也只画看得见的。 */}
      <div className="gg-c-sec-body">
        {section.kind === 'device' ? (
          <>
            {/* 标题连同 agent 区是一块「回到顶层」的落点;经过节点的拖放归节点(agentNodeDrag),❌ 冒到这里。 */}
            <div data-agent-families-drop {...agentFamiliesUnnest}>
              {section.agents.length > 0 ? <SectionLabel className="!mt-4">{t('sectionPane.agents')} · {section.agents.length}</SectionLabel> : null}
              <AgentFamilies forest={forest} selectedId={rows.selectedContactId} onSelect={onSelectAgent} menuFor={agentMenu}
                pick={rows.selectionMode ? { ids: rows.selectedContactIds, can: (c) => c.owner_user_id === rows.currentUserId } : undefined} />
              {/* 落点高亮那一层另画一份:会话页那份(workspace)在这一页时藏着(content-visibility hidden),画了也看不见。
                  它是会话页的组件,穿会话页的皮(同 SessionModalHost):拒收的红色来自会话页的 token,皮外不生效。 */}
              <div className={sessionSkinClassName(theme)}><DropHighlightLayer /></div>
            </div>
            {section.groups.length > 0 ? <SectionLabel className="!mt-6">{t('sectionPane.groups')} · {section.groups.length}</SectionLabel> : null}
            {section.groups.length > 0 ? <ContactsGrid>{section.groups.map(render.renderGroup)}</ContactsGrid> : null}
            {section.primary ? <ContactsAgentSectionState isEmpty={empty} onCreateAgent={onCreateAgent} page /> : null}
          </>
        ) : section.kind === 'people' ? (
          <ContactsGrid className="!mt-4">
            {section.people.map(render.renderPerson)}
            <ContactsPersonSectionState isEmpty={empty} onAddContact={onAddContact} />
          </ContactsGrid>
        ) : (
          <ContactsGrid className="!mt-4">
            {section.groups.map(render.renderGroup)}
            <ContactsGroupSectionState isEmpty={empty} onCreateGroup={onCreateGroup} />
          </ContactsGrid>
        )}
      </div>
    </ContactsPageFrame>
  )
}
