import { platform } from '@/platform';
import { safeFailureLine } from '../sessions/gugu-reason';
import { log } from '@renderer/utils/logger';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { RowHoverCard } from '@/components/ui/RowHoverCard';
import { RowHoverCardController } from '@/components/ui/rowHoverCardController';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { useReplica, valueOf } from '@/lib/replica';
import { homeDirectory } from '@renderer/lib/machine-paths';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { getWorkspaceForSession } from '@renderer/features/sessions/stores/session-selectors';
import { getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { identityPlace } from './sidebar-identity-place';
import { TailValue } from './sidebar-identity-tail';

/**
 * 侧栏会话行的**身份卡**(#6092,取代 #5818 的「标题就地翻成 agent 名」)。
 *
 * 行上只写得下标题;指针停在行上,行右侧弹出一张卡回答「这一行是谁、在哪」:**Agent 名、设备、文件夹**
 * 三行(设备与文件夹 owner 2026-10-28 加,见 sidebar-identity-place.ts)。值仍是它统一的 agent 名字 ——
 * 一个任务只有一个名字(owner 2026-10-31),所以 ❌ 再摆一行「agent 名」,
 * **整行点一下就复制这一行**。#7334 起卡上不再摆会话 ID 与 agent ID —— 平时拿名字的人用不上两串 ID,
 * 摆着只是多一层要读的东西;要会话 ID 的人主动去拿(行的右键「复制会话 ID」)。
 * 复制出去的是**带标签的这一对**(「Agent 名：X」)—— 单个值离开了标签,粘到哪都读不出它是什么
 * (owner 2026-10-16)。每行各复制各的,❌ 合成一次复制(owner 同日:「复制任务名就是复制任务名」)。
 *
 * 形状(assistant-ui design.md 的浮层与行规):
 *  · 浮层是**举起来的物件**:圆角 --radius-surface+ **一层 lift 影,没有环也没有边**。
 *    ⚠️ 2026-09-22 裁决(Refs #6104):原配方在这一行写的是「+ 一圈 ring-foreground/10」,而下一行
 *    自己就写着「❌ 边框、ring、影三样叠在一条边上」—— 自述与配方互相打脸,代码照着配方写了环。
 *    design.md:「Do not stack a border, a ring, and a shadow on one edge.」浮起来这件事由 lift
 *    一个人说完。底色走仓里 popover 那一格(--popover)。
 *  · 行之间**没有分隔线**:行靠节奏与 hover 底(row-hover)呼吸。
 *  · 标签与值都是正文字(sans),标签 muted;卡上没有标识符,所以没有 mono。
 *  · **没有复制图标**:整行 hover 底就说明它能点,点了就地把值换成「已复制」,1.6s 后收回,❌ 飞到角上的 toast。
 *    图标只在 hover 时露出,却要么占着宽(每张卡最宽的值后面常驻一截看不见的空白,owner 实看:「名字后存在大量空白」),
 *    要么浮在行尾盖住值的结尾 —— 两头都是看得见的毛病,所以不摆。
 *  · 单一点缀色:没有。卡上没有任何一处是「活的」,所以没有蓝。
 *
 * 开合、动效、贴边与「移进卡不收」都是产品统一的行悬浮卡(components/ui/RowHoverCard.tsx),这里只画卡上的三行。
 * 右键菜单开了、行开始被拖了,行自己收卡(sidebar-session-item):那两件事都是「不在看这张卡了」。
 *
 * 显示沿用起名占位投影；复制始终取同一个原名真源。❌ 不挂原生 title。
 */

const COPIED_MS = 1600;

/** 侧栏会话行这一列的悬浮卡:全列同一时刻只有一张。 */
export const sidebarIdentityCard = new RowHoverCardController('sidebar-session');

type RowSpec = {
  key: 'sessionName' | 'device' | 'folder';
  label: string;
  /** null = 这一格没有(文件夹不知道):写 missing 那句且不可复制。 */
  value: string | null;
  /** 卡上显示的那一份(文件夹把主目录缩成 `~`);不给就显示 value。复制出去的始终是 value。 */
  display?: string;
  /** value 为 null 时写什么。 */
  missing?: string;
  /** 放不下时保住结尾:文件夹的最后一段目录名永远露着,截掉的是前面(「~/Codebase/idc…/shop」)。 */
  keepTail?: boolean;
};

export const SidebarIdentityCard = observer(function SidebarIdentityCard({
  projectId,
  sessionId,
  title,
  displayTitle = title,
  anchor,
}: {
  projectId: string;
  sessionId: string;
  title: string;
  displayTitle?: string;
  /** 取行本体。传取值函数:虚拟列表重渲染会换掉行节点,拿着旧节点定位是对着脱离文档的元素算坐标。 */
  anchor: () => Element | null;
}) {
  const { translate } = useSessionMessages();
  const rows: RowSpec[] = [{ key: 'sessionName', label: translate('identityCard.sessionName'), value: title, display: displayTitle }];
  // 在哪:设备 + 文件夹。别的机器上的会话没挂载时没有工作区,只知道项目目录(会话目录那一行不带 cwd)。
  const machine = machineRegistry.machineOf(projectId);
  // This computer's home (the folder row shortens it to `~`); unread or unreadable, the folder is shown in full.
  const localHome = valueOf(useReplica(homeDirectory, machine ? null : [])) ?? null;
  const place = identityPlace({
    deviceLabel: machine ? (remoteHostsStore.device(machine)?.label ?? machine) : translate('task.deviceLocal'),
    workspacePath: getWorkspaceForSession(projectId, sessionId)?.path,
    projectPath: getProjectStore(projectId)?.data?.path,
    home: machine ? remoteHostsStore.homeDir(machine) : localHome,
  });
  rows.push(
    { key: 'device', label: translate('identityCard.device'), value: place.device },
    {
      key: 'folder',
      label: translate('identityCard.folder'),
      value: place.folder,
      display: place.folderDisplay ?? undefined,
      missing: translate('identityCard.folderUnknown'),
      keepTail: true,
    }
  );

  return (
    <RowHoverCard
      card={sidebarIdentityCard}
      rowKey={sessionId}
      anchor={anchor}
      label={translate('identityCard.dialog', { name: displayTitle })}
      className="flex w-max max-w-80 flex-col py-1"
    >
      {/* 宽度跟内容走,封顶 20rem:短名字不再拖着一大截空白(owner 2026-10-16 实看:「占的留白太多了」);
          16rem 时文件夹那一行只剩「~/Codebase/idcard…」,看不到是哪个目录(2026-10-27 实机),放宽一档。 */}
      {rows.map((row) => (
        <IdentityRow key={row.key} row={row} />
      ))}
    </RowHoverCard>
  );
});

function IdentityRow({ row }: { row: RowSpec }) {
  const { translate } = useSessionMessages();
  const copiedLabel = translate('identityCard.copied');
  const [state, setState] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const flash = (next: string) => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), COPIED_MS);
  };

  const copy = async () => {
    if (row.value === null) return;
    try {
      // 带上标签:「Agent 名：X」。分隔符取文案(中文全角「：」,英文「: 」),拼接在这里做 ——
      // ❌ 把会话标题当插值参数塞进文案模板:标题是用户写的任意文字。
      await platform.writeClipboardText(`${row.label}${translate('identityCard.copyKeySeparator')}${row.value}`);
      flash(copiedLabel);
    } catch (error) {
      log.error({ error }, 'sidebar identity copy failed');
      flash(safeFailureLine(String((error as Error)?.message ?? error)));
    }
  };

  // 标签与值同一个字号(owner 2026-09-21:「文字大小不统一」)。标签栏同宽,两行的值左缘对齐;
  // 宽度放得下最长的「Agent 名」即可 —— 原先按「Session ID」留的 5rem,那一行已经没了。
  const labelClass = 'w-16 shrink-0 whitespace-nowrap text-left text-sm leading-5 text-foreground-muted';
  const valueClass = cn('min-w-0 truncate text-left text-sm leading-5', row.value === null && 'text-foreground-passive');

  if (row.value === null) {
    return (
      <div data-identity-row={row.key} className="flex items-center gap-2 px-3 py-1">
        <span className={labelClass}>{row.label}</span>
        <span className={valueClass}>{row.missing}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-identity-row={row.key}
      data-copy-state={state === null ? 'idle' : state === copiedLabel ? 'copied' : 'failed'}
      aria-label={translate('identityCard.copy', { label: row.label })}
      onClick={(event) => {
        // 行本身是会话的点击目标;这里的点击只是复制,❌ 顺带把会话打开或把卡关掉。
        event.stopPropagation();
        void copy();
      }}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left hover:bg-row-hover active:bg-row-press focus-visible:bg-row-hover"
    >
      <span className={labelClass}>{row.label}</span>
      {/* 反馈就地替换值:值与反馈叠在同一格,值只是藏起来仍占着宽,所以点完卡不变窄。 */}
      <span className="grid min-w-0 grid-cols-1">
        {row.keepTail ? (
          <TailValue text={row.display ?? row.value} className={cn('col-start-1 row-start-1', state !== null && 'invisible')} />
        ) : (
          <span className={cn(valueClass, 'col-start-1 row-start-1', state !== null && 'invisible')}>{row.display ?? row.value}</span>
        )}
        <span aria-live="polite" className="min-w-0 whitespace-normal break-words text-left text-sm leading-5 col-start-1 row-start-1 text-foreground-muted">
          {state}
        </span>
      </span>
    </button>
  );
}
