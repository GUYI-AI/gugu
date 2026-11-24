import { Fragment } from 'react';
import { ListRow } from '@/components/ui/ListRow';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import type { SessionImportSource } from '@renderer/features/session-import/import-source';
import { SessionPreviewPane } from '@renderer/features/session-import/session-preview-pane';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { cn } from '@renderer/utils/utils';
import { LOCAL_SESSION_ENGINE_LABEL } from '@shared/core/session-import/session-import';
import {
  displaySessionTitle,
  type SessionHistoryRow as SessionHistoryRowData,
  type SessionHistorySource,
  type SessionHistoryStatus,
} from '@shared/core/session-history/session-history';

export const STATUS_MESSAGE_KEY: Record<SessionHistoryStatus, SessionMessageKey> = {
  active: 'sessionHistory.statusActive',
  archived: 'sessionHistory.statusArchived',
  'not-imported': 'sessionHistory.statusNotImported',
};

/** 行上的动作按状态定(spec session-page「会话历史」):活跃 → 打开;已归档 → 恢复;未导入 → 导入(沿用导入管道,导完直接进对话)。 */
export const ACTION_MESSAGE_KEY: Record<SessionHistoryStatus, SessionMessageKey> = {
  active: 'sessionHistory.open',
  archived: 'sessionHistory.restore',
  'not-imported': 'sessionHistory.import',
};

/** 「咕咕」是本域 chrome、要本地化;引擎名是 provider 品牌常量,两种语言下逐字相同。 */
export function sourceLabel(
  source: SessionHistorySource,
  translate: (key: SessionMessageKey) => string
): string {
  return source === 'gugu' ? translate('sessionHistory.sourceGugu') : LOCAL_SESSION_ENGINE_LABEL[source];
}

export function historyOptionId(key: string): string {
  return `session-history-option-${key}`;
}

