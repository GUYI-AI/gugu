import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { MessageFilePreviewPanel } from '@/components/chat/MessageFilePreviewPanel';
import { classifyDocumentPreview } from '@/components/chat/documentPreview';
import { forgetSampleProjectOnScreen } from '@renderer/app/screen-layout-actions';
import { screenLayout } from '@renderer/app/screen-layout';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { shellRestoreLaneTaken } from '@renderer/features/sidebar/inner-sidebar-fold';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SampleComposer } from './sample-composer';
import { SampleProjectTranscript, sampleFileBytes } from './sample-project-transcript';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { SampleTaskPane } from './sample-task-pane';
import { openSamplePane, samplePane } from './sample-project-view';
import { sampleProjectContent, useSampleProject } from './use-sample-project';

/**
 * 示例项目「周末去杭州」那一块(#709):和项目那一块同一条页签条(项目名 + 「示例」),下面是项目群里那段真跑过、固化下来的对话。
 * 点文件卡 = 右边看这份文件(群聊同一块预览);点任务卡(或内层侧栏里那个智能体)= 整块换成这一趟它做了什么(#2548)。
 * 底下是和项目里一样的新任务框(#2569):发出第一句,示例就变成这个人自己的项目(SampleComposer)。示例本身全在包里,❌ 读网络、
 * ❌ 调模型。账号上的键读到「不在了」(删了,或已经让给它变成的那个项目),这一块自己收掉。
 */
export const SampleProjectBlock = observer(function SampleProjectBlock({ blockId, blockActions }: { blockId: string; blockActions?: ReactNode }) {
  const { translate, locale } = useSessionMessages();
  const { isLeftOpen, leftRail } = useWorkspaceLayoutContext();
  const sample = useSampleProject();
  const pane = samplePane();
  const corners = screenLayout.corners(blockId);
  const focused = screenLayout.focusedBlockId === blockId;
  const content = sampleProjectContent(locale);
  useEffect(() => {
    if (sample.settled && !sample.shown) forgetSampleProjectOnScreen();
  }, [sample.settled, sample.shown]);
  // 这一块收掉了,右边那一栏跟着关:下次打开从对话开始。
  useEffect(() => () => openSamplePane(null), []);
  const file = pane?.kind === 'file' ? content.files.find((entry) => entry.id === pane.fileId) : undefined;
  const taskOpen = pane?.kind === 'task';
  return (
    <>
      <TabStripShell
        reserveShellRestoreLane={corners.topLeft && shellRestoreLaneTaken(isLeftOpen, leftRail)}
        actionsSlot={<TabBarActionRow atWindowEdge={corners.topRight}>{blockActions}</TabBarActionRow>}
      >
        <TabSlot data-sample-project-tab="">
          <TabChip isActive isFocusedPane={focused} label={translate('projects.sample.name')} hint={translate('projects.sample.tag')} />
        </TabSlot>
      </TabStripShell>
      <div className="relative flex min-h-0 min-w-0 flex-1" data-sample-project-block="">
        {/* #2548 the task takes the whole block, as an agent opened from a project's inner column takes the main area (mock
            v33): beside the inner column a side pane left the conversation a sliver. The conversation stays mounted under
            it as a retained surface (@@@retained-places), so closing the task finds it where it was. */}
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-sample-conversation=""
          style={taskOpen ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}
        >
          {sample.owner ? (
            <SampleProjectTranscript
              content={content}
              owner={sample.owner}
              onOpenFile={(fileId) => openSamplePane({ kind: 'file', fileId })}
              onOpenTask={() => openSamplePane({ kind: 'task' })}
            />
          ) : <div className="min-h-0 flex-1" />}
          {sample.owner ? <SampleComposer ownerId={sample.owner.id} content={content} /> : null}
        </div>
        {file ? (
          <MessageFilePreviewPanel
            file={{ fileName: file.name, sizeBytes: sampleFileBytes(file), mimeType: file.mimeType }}
            kind={classifyDocumentPreview({ fileName: file.name, mimeType: file.mimeType })}
            content={file.text}
            loading={false}
            onClose={() => openSamplePane(null)}
          />
        ) : null}
        {taskOpen ? (
          <SampleTaskPane content={content} onOpenFile={(fileId) => openSamplePane({ kind: 'file', fileId })} onClose={() => openSamplePane(null)} />
        ) : null}
      </div>
    </>
  );
});
