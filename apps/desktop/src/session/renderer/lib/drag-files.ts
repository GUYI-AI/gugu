import type { MentionItem } from '@gugu/session-ui/react/components';
import { basenameFromAnyPath } from '@shared/path-name';
import { electronApi } from './electron-api';

export function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files');
}

export function getDraggedFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => electronApi().getPathForFile(file).trim())
    .filter(Boolean);
}

/**
 * 拖进来的每一项,和它是不是文件夹。文件夹在 `DataTransfer.files` 里也是一个读不出字节的 File,
 * 只能靠背后的 entry 分辨,而 entry 只在 drop 当下拿得到 —— 在事件里同步调。
 */
export function droppedFileItems(dataTransfer: DataTransfer): { file: File; directory: boolean }[] {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file');
  if (items.length === 0) return Array.from(dataTransfer.files ?? [], (file) => ({ file, directory: false }));
  return items.flatMap((item) => {
    const file = item.getAsFile();
    return file ? [{ file, directory: item.webkitGetAsEntry?.()?.isDirectory === true }] : [];
  });
}

/**
 * 拖进输入框的**文件夹** → 正文里那条路径引用(pill)。
 * 文件夹没有可上传的字节,不进附件通道;agent 要的本就是这条路径。
 * 显示文件夹名,发给 agent 的写法(`@[名字](/绝对路径)`)与路径附件同一种语法。
 * 返回 null = 这件 File 带不出本地路径,没有可插的东西。
 */
export function droppedDirectoryMention(file: File): MentionItem | null {
  const path = electronApi().getPathForFile(file).trim();
  return path ? pathMention(path) : null;
}

/** A path as the composer's `file` pill: the name shown, the path the agent gets. Folders and workspace rows alike. */
export function pathMention(path: string): MentionItem {
  return { id: path, label: path, kind: 'file', name: basenameFromAnyPath(path) || path };
}

/**
 * The Folder App's rows of a working copy carry this MIME type (its JSON travels whole on drop, measured on
 * Electron 44 on Linux and macOS). Custom types must be lowercase; browsers lowercase `DataTransfer.types`.
 */
export const WORKSPACE_FILE_DRAG_TYPE = 'application/x-emdash-workspace-file';

export type DraggedWorkspaceFile = {
  /** The Folder App's rows name their project, so a chat can read the file's bytes where it is. */
  projectId?: string;
  workspaceId: string;
  /** Absolute path in the workspace environment where the target agent runs. */
  targetPath: string;
  /** Remote workspaces are Linux targets even when the renderer runs elsewhere. */
  targetPlatform?: NodeJS.Platform;
  directory?: boolean;
};

/** True when this transfer is tagged as an in-app workspace-file drag. */
export function hasDraggedWorkspaceFile(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORKSPACE_FILE_DRAG_TYPE);
}

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === 'string' && NODE_PLATFORMS.has(value as NodeJS.Platform);
}

function isDraggedWorkspaceFile(value: unknown): value is DraggedWorkspaceFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DraggedWorkspaceFile>;
  return (
    typeof candidate.workspaceId === 'string' &&
    typeof candidate.targetPath === 'string' &&
    (candidate.projectId === undefined || typeof candidate.projectId === 'string') &&
    (candidate.directory === undefined || typeof candidate.directory === 'boolean') &&
    (candidate.targetPlatform === undefined || isNodePlatform(candidate.targetPlatform))
  );
}

export function getDraggedWorkspaceFile(dataTransfer: DataTransfer): DraggedWorkspaceFile | null {
  if (!hasDraggedWorkspaceFile(dataTransfer)) return null;
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE));
    return isDraggedWorkspaceFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