/** 咕咕行的详情(本机行的详情是原件预览 SessionPreviewPane)。 */
function GuguDetail({ row }: { row: SessionHistoryRowData }) {
  const { translate } = useSessionMessages();
  const lines: Array<[SessionMessageKey, React.ReactNode]> = [
    ['sessionHistory.detailStatus', translate(STATUS_MESSAGE_KEY[row.status])],
    [
      'sessionHistory.detailSessionId',
      <span key="id" className="font-mono">
        {row.providerSessionId ?? row.gugu?.sessionId ?? ''}
      </span>,
    ],
    ['sessionHistory.detailProject', row.projectName ?? translate('sessionHistory.groupUnprojected')],
    ['sessionHistory.detailDirectory', row.directory ?? translate('sessionImport.unknownDirectory')],
    ['sessionHistory.detailUpdated', <RelativeTime key="u" value={row.updatedAt} />],
    ['sessionHistory.detailLastPrompt', row.lastPromptAt ? <RelativeTime key="p" value={row.lastPromptAt} /> : null],
    ['sessionHistory.detailAdded', row.addedAt ? <RelativeTime key="a" value={row.addedAt} /> : null],
  ];
  if (row.archivedAt) lines.push(['sessionHistory.detailArchived', <RelativeTime key="r" value={row.archivedAt} />]);
  return (
    <div className="flex flex-col gap-2 p-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {lines.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="text-foreground-tertiary-muted">{translate(key)}</dt>
            <dd className={cn('min-w-0 break-all text-foreground-muted', key === 'sessionHistory.detailDirectory' && row.directory && 'font-mono')}>
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
      {/* 父子范围要说得出(#6083 坑 ④):恢复只恢复这一条,挂在它下面的子会话各自是一行、各自恢复。 */}
      {row.childCount > 0 ? (
        <p className="text-xs leading-relaxed text-foreground-tertiary-muted">
          {translate('sessionHistory.childScope', { count: row.childCount })}
        </p>
      ) : null}
      {row.parentTitle ? (
        <p className="text-xs leading-relaxed text-foreground-tertiary-muted">
          {translate('sessionHistory.parentOf', { title: displaySessionTitle(row.parentTitle) })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 一条 = 两行 + 右侧一个动作,几何照 设计同事 2026-09-23 的模板图(「已归档的聊天」)逐项量出来:
 * 行高 60px(min-h-15)、左右 16px、标题 13px 正文色、第二行只有时间(13px 次级色)(模板写法「2026年8月20日，19:46」)、
 * 右侧浅灰实心按钮 h-7。行与行之间**不画线**,靠行高节奏与悬停填色分开(docs/design/ui-visual-spec.md §6.6;
 * design.md line budget:「Rows breathe on rhythm and a hover fill, not on dividers」—— 设计同事 2026-09-25)。
 * 状态不另贴标签 —— 动作钮本身就说了(打开 / 恢复 / 导入);session id、agent、父子范围都在详情里,
 * 行上不放(模板行上只有标题与时间)。批量导入在节头 ···,行上不放勾选框。
 */
export function SessionHistoryRow({
  row,
  isSelected,
  isHighlighted,
  isExpanded,
  onSelect,
  onAction,
  previewSource,
  describePreviewError,
  machineLabel,
  offline,
  actionDisabled,
}: {
  row: SessionHistoryRowData;
  /** 光标:键盘上下移动的那一行。 */
  isSelected: boolean;
  /** 选中底色:只给用户自己点过 / 键盘走到的那一行 —— 光标的缺省落点(第一行)不上色,页面上不常驻一块 live 蓝。 */
  isHighlighted: boolean;
  /** 详情展开在这条下面(本机行 = 原件预览,咕咕行 = 详情)。 */
  isExpanded: boolean;
  onSelect: () => void;
  onAction: () => void;
  /** #6264 原件在哪台机器上:预览问那一台。 */
  previewSource: SessionImportSource;
  describePreviewError: (error: unknown) => string;
  /** 这一行在哪台机器上;列表只有一台机器时为 null(不标)。 */
  machineLabel: string | null;
  /** 那台机器离线:这一行来自它的心跳摘要。 */
  offline: boolean;
  /** 离线机器上点不开的那几行(rowOpens 为假)。 */
  actionDisabled: boolean;
}) {
  const { translate } = useSessionMessages();
  const title = row.title || translate('sessionHistory.untitled');
  // 第二行:状态(活跃不写:行本身就是它)· 哪台机器 · 离线 —— 与侧栏行同一种淡色副标题。
  const subtitle = [
    row.status === 'active' ? null : row.status === 'archived' ? translate('sessionHistory.statusArchived')
      : `${translate('sessionHistory.statusNotImported')}${row.local ? ` · ${LOCAL_SESSION_ENGINE_LABEL[row.local.engine]}` : ''}`,
    machineLabel,
    offline ? translate('machinePicker.offline') : null,
  ].filter(Boolean).join(' · ');
  return (
    <div data-testid="session-history-item" className="border-b border-[var(--border)] last:border-b-0">
      {/* 行 = 全 app 那一种列表行(ListRow:侧栏 / 联系人 / 成员同一套几何与悬停),❌ 这一页自己的 60px 两行块。 */}
      <ListRow
        id={historyOptionId(row.key)}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        data-testid="session-history-row"
        data-row-key={row.key}
        data-source={row.source}
        data-status={row.status}
        onClick={onSelect}
        selected={isHighlighted}
        className="group cursor-default"
        leading={
          <span className="flex size-8 items-center justify-center rounded-full bg-[var(--muted)]">
            {row.providerId ? <AgentIcon id={row.providerId} size={16} /> : null}
          </span>
        }
        title={<span className={row.title ? undefined : 'text-foreground-muted'} title={title}>{title}</span>}
        meta={<RelativeTime value={row.updatedAt} compact ago />}
        subtitle={subtitle || undefined}
        trailing={
          <Button
            size="xs"
            variant="ghost"
            className="text-foreground-muted opacity-0 group-hover:opacity-100 group-data-[selected]:opacity-100 focus-visible:opacity-100"
            data-testid="session-history-action"
            disabled={actionDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onAction();
            }}
          >
            {translate(ACTION_MESSAGE_KEY[row.status])}
          </Button>
        }
      />
      {isExpanded ? (
        <div data-testid="session-history-detail" className="bg-foreground/[0.025]">
          <div className="max-h-72 overflow-y-auto">
            {row.local ? (
              <SessionPreviewPane session={row.local} source={previewSource} describeError={describePreviewError} />
            ) : (
              <GuguDetail row={row} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
