import { useEffect, useMemo } from 'react';
import { deviceSessionsOf, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { SESSION_HISTORY_IMPORT_PART } from '@renderer/features/session-history/session-history-import-part';
import { useSessionHistoryDirectories } from '@renderer/features/session-history/use-session-history';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { LOCAL_SESSION_ENGINE_LABEL } from '@shared/core/session-import/session-import';
import { assistantOf, importOfferShown, listHasNoTasks } from './sidebar-one-list-empty-rule';

/** 会话历史导入那一部分的读法,只问有没有:一节就够(有几节在 matched 里)。 */
const IMPORT_PART_QUERY = { status: SESSION_HISTORY_IMPORT_PART.status, limit: 1 };
/** 只问这台电脑(导入那一部分在这台上的原件);不问 = 一台都不读。 */
const THIS_COMPUTER = [LOCAL_IMPORT_DEVICE];
const NO_MACHINE: readonly string[] = [];
/** 能从哪些工具导入(问句里点名的那几个):导入列表认得的全部引擎,❌ 另抄一份名单。 */
const IMPORTABLE_TOOLS = Object.values(LOCAL_SESSION_ENGINE_LABEL).join(' / ');

/**
 * GUYI-AI/gugu#2548 the one list, under its rows, while the list has no
 * tasks yet (mock v33 新用户): two lines saying what will appear here, in the list's muted note style (as the inner
 * sidebar's empty sections); and when this computer also has sessions from other tools, a dashed box under them that
 * opens 会话历史 at its import part. This computer is asked only while the list has no tasks, with the same reading
 * (useSessionHistoryDirectories on this computer, same status) as that part of the page. Collapsed, the sidebar has no room for either.
 */
export function SidebarOneListEmpty() {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const shell = useAssistantShell();
  const devices = useDirectoryDevices();
  const directory = useLiveDeviceSessions();
  const assistantId = assistantOf(shell);
  const noTasks = useMemo(
    () => listHasNoTasks(devices.map((device) => deviceSessionsOf(device, directory)), assistantId),
    [devices, directory, assistantId]
  );
  const importable = useSessionHistoryDirectories(IMPORT_PART_QUERY, noTasks === true ? THIS_COMPUTER : NO_MACHINE).byMachine[LOCAL_IMPORT_DEVICE];
  const readError = importable?.error ?? null;
  useEffect(() => {
    if (readError) log.error('[sidebar] reading importable sessions failed', { error: readError });
  }, [readError]);
  if (!isLeftOpen || noTasks !== true) return null;
  return (
    <div className="flex flex-col gap-4 px-5 pt-2 pb-4 text-xs leading-relaxed text-foreground-muted" data-sidebar-empty-hint="">
      <div>
        <p className="m-0">{translate('sidebar.emptyHintCreate')}</p>
        <p className="m-0">{translate('sidebar.emptyHintPlace')}</p>
      </div>
      {importOfferShown(noTasks, importable?.page?.matched ?? null) ? (
        <Button
          variant="ghost"
          className="h-auto w-full flex-col items-start rounded-md border-dashed border-border px-3 py-2 text-left text-xs leading-relaxed whitespace-normal text-foreground"
          onClick={() => navigate('session-history', SESSION_HISTORY_IMPORT_PART)}
          data-testid="sidebar-import-offer"
        >
          <span>{translate('sessionHistory.importOffer', { tools: IMPORTABLE_TOOLS })}</span>
          <span>{translate('sessionHistory.importOfferAction')}</span>
        </Button>
      ) : null}
    </div>
  );
}
