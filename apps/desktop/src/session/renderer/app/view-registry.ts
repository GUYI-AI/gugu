import type { ComponentType, ReactNode } from 'react';
import { homeView } from '@renderer/app/home-view';
import { appsView, appView } from '@renderer/features/apps/apps-views';
import { automationsView } from '@renderer/features/automations/automations-view';
import { chatView } from '@renderer/features/chats/view';
import { projectView } from '@renderer/features/projects/view';
import { sessionHistoryView } from '@renderer/features/session-history/session-history-view';
import { newSessionView } from '@renderer/features/sessions/new-session-page';
import { sessionView } from '@renderer/features/sessions/view';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { appState } from '@renderer/lib/stores/app-state';
import { registerViews } from '@renderer/lib/layout/registered-views';

// Define views here so we can use them in the navigate function
export const views = {
  home: homeView,
  automations: automationsView,
  project: projectView,
  // gugu-dev#181 对话也是一块。
  chat: chatView,
  screen: { MainPanel: () => null },
  'session-history': sessionHistoryView,
  session: sessionView,
  'new-session': newSessionView,
  apps: appsView,
  app: appView,
} satisfies Record<string, ViewDefinition<any>>;

export type ViewDefinition<TParams extends object = Record<never, never>> = {
  WrapView?: ComponentType<{ children: ReactNode } & TParams>;
  TitlebarSlot?: ComponentType;
  MainPanel: ComponentType;
  /**
   * Factory called by Workspace whenever this view becomes active.
   * The returned CommandProvider is registered in commandRegistry and
   * unregistered when the view changes or the params change.
   */
  commandProvider?: (params: TParams) => CommandProvider;
  /**
   * Called before navigation to this view is committed. Return { ok: false }
   * to redirect to a different view instead.
   *
   * Receives `unknown` because params can come from persisted snapshots written
   * by older builds, so each guard must validate the shape before using it.
   */
  canActivate?: (params: unknown) => GuardResult;
  /**
   * 只属于**这一次到访**的参数键。其余参数是「上次停在哪」,离开与重启都要记住;
   * 列在这里的键是「这次进去要干什么」的一次性意图,离开该视图即作废、也不从快照恢复。
   * 语义与丢弃时机见 navigation-store 的 `@@@transient-view-params`。
   */
  transientParams?: readonly (keyof TParams & string)[];
  /**
   * Params that say which place inside the view you are at (the Apps page's tab, open App, Installed segment). Two
   * visits with different values are two steps of the back stack, and changing them in place (`setParams`) rewrites the
   * step you are on, so going back returns to where you left it, not to where you came in.
   */
  placeParams?: readonly (keyof TParams & string)[];
  /**
   * @@@page-modal — drawn as a modal over the page you were on, as Settings is (App 市场, one App's page): the task list
   * and the screen stay as they were under it, and closing it returns there.
   */
  modal?: true;
  /** Handle Escape inside a nested page before its modal closes. */
  onModalEscape?: () => boolean;
};

type Views = typeof views;

export type ViewId = keyof Views;

export type WrapParams<TId extends ViewId> = Views[TId] extends {
  WrapView: ComponentType<infer P>;
}
  ? Omit<P, 'children'>
  : Record<never, never>;

export type GuardResult =
  | { ok: true }
  | { ok: false; redirect: ViewId; params?: Record<string, unknown> };

export function setupNavigationGuards(): void {
  registerViews(views as unknown as Parameters<typeof registerViews>[0]);
  for (const [viewId, view] of Object.entries(views) as Array<
    [ViewId, ViewDefinition<Record<string, unknown>>]
  >) {
    appState.navigation.registerView(viewId, { transientParams: view.transientParams, placeParams: view.placeParams, modal: view.modal });
    if (view.canActivate) {
      appState.navigation.registerGuard(viewId, view.canActivate);
    }
  }
}
