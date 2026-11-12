import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { engineLabel } from '@/lib/usage/engineLabel';
import { ProjectFolderAvatar } from '@/mobile/partners/ProjectFolderAvatar';
import { SampleProjectRemoveItem, useRemoveSampleProject } from '@renderer/features/sample-project/sample-project-row-menu';
import { SAMPLE_AGENT_SEED } from '@renderer/features/sample-project/sample-project-transcript';
import { openSamplePane, samplePane } from '@renderer/features/sample-project/sample-project-view';
import { sampleProjectContent } from '@renderer/features/sample-project/use-sample-project';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  InnerHeadActionsMenu,
  InnerHeadRowLayout,
  InnerSidebarFoldButton,
  innerSectionEmptyClass,
  innerSectionHeaderClass,
} from './inner-sidebar-parts';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { SidebarGroup, SidebarMenu, sidebarCountClass } from './sidebar-primitives';
import { SessionRowShell } from './sidebar-session-row';

/**
 * #2548 示例项目(#709)「周末去杭州」开着时的内层侧栏:与项目那一列同一个样子,内容全在包里(❌ 网络、❌ 模型)。
 * 头一行 = 示例自己(项目封面、名字、「示例」),点它回到那段对话;只读,所以 ❌ 新智能体那支笔,「…」里只有行菜单那一项(移除);
 * 最右照样一枚收起这一列(收起是全局的,同群 / 项目那一列)。
 * 「智能体」只列对话里真出现的那一个(内容里的 agent),行首是它在对话里那张脸,点它 = 点任务卡(右边看这一趟做了什么);❌ 画谁在跑。
 * 「话题」:示例里没有,说一句没有。
 */
export const SampleInnerSidebar = observer(function SampleInnerSidebar({ ownerId }: { ownerId: string }) {
  const { translate, locale } = useSessionMessages();
  const content = sampleProjectContent(locale);
  const taskOpen = samplePane()?.kind === 'task';
  const removal = useRemoveSampleProject(ownerId);
  return (
    <>
      <InnerHeadRowLayout
        headKey="sample-project"
        name={translate('projects.sample.name')}
        tag={translate('projects.sample.tag')}
        avatar={<ProjectFolderAvatar coverId="sample-project" size={24} />}
        active={!taskOpen}
        onOpen={() => {
          if (taskOpen) openSamplePane(null);
        }}
        trailingButtons={1}
      >
        <InnerHeadActionsMenu label={translate('projects.sample.actions')}>
          <SampleProjectRemoveItem busy={removal.busy} onRemove={() => void removal.remove()} />
        </InnerHeadActionsMenu>
        <InnerSidebarFoldButton />
      </InnerHeadRowLayout>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-region="inner-sidebar-scroll">
        <SampleAgentsSection agent={content.agent} active={taskOpen} />
        <SampleTopicsSection />
      </div>
    </>
  );
});

function SampleAgentsSection({ agent, active }: { agent: { name: string; engine: string }; active: boolean }) {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="agents">
      <div className={innerSectionHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.agents')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandAgents' : 'sidebar.collapseAgents')}
          />
          {/* 标题旁一个数,同群 / 项目那一列(#2548 ⑥)。只读的一段过去:那个 agent 早做完了,❌ 在跑。 */}
          <span className={sidebarCountClass} data-inner-agents-count="">
            1
          </span>
        </span>
      </div>
      {collapsed ? null : (
        <SidebarMenu className="pb-1">
          <SessionRowShell
            sessionId={SAMPLE_AGENT_SEED}
            rowVariant="section"
            depth={0}
            hasChildren={false}
            expanded={false}
            needsAttention={false}
            title={agent.name}
            harness={{ id: agent.engine, name: engineLabel(agent.engine) }}
            agent={{ userId: SAMPLE_AGENT_SEED, name: agent.name, avatarUrl: null }}
            presentation={null}
            lastInteractedAt={null}
            doneUnread={false}
            isActive={active}
            isCursor={false}
            isPendingArchive={false}
            quickActions={null}
            onOpen={() => openSamplePane({ kind: 'task' })}
          />
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}

function SampleTopicsSection() {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="topics">
      <div className={innerSectionHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.topics')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandTopics' : 'sidebar.collapseTopics')}
          />
        </span>
      </div>
      {collapsed ? null : <div className={innerSectionEmptyClass}>{translate('sidebar.noTopics')}</div>}
    </SidebarGroup>
  );
}
