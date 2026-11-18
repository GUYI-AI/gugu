import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useProjectFolders, type ShownFolder } from '@renderer/features/projects/components/main-panel/project-folders';

/**
 * 项目选择器 › 里读一个项目的文件夹(各台机器合计;读不到的那台用账号上记着的、标离线)。
 * 只在 › 展开时才挂上 —— 读它要问各台机器,❌ 选择器里每一行都先读一遍。
 */
export function useProjectPickerFolders(rowId: string): { folders: readonly ShownFolder[]; readFailed: boolean; reading: boolean } {
  const state = useProjectFolders(rowId, sidebarStore.projectMembersOf(rowId));
  return { folders: state.folders ?? [], readFailed: state.loadError, reading: state.folders === null && !state.loadError };
}
