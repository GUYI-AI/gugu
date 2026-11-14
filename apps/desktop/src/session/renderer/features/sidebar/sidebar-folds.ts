import { observable, runInAction } from 'mobx';

/**
 * What the user folded away in the sidebar: the left list, the inner column, and the inner column's two sections.
 * Part of the sidebar's stored snapshot (SidebarStore), which is restored before the session tree first draws, so a
 * restart or an update comes back to the same layout. Only the user's own folds live here: hover peek and zen mode are
 * of the moment and are not kept.
 */
export type SidebarFold = 'left' | 'inner' | 'inner:topics' | 'inner:agents';

export const sidebarFolds = observable.set<SidebarFold>();

export function setSidebarFold(fold: SidebarFold, folded: boolean): void {
  runInAction(() => {
    if (folded) sidebarFolds.add(fold);
    else sidebarFolds.delete(fold);
  });
}
