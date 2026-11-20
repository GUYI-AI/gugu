import { prepareGroupTask } from '@renderer/features/folders/group-home';
import { applyHistoryEntry } from '@renderer/lib/components/nav-buttons';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { openShellFeedback } from '@renderer/lib/open-shell-feedback';
import { openShellSettings } from '@renderer/lib/open-shell-settings';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { toggleHostTheme } from '@renderer/lib/theme/host-theme';
import { COMMANDS, type CommandId } from '@shared/commands';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { requestShellChatAction } from '@/lib/sidebarChatsBridge';
import { commandRegistry } from './registry';
import type { AppCommand, CommandProvider } from './types';

function appDef<T extends CommandId>(id: T): (typeof COMMANDS)[T] {
  return COMMANDS[id];
}

function createAppCommandProvider(): CommandProvider {
  return {
    scopeId: 'app',

    getCommands(): AppCommand[] {
      // Reads MobX observables — reactions automatically invalidate activeCommands
      // when navigation changes.
      const viewId = appState.navigation.currentViewId;
      const params = appState.navigation.viewParamsStore[viewId] as
        | { sessionId?: string; chatId?: string }
        | undefined;
      // The group being looked at: the chat open, or the group of the session open.
      const groupChatId = viewId === 'chat' ? params?.chatId : params?.sessionId ? sidebarStore.groupOfSession(params.sessionId) : null;

      const settingsDef = appDef('app.settings');
      const marketplaceDef = appDef('app.library');
      const giveFeedbackDef = appDef('app.giveFeedback');
      const toggleThemeDef = appDef('app.toggleTheme');
      const navigateBackDef = appDef('app.navigateBack');
      const navigateForwardDef = appDef('app.navigateForward');

      const commands: AppCommand[] = [
        {
          ...settingsDef,
          // 设置是壳的弹窗:命令只负责打开,关掉是弹窗自己的事(Esc / ✕)。
          execute() {
            openShellSettings();
          },
        },
        {
          ...marketplaceDef,
          execute() {
            revealSessionpage();
            appState.navigation.navigate('apps');
          },
        },
      ];

      const sessionHistoryDef = appDef('app.sessionHistory');
      commands.push({
        ...sessionHistoryDef,
        execute() {
          appState.navigation.navigate('session-history');
        },
      });

      // gugu-dev#181 ⑯ 侧栏上那几个入口在命令面板里也能到:执行的就是那几行点下去的同一件事。
      const scheduledDef = appDef('app.scheduled');
      const newGroupChatDef = appDef('app.newGroupChat');
      const addContactDef = appDef('app.addContact');
      commands.push(
        {
          ...scheduledDef,
          execute() {
            appState.navigation.navigate('automations');
          },
        },
        {
          ...newGroupChatDef,
          execute() {
            requestShellChatAction('create-group');
          },
        },
        {
          ...addContactDef,
          execute() {
            requestShellChatAction('add-contact');
          },
        },
      );

      commands.push({
        ...giveFeedbackDef,
        execute() {
          openShellFeedback();
        },
      });

      commands.push({
        ...toggleThemeDef,
        execute() {
          // @@@task-fusion (#2802) — 从前这里走会话页自己的 app-settings(异步、可能失败,
          // 所以有个失败 toast)。主题收敛成 `<html data-theme>` 一份真值后,翻转就是一次 DOM
          // 写入:同步、不会失败,失败分支跟着一起删。
          toggleHostTheme();
        },
      });

      const newSessionDef = appDef('app.newSession');
      commands.push({
        ...newSessionDef,
        execute() {
          // 在群里:回到这个群,在那里带着第一句话建(#5690)。不在群里:与侧栏「新建任务」同一条路,去新建任务页。
          // ❌ 不开旧的 taskModal —— 那是只填标题 + 关联 issue 的旧残留(behavior session-resume)。
          if (groupChatId) {
            prepareGroupTask(groupChatId);
            appState.navigation.navigate('chat', { chatId: groupChatId });
          } else appState.navigation.navigate('new-session');
        },
      });

      const showKeyboardShortcutsDef = appDef('app.showKeyboardShortcuts');
      commands.push(
        {
          ...navigateBackDef,
          enabled: appState.history.canGoBack,
          hideFromPalette: true,
          execute() {
            appState.history.back(applyHistoryEntry);
          },
        },
        {
          ...navigateForwardDef,
          enabled: appState.history.canGoForward,
          hideFromPalette: true,
          execute() {
            appState.history.forward(applyHistoryEntry);
          },
        },
        {
          ...showKeyboardShortcutsDef,
          execute() {
            showModal('keyboardShortcutsModal', {});
          },
        }
      );

      commands.push(
        { id: 'app.resourceMonitor', execute: () => openShellSettings('resource-monitor') },
      );
      return commands;
    },
  };
}

/**
 * Registers the app-scope CommandProvider. Must be called once at startup.
 * The provider is permanent — it reacts to navigation changes via MobX
 * observables inside getCommands().
 */
export function setupAppCommandProvider(): void {
  commandRegistry.register(createAppCommandProvider());
}
