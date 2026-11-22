import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useReplica } from '@/lib/replica';
import { asMounted, getGitRepositoryStore, getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { useCreateSessionCallback } from '@renderer/features/sessions/create-session-modal/use-create-session-callback';
import { useCreateSessionState } from '@renderer/features/sessions/create-session-modal/use-create-session-state';
import { useSessionSettings, type NewTaskSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { Unknown } from '@/components/ui/Unknown';
import { ReadFailedLine } from '@renderer/lib/ui/read-failed-line';
import { messageForUser } from '@/lib/userFacingError';
import { SessionField } from '@renderer/features/sessions/session-config/session-field';
import type { ComposerVerbLook, InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { useInitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { SessionStateProvider } from '@renderer/features/sessions/session-config/session-state-context';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { ComposerProjectPicker } from './composer-context-tray';
import { describeImplicitProjectFailure, machineComposerProps } from './use-machine-create-target';
import { useNewSessionMachine } from '@renderer/features/remote-hosts/use-new-session-machine';
import { useWakeCloudOnInput } from '@renderer/features/remote-hosts/use-wake-cloud-once';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { ComposerTray } from './composer-tray';
import { useRemoteInstallBeforeCreate } from './remote-install-before-create';
import { implicitSessionHome } from './implicit-session-home-project';
import {
  sessionComposerFrameClassName,
  sessionComposerDockBandClassName,
  sessionComposerDockedWidthClassName
} from './session-composer-styles';
import { CreateDeliveryError } from './create-session-modal/create-delivery-error';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from './composer-drafts';
import { prepareGroupTask } from '@renderer/features/folders/group-home';
import { groupFoldersStore } from '@renderer/features/folders/group-folders-store';
import { Illustration } from '@/components/ui/Illustration';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// 新建页与项目首页、会话页共用底部 composer。Project context is optional in the UI.
// The current session-page task model still requires a
// projectId internally, so an unscoped task runs in an isolated app-owned git directory; choosing a
// project replaces that internal context with the selected repository. Projectless sends stay in
// the global Tasks section; selected-project sends stay under that project.

// Exported so the project home and the chat's task dispatch reuse this exact createSession input and submission path;
// the context tray controls are shared too (composer-context-tray.tsx). 新建页在这份共享 composer 上加标题。
export const NewSessionComposer = observer(function NewSessionComposer(props: Omit<NewSessionComposerProps, 'sessionSettings'>) {
  const { settings, reload } = useSessionSettings();
  // The composer seeds its state once: its place is held until these are read (❌ factory defaults a late value cannot change).
  if (settings.state === 'error') return <div className={sessionComposerFrameClassName}><ReadFailedLine message={messageForUser(settings.error)} onRetry={reload} /></div>;
  if (settings.state === 'unknown') return <div className={sessionComposerFrameClassName}><Unknown className="h-[7.5rem] w-full" /></div>;
  return <NewSessionComposerReady {...props} sessionSettings={settings.value} />;
});

type NewSessionComposerProps = Parameters<typeof NewSessionComposerReady>[0];

const NewSessionComposerReady = observer(function NewSessionComposerReady({
  sessionSettings,
  projectId,
  blockReason,
  blocked = false,
  isContextPending,
  groupChatId,
  taskChatId,
  onSessionCreated,
  machine = null,
  draftKey,
  placeholder,
  verb,
  workspaceId,
  preferredProvider,
  sendWithoutProject,
}: {
  projectId: string | undefined;
  // gugu #2525: 非空 = 当前创建上下文不可提交（所选设备离线 / 非本机 / 默认值读写失败）。
  // 挡住发送 + 原样显示原因，❌ 不静默换一台设备把任务建到别处去。
  blockReason?: string | null;
  /**
   * 所选机器此刻用不了(离线 / 休眠 / 正在连…):挡住发送、草稿留着。原因由统一提示条里那台机器的一条说
   * (remote-hosts/machine-notice.ts),❌ 在这里再画一行 —— 它一变输入框就跟着动。
   */
  blocked?: boolean;
  // 默认值读取期间只挡住提交，不渲染独立状态行；真实阻塞仍由 blockReason fail loud。
  isContextPending?: boolean;
  /** @@@group-folders 会话所在的群(它的文件夹挂在这个群上,或在这个群里派的):agent 进这个群。缺省 = 不在任何群里。 */
  groupChatId?: string;
  /** gugu-dev#181 派任务:首句落成这个对话里的一张任务卡,人留在原处;没有 = 建完打开它(见 useCreateSessionCallback)。 */
  taskChatId?: string;
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
  /**
   * #6264 所选机器是另一台(一套工作台:项目就是那台机器上的项目,建会话走同一条路);
   * 那台机器上还没装所选的家时,发送先在那台机器上装好(behavior gugu-server 第 6 条)。null = 本机。
   */
  machine?: { deviceId: string; label: string } | null;
  /**
   * 草稿暂存在 composerDrafts 的哪一格:挂上时读、每次改都写回、发送成功即清。
   * 缺省 = 不暂存,草稿只活在这棵组件里。
   */
  draftKey?: string;
  /** 缺省 = 通用的「发消息」提示;项目页换成它自己那句;给成函数 = 随所选 agent 变。 */
  placeholder?: string | ((agentName: string) => string);
  /** 这一框是「新任务 / 定时任务」:框换色、标签进框(gugu-dev#181)。 */
  verb?: ComposerVerbLook;
  /**
   * #7341 这个项目里从哪个文件夹开工(项目首页的文件夹卡 / 托盘上选的那一个)。
   * 缺省 = 项目根目录。只能是这个项目的文件夹 —— 不是的,主进程建会话时拒掉(fail loud)。
   */
  workspaceId?: string | null;
  preferredProvider?: AgentProviderId;
  /**
   * #2569 这一框发的时候还没有项目(示例项目):按发送交给它 —— 它先把项目建出来,再把这一句交给那个项目的新任务框,
   * 任务在那边按同一条路建。能按 = 有内容、选中了智能体;`blocked` / `blockReason` 照旧挡。
   */
  sendWithoutProject?: (input: InitialSessionState) => void;
  sessionSettings: NewTaskSettings;
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const repositoryWorkspaceId = (projectId ? asMounted(getProjectStore(projectId)) : undefined)?.data.repositoryWorkspaceId ?? null;
  // Repository store warms lazily; touching it keeps parity with the project home / modal.
  if (projectId) void getGitRepositoryStore(projectId);

  const state = useCreateSessionState(
    projectId,
    workspaceId ?? repositoryWorkspaceId,
    undefined,
    null,
    // 这个页面只有一个输入框、没有任务名输入 → 名字必须自己生成,不能受 autoGenerateName 设置摆布。
    // runInProjectDir: 会话直接跑在项目目录,不额外开 worktree(owner 定调:session 就是 task)。
    { requireGeneratedName: true, runInProjectDir: true }
  );
  const { autoApproveByDefault, includeIssueContextByDefault } = sessionSettings;
  const draft = useMemo(() => draftKey ? composerDrafts.forKey(draftKey) : undefined, [draftKey]);
  const initialSession = useInitialSessionState(
    projectId,
    undefined,
    autoApproveByDefault,
    {
      // Selecting or clearing an optional project must not erase text the user has already written.
      resetPromptOnProjectChange: false,
      ...(preferredProvider ? { preferredProvider } : {}),
      // 还没有项目的这一句也是要派进项目群的任务(示例变成的那个项目):照派进群的规矩判。
      dispatchesToChat: Boolean(taskChatId || sendWithoutProject),
      draft,
    }
  );
  // #7199 目标是一台睡着的云电脑:开始输入才叫醒它(光打开新建框 ❌ 叫醒)。
  useWakeCloudOnInput(machine?.deviceId ?? null, `${initialSession.attachments.length}:${initialSession.prompt}`);

  const remoteInstall = useRemoteInstallBeforeCreate(machine, initialSession.provider);
  const { handleCreateSession, canCreate, deliveryError } = useCreateSessionCallback({
    selectedProjectId: projectId,
    state,
    initialSession,
    navigate,
    onClose: () => {},
    onCreated: (result) => {
      onSessionCreated?.(result);
    },
    groupChatId,
    taskChatId,
    beforeCreate: remoteInstall.beforeCreate,
  });
  // 「这一轮带了内容」把附件一并算上:只有附件、没有文字也是一条真首轮(#4325)。
  const hasTurnContent =
    initialSession.prompt.trim().length > 0 || initialSession.attachments.length > 0;
  const canSend =
    (sendWithoutProject ? Boolean(initialSession.provider) : canCreate) &&
    !blocked &&
    !blockReason &&
    !isContextPending &&
    !initialSession.providerError &&
    hasTurnContent &&
    !initialSession.issueContextEditorOpen;
  // #2569 交过来的那一句(示例里发的第一句)人已经按过发送了:这一框一能发就替他发一次。只一次 —— 没成就和任何首句一样,
  // 原因写在框下、话留在框里,等他再按。还没有项目的框(示例自己那一框)❌ 替他发:交出去之后它可能还挂着一拍,
  // 这一格已经挪给项目的框了,在这里发只会没项目可建、把「一能发就发」用掉。
  const handoff = draft?.handoff;
  useEffect(() => {
    if (sendWithoutProject || !draft || !handoff?.sendWhenReady || !canSend) return;
    draft.setHandoff({ ...handoff, sendWhenReady: false });
    handleCreateSession();
  }, [sendWithoutProject, draft, handoff, canSend, handleCreateSession]);
  const submit = sendWithoutProject ? () => { if (canSend) sendWithoutProject(initialSession); } : handleCreateSession;

  // 外层 wrapper 不画描边/圆角/底色(见 session-composer-styles.ts 的 sessionComposerFrameClassName):
  //    卡的形状归 session-ui 的 composerShell 一处管,这里再画一层就会在四角露出第二条线。
  return (
    <div className={sessionComposerFrameClassName}>
      <SessionStateProvider
        workspaceConfig={state.workspaceConfig}
        initialSession={initialSession}
        projectId={projectId}
        hasPR={false}
        includeIssueContextByDefault={includeIssueContextByDefault}
      >
          <SessionField
            placeholder={placeholder ?? translate('composer.messagePlaceholder')}
            verb={verb}
            // Permission profiles are capability-backed and apply to both task and message-page
            // creation. The surface only changes where the created session lands; it must not
            // hide the user's pre-dispatch permission choice.
            showAutoApproveToggle
            onSubmit={submit}
            canSubmit={canSend}
          />
      </SessionStateProvider>
      {/* gugu #2525: 颜色走 --em-* arbitrary value,不用 text-foreground-destructive 这类 color key ——
          session-composer-styles.ts 里实测记过:嵌进 gugu 的会话页子树里 --color-* 家族解析为空,
          Tailwind v4 对未定义 color key 直接不出规则 → 报错文案会**无声**变成普通正文色。
          这是一条 fail-loud 提示,它的可见性本身就是功能的一部分,不能赌。 */}
      {blockReason ? (
        <p
          role="alert"
          className="border-t border-border px-4 py-2 text-xs text-[var(--em-foreground-destructive)]"
        >
          {blockReason}
        </p>
      ) : null}
      {blocked || blockReason ? null : remoteInstall.note}
      <CreateDeliveryError failure={deliveryError} noticeKey={`session-create:${draftKey ?? projectId ?? 'new'}`} />
    </div>
  );
});

type NewSessionPageProps = {
  agentSelection?: { agentId: string; deviceId?: string };
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
};

export const NewSessionPage = observer(function NewSessionPage({
  onSessionCreated,
  agentSelection,
}: NewSessionPageProps) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // An unselected project is a real first-class state, not an alias for projects[0].
  const implicitProject = useReplica(implicitSessionHome, []);
  const implicitProjectId = implicitProject.state === 'value' ? implicitProject.value : undefined;
  const implicitProjectError = implicitProject.state === 'error'
    ? describeImplicitProjectFailure(implicitProject.error, translate)
    : null;

  const effectiveProjectId = implicitProjectId;
  const openGroup = (chatId: string | undefined) => {
    setSelectedId(chatId);
    if (!chatId) return;
    // 人先选了别的机器再选群,而那台机器有这个群的文件夹:进了群就在那台上开(在那台上真建了任务才记上账号)。
    // 机器还是默认的「这台电脑」(没人选过),或那台没有这个群的文件夹(它不是候选):❌ 拿它盖掉这个群记着的机器。
    const machine = remote && groupFoldersStore.foldersOf(chatId).some((folder) => folder.deviceId === remote.deviceId)
      ? remote.deviceId : undefined;
    // gugu-dev#181 ⑩:选群 = 去那个群里开新任务,写好的话跟着进群里新任务框的草稿。
    prepareGroupTask(chatId, NEW_SESSION_DRAFT_KEY, machine);
    navigate('chat', { chatId });
  };

  // 项目入口。原本是贴在输入框左上角的单项页签,现在收进通栏托盘 —— 托盘还同时承载
  // 环境与分支,信息密度换的是"发任务前一眼确认跑在哪"。
  // gugu #2525: 控件本体抽到 composer-context-tray.tsx,与项目页、对话里派任务共用一份。
  // 项目选择器列账号下的全部项目,与机器无关;没选项目时机器选择器定在哪台的任务工作区里跑。
  const { remote, machineContext, devicePicker } = useNewSessionMachine(agentSelection ? agentSelection.deviceId ?? null : undefined);
  const projectPicker = <ComposerProjectPicker selectedId={selectedId} onSelect={openGroup} />;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        {/* 去掉入场滑入(不解释状态变化,只是每次开页都要看的表演)与 `text-xl font-semibold`
            (`.gg-type-page-title` 现在真有定义 20/28/600,别写两遍)。规格 §2 */}
        <NewTaskHero />
      </div>
      <div className={sessionComposerDockBandClassName}>
        <div className={sessionComposerDockedWidthClassName}>
          <ComposerTray
            projectPicker={projectPicker}
            devicePicker={devicePicker}
            host={machineContext?.host ?? machineLibraryHost(null)}
          >
            <NewSessionComposer
              // 换机器 = 换一个创建目标:整棵重挂,上一台机器的选择(agent、模型)不带到下一台;
              // 写好的话经 draftKey 那一格跟着走。
              key={remote?.deviceId ?? 'local'}
              preferredProvider={agentSelection && remote?.deviceId === agentSelection.deviceId ? agentSelection.agentId : undefined}
              draftKey={NEW_SESSION_DRAFT_KEY}
              {...machineComposerProps(machineContext, { projectId: effectiveProjectId })}
              onSessionCreated={onSessionCreated}
            />
          </ComposerTray>
          {implicitProjectError && !selectedId ? (
            <p className="mt-3 text-center text-xs text-foreground-destructive">
              {implicitProjectError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type NewSessionViewParams = { agentId?: string; deviceId?: string };

function NewSessionViewWrapper({ children }: { children: ReactNode } & NewSessionViewParams) {
  return <>{children}</>;
}

function NewSessionMainPanel(): ReactElement {
  const { params: { agentId, deviceId } } = useParams('new-session');
  return <NewSessionPage key={agentId} agentSelection={agentId ? { agentId, deviceId } : undefined} />;
}

export const newSessionView = {
  WrapView: NewSessionViewWrapper,
  TitlebarSlot: ShellTitlebar,
  MainPanel: NewSessionMainPanel,
  transientParams: ['agentId', 'deviceId'],
} satisfies ViewDefinition<NewSessionViewParams>;

// 新任务页的大空白:一张墨线插画 + 一句说明 + 三个起手句(owner 11-22 定:就这三条,前提是产品确实能做到 ——
// 三条都是本机 Codex / Claude 在任意项目或任务工作区里就能做的事)。点一下 = 把那句话放进下面的输入框(与 App 页
// 「对 agent 说」同一条路:composerDrafts),不直接发;输入框里有字了起手句就收起,不和用户自己写的话抢位置。
const STARTERS = [
  ['task.starterExplain', 'task.starterExplainPrompt'],
  ['task.starterFixTest', 'task.starterFixTestPrompt'],
  ['task.starterSummarize', 'task.starterSummarizePrompt'],
] as const;

const NewTaskHero = observer(function NewTaskHero() {
  const { translate } = useSessionMessages();
  const typed = composerDrafts.get(NEW_SESSION_DRAFT_KEY).trim().length > 0;
  return (
    <div className="flex flex-col items-center gap-2 text-center" data-testid="new-task-hero">
      <Illustration name="new-task" className="w-[112px]" />
      {/* `.gg-type-page-title` 是 20/28/600 的页面标题,别再写一遍字号。 */}
      <h1 className="gg-type-page-title mt-3">{translate('task.newTask')}</h1>
      <p className="m-0 text-[length:var(--font-body)] text-[var(--text-secondary)]">{translate('task.newTaskHint')}</p>
      <div className={cn('mt-3 flex flex-wrap justify-center gap-2', typed && 'invisible')} aria-hidden={typed || undefined}>
        {STARTERS.map(([label, prompt]) => (
          <Button key={label} variant="secondary" size="sm" className="rounded-[var(--radius-capsule)]" data-testid="new-task-starter"
            onClick={() => composerDrafts.set(NEW_SESSION_DRAFT_KEY, translate(prompt))}>
            {translate(label)}
          </Button>
        ))}
      </div>
    </div>
  );
});
