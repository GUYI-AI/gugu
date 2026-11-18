import { observable, runInAction } from 'mobx';
import { screenLayout } from '@renderer/app/screen-layout';
import { isScreenView } from '@renderer/app/screen-views';
import { appState } from '@renderer/lib/stores/app-state';

/** 示例那一块正被看着:这一屏上焦点在它那一块。左边列表那一行据此选中,内层侧栏据此画示例那一列(#2548)。 */
export function sampleProjectInView(): boolean {
  const focused = screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined;
  return focused?.kind === 'sample-project' && isScreenView(appState.navigation.currentViewId);
}

/** 示例那一块右边开着的那一栏:看一份文件,或看那一趟任务(SampleTaskPane);null = 没开。 */
export type SamplePane = { kind: 'file'; fileId: string } | { kind: 'task' } | null;

// 示例在这一屏上只有一块,所以开着哪一栏记在这一处:块里点文件卡 / 任务卡,与内层侧栏点那个智能体写的是同一格。
const pane = observable.box<SamplePane>(null, { deep: false });

export function samplePane(): SamplePane {
  return pane.get();
}

export function openSamplePane(next: SamplePane): void {
  runInAction(() => pane.set(next));
}
