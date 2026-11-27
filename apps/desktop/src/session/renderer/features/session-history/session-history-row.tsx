import { Fragment, type MouseEvent } from 'react';
import { formatCalendarDate } from '@/i18n/format';
import { Trash } from '@/lib/icons';
import type { SessionImportSource } from '@renderer/features/session-import/import-source';
import { SessionPreviewPane } from '@renderer/features/session-import/session-preview-pane';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { cn } from '@renderer/utils/utils';
import { HistoryCheckbox } from './history-checkbox';
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
 * 行上不放(模板行上只有标题与时间)。
 *
 * 批量(owner 2026-11-27 设计稿第 2 稿):勾选框在行**外**左侧那一格(悬停才露;进了多选常显),勾一条就进多选。
 * 进了多选,行右侧的动作钮与垃圾桶都藏起来(位置留着,行不跳)。已归档的行悬停时动作钮左边露一个垃圾桶:
 * 永久删除这一条,不弹框,8 秒内可撤销。未导入的行没有勾选框(要先导入)。
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
  selectable = false,
  picked = false,
  busy = false,
  selecting = false,
  onToggle,
  onDelete,
}: {
  row: SessionHistoryRowData;
  /** 光标:键盘上下移动的那一行。 */
  isSelected: boolean;
  /** 选中底色:只给用户自己点过 / 键盘走到的那一行 —— 光标的缺省落点(第一行)不上色,页面上不常驻一块 live 蓝。 */
  isHighlighted: boolean;
  /** 详情展开在这条下面(本机行 = 原件预览,咕咕行 = 详情)。 */
  isExpanded: boolean;
  /** 点行:没在多选时展开详情;在多选、或按着 ⌘ / Ctrl / Shift 时勾选(由调用方看修饰键定)。 */
  onSelect: (event: MouseEvent<HTMLElement>) => void;
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
  /** 能不能勾(咕咕的活跃 / 已归档行、在问得到的机器上);不能勾就不长勾选框。 */
  selectable?: boolean;
  picked?: boolean;
  /** 正在批量里跑:勾选框摆着但点不了。 */
  busy?: boolean;
  /** 页上已经在多选:勾选框常显,动作钮与垃圾桶藏起来。 */
  selecting?: boolean;
  onToggle?: (event: MouseEvent<HTMLElement>) => void;
  /** 给了才长垃圾桶(已归档行;正在跑永久删除时不给 —— 同一时间只跑一个)。 */
  onDelete?: () => void;
}) {
  const { translate, locale } = useSessionMessages();
  const title = row.title || translate('sessionHistory.untitled');
  return (
    <div data-testid="session-history-item" className="group/item">
      <div
        id={historyOptionId(row.key)}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        data-testid="session-history-row"
        data-row-key={row.key}
        data-source={row.source}
        data-status={row.status}
        data-picked={picked || undefined}
        onClick={onSelect}
        className={cn(
          'group/row relative -mx-4 flex min-h-15 cursor-default items-center gap-3 px-4 py-2 group-first/item:rounded-t-sm group-last/item:rounded-b-sm hover:bg-row-hover active:bg-row-press',
          (picked || (isHighlighted && !selecting)) && 'bg-row-selected'
        )}
      >
        {selectable && onToggle ? (
          // 行外那一格(第 2 稿 .gut):左移 44px,勾选框左对齐 12px;悬停露、多选时常显。
          <div className="absolute top-0 bottom-0 -left-11 flex w-11 items-center pl-3">
            <HistoryCheckbox
              state={picked ? 'on' : 'off'}
              label={translate('sessionHistory.selectRow', { title })}
              onClick={onToggle}
              disabled={busy}
              testId="session-history-checkbox"
              className={cn('transition-opacity duration-100', selecting || picked ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-sm leading-5', row.title ? 'text-foreground' : 'text-foreground-muted')} title={title}>
            {title}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-sm leading-5 text-foreground-muted">
            <time className="truncate tabular-nums" dateTime={new Date(row.updatedAt).toISOString()}>
              {/* 绝对时间、年份总写:列表里一眼要能比先后。 */}
              {formatCalendarDate(row.updatedAt, locale, { includeYear: true })}
            </time>
            {machineLabel ? (
              <span className="min-w-0 shrink truncate" data-testid="session-history-row-machine">
                {machineLabel}
              </span>
            ) : null}
            {offline ? (
              <span className="shrink-0 text-foreground-passive" data-testid="session-history-row-offline">
                {translate('machinePicker.offline')}
              </span>
            ) : null}
          </div>
        </div>
        <div className={cn('flex shrink-0 items-center gap-3', selecting && 'invisible')}>
          {onDelete && row.status === 'archived' && !selecting ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="hidden text-foreground-muted group-hover/row:flex hover:bg-background-destructive hover:text-foreground-destructive focus-visible:flex"
              aria-label={translate('sessionHistory.permanentDeleteTip')}
              title={translate('sessionHistory.permanentDeleteTip')}
              data-testid="session-history-trash"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <Trash className="size-4" />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            className="bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] active:bg-foreground/[0.14]"
            data-testid="session-history-action"
            disabled={actionDisabled || selecting}
            tabIndex={selecting ? -1 : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onAction();
            }}
          >
            {translate(ACTION_MESSAGE_KEY[row.status])}
          </Button>
        </div>
      </div>
      {isExpanded && !selecting ? (
        <div data-testid="session-history-detail" className="-mx-4 bg-foreground/[0.025]">
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
