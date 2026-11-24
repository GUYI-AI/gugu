import { observer } from 'mobx-react-lite';
import { engineLabel } from '@/lib/usage/engineLabel';
import { Avatar } from '@/components/Avatar';
import { SAMPLE_AGENT_SEED } from '@renderer/features/sample-project/sample-project-transcript';
import { openSamplePane, samplePane } from '@renderer/features/sample-project/sample-project-view';
import { sampleProjectContent } from '@renderer/features/sample-project/use-sample-project';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  InnerHeadRowLayout,
  InnerSidebarFoldButton,
  innerSectionEmptyClass,
} from './inner-sidebar-parts';
import { setSidebarFold, sidebarFolds } from './sidebar-folds';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { SidebarGroup, SidebarMenu, sidebarCountClass, sidebarGroupHeaderClass } from './sidebar-primitives';
import { SessionRowShell } from './sidebar-session-row';
import { focusSessionComposer } from './session-keyboard-nav';

/**
 * #2548 示例项目(#709)「周末去杭州」开着时的内层侧栏:与项目那一列同一个样子,内容全在包里(❌ 网络、❌ 模型)。
 * 头一行 = 示例自己(项目封面、名字、「示例」),点它回到那段对话;第二行同群 / 项目那支「✎ 创建智能体」(yangchichi msg:8e07ad26):
 * 它还不是项目,新智能体就从那一块底下的新任务框发(发了才变成项目,#2569),所以这支笔 = 回到那段对话、把光标放进那个框;移除在左边列表它那一行的菜单里;
 * 最右照样一枚收起这一列(收起是全局的,同群 / 项目那一列)。
 * 次序、分区头同群 / 项目那一列:「话题」(没有,写 0 并说一句没有)在上,「智能体」在下、标题旁 ❌ 数。
 * 「智能体」只列对话里真出现的那一个(内容里的 agent),行首是它在对话里那张脸,点它 = 点任务卡(右边看这一趟做了什么);❌ 画谁在跑。
 * 「话题」:示例里没有,说一句没有。
 */
export const SampleInnerSidebar = observer(function SampleInnerSidebar() {
  const { translate, locale } = useSessionMessages();
  const content = sampleProjectContent(locale);
  const taskOpen = samplePane()?.kind === 'task';
  return (
    <>
      <InnerHeadRowLayout
        headKey="sample-project"
        name={translate('projects.sample.name')}
        tag={translate('projects.sample.tag')}
        avatar={<Avatar variant="group" name={translate('projects.sample.name')} seed="sample-project" size={40} />}
        active={!taskOpen}
        onOpen={() => {
          if (taskOpen) openSamplePane(null);
        }}
        trailingButtons={1}
        createAction={{
          label: translate('sidebar.createAgent'),
          onClick: () => {
            openSamplePane(null);
            requestAnimationFrame(() => focusSessionComposer(document.querySelector('[data-sample-composer]') ?? document));
          },
        }}
      >
        <InnerSidebarFoldButton />
      </InnerHeadRowLayout>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-region="inner-sidebar-scroll">
        <SampleTopicsSection />
        <SampleAgentsSection agent={content.agent} active={taskOpen} />
      </div>
    </>
  );
});

const SampleAgentsSection = observer(function SampleAgentsSection({ agent, active }: { agent: { name: string; engine: string }; active: boolean }) {
  const { translate } = useSessionMessages();
  const collapsed = sidebarFolds.has('inner:agents');
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="agents">
      <div className={sidebarGroupHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.agents')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setSidebarFold('inner:agents', !collapsed)}
            ariaLabel={translate(collapsed ? 'sidebar.expandAgents' : 'sidebar.collapseAgents')}
          />
        </span>
      </div>
      {collapsed ? null : (
        <SidebarMenu className="pb-1" data-inner-rows="">
          <SessionRowShell
            sessionId={SAMPLE_AGENT_SEED}
            rowVariant="section"
            depth={0}
            hasChildren={false}
            expanded={false}
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
});

const SampleTopicsSection = observer(function SampleTopicsSection() {
  const { translate } = useSessionMessages();
  const collapsed = sidebarFolds.has('inner:topics');
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="topics">
      <div className={sidebarGroupHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.topics')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setSidebarFold('inner:topics', !collapsed)}
            ariaLabel={translate(collapsed ? 'sidebar.expandTopics' : 'sidebar.collapseTopics')}
          />
          <span className={sidebarCountClass}>0</span>
        </span>
      </div>
      {collapsed ? null : <div className={innerSectionEmptyClass}>{translate('sidebar.noTopics')}</div>}
    </SidebarGroup>
  );
});
