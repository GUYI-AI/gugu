import type { ReactNode } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { useTranslation } from 'react-i18next'
import { useStableHandler } from '@/hooks/useStableHandler'
import { useHeldOrder, usePointerHold } from '@/lib/heldOrder'
import { SectionLabel } from '../ui/SectionLabel'
import { sectionCount, type ContactsSection } from './contactsSections'
import { useContactRowRenderers, type ContactsRowHandlers } from './ContactRows'
import { buildAgentForest, useAgentParents } from './contactsAgentTree'
import { AgentMindMap } from './AgentMindMap'
import { ContactsAgentSectionState, ContactsGroupSectionState, ContactsPersonSectionState } from './ContactsSectionState'
import { ContactsCreateAgentButton } from './ContactsCreateAgentButton'
import { ContactsPageFrame } from './ContactsPageFrame'

/** 人行 / 群行铺成的多列(分组页、搜索结果同一把)。 */
export const ROW_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-4'

// 版 B「导图 · 全宽」:右边整块是这一组的总览。agent 按派生关系画成导图(AgentMindMap,家族图换行排 + 单个 agent 头像格);
// 人和群铺成多列。点一行,详情在 ContactsPageFrame 右边那一列抽屉里打开,总览不换页。

const contactId = (contact: ContactUser) => contact.id

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
  // agent 已按 agent-order 排好(ContactsPanel);指针在这一页上时按住不挪(lib/heldOrder),离开或停够了一次排到位。
  const pointer = usePointerHold()
  const agents = useHeldOrder(section.agents, contactId, pointer.held)
  const forest = buildAgentForest(agents, parents)
  // 身份稳定:导图节点是 memo 的(@@@map-node-memo),换了函数身份等于每次重画整张图。
  const onSelectAgent = useStableHandler(rows.onSelectContact)
  const agentMenu = useStableHandler(render.agentMenu)
  const empty = sectionCount(section) === 0
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
      <div className="gg-c-sec-body" onPointerMove={pointer.onPointerMove} onPointerLeave={pointer.onPointerLeave}>
        {section.kind === 'device' ? (
          <>
            {section.agents.length > 0 ? <SectionLabel className="!mt-4">{t('sectionPane.agents')} · {section.agents.length}</SectionLabel> : null}
            <AgentMindMap forest={forest} selectedId={rows.selectedContactId} onSelect={onSelectAgent} menuFor={agentMenu}
              pick={rows.selectionMode ? { ids: rows.selectedContactIds, can: (c) => c.owner_user_id === rows.currentUserId } : undefined} />
            {section.groups.length > 0 ? <SectionLabel className="!mt-6">{t('sectionPane.groups')} · {section.groups.length}</SectionLabel> : null}
            <div className={ROW_GRID}>{section.groups.map(render.renderGroup)}</div>
            {section.primary ? <ContactsAgentSectionState isEmpty={empty} onCreateAgent={onCreateAgent} /> : null}
          </>
        ) : section.kind === 'people' ? (
          <div className={`${ROW_GRID} !mt-4`}>
            {section.people.map(render.renderPerson)}
            <ContactsPersonSectionState isEmpty={empty} onAddContact={onAddContact} />
          </div>
        ) : (
          <div className={`${ROW_GRID} !mt-4`}>
            {section.groups.map(render.renderGroup)}
            <ContactsGroupSectionState isEmpty={empty} onCreateGroup={onCreateGroup} />
          </div>
        )}
      </div>
    </ContactsPageFrame>
  )
}
