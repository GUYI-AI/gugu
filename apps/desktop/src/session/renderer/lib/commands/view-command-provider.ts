import { comparer, reaction } from 'mobx';
import { registeredViews } from '@renderer/lib/layout/registered-views';
import { appState } from '@renderer/lib/stores/app-state';
import { commandRegistry } from './registry';
import type { CommandProvider } from './types';

/**
 * Wires a MobX reaction that keeps the task-scope CommandProvider in sync with
 * the active view. Must be called once at app startup (after navigation state
 * is restored). No React dependency — runs entirely off MobX observables.
 */
export function setupViewCommandProvider(): void {
  let releaseView: (() => void) | undefined;
  reaction(
    () => {
      const viewId = appState.navigation.currentViewId;
      return { viewId, params: appState.navigation.viewParamsStore[viewId] ?? {} };
    },
    ({ viewId, params }) => {
      releaseView?.();
      const def = (
        registeredViews() as unknown as Record<string, { commandProvider?: (p: unknown) => CommandProvider }>
      )[viewId];
      releaseView = def?.commandProvider ? commandRegistry.register(def.commandProvider(params)) : undefined;
    },
    { fireImmediately: true, equals: comparer.structural }
  );
}
