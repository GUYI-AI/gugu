import { afterEach, describe, expect, it } from 'vitest';
import {
  droppedDirectoryMention,
  droppedFileItems,
  getDraggedWorkspaceFile,
  hasDraggedWorkspaceFile,
  WORKSPACE_FILE_DRAG_TYPE,
} from '@renderer/lib/drag-files';

function makeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    types: [] as string[],
    files: [] as unknown as FileList,
    effectAllowed: 'all',
    setData(type: string, value: string) {
      if (!values.has(type)) this.types.push(type);
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
  return transfer as unknown as DataTransfer;
}

describe('drag-files', () => {
  // The Folder App's row of a working copy: what its dragstart writes.
  it('reads the workspace row payload a drop receives', () => {
    const dataTransfer = makeDataTransfer();
    const row = { projectId: 'project-1', workspaceId: 'workspace-1', targetPath: '/repo/notes.md' };
    dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify(row));
    expect(hasDraggedWorkspaceFile(dataTransfer)).toBe(true);
    expect(getDraggedWorkspaceFile(dataTransfer)).toEqual(row);

    const folder = makeDataTransfer();
    folder.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify({ ...row, targetPath: '/repo/src', directory: true }));
    expect(getDraggedWorkspaceFile(folder)?.directory).toBe(true);
  });

  it('takes nothing from a transfer without the marker, or with a payload of another shape', () => {
    const plain = makeDataTransfer();
    plain.setData('text/plain', '/repo/notes.md');
    expect(getDraggedWorkspaceFile(plain)).toBeNull();

    const bad = makeDataTransfer();
    bad.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify({ workspaceId: 'w', targetPath: '/a', projectId: 7 }));
    expect(getDraggedWorkspaceFile(bad)).toBeNull();
  });
});

describe('droppedFileItems', () => {
  const fileItem = (file: File, isDirectory: boolean) =>
    ({ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory }) }) as unknown as DataTransferItem;

  // #985 复查:终端拖放靠这个分出文件夹,文件夹照原路径给,不走「存一份」。
  it('marks which dropped items are folders', () => {
    const folder = new File([], 'repro');
    const shot = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    const dataTransfer = { items: [fileItem(folder, true), fileItem(shot, false)], files: [folder, shot] } as unknown as DataTransfer;
    expect(droppedFileItems(dataTransfer)).toEqual([
      { file: folder, directory: true },
      { file: shot, directory: false },
    ]);
  });

  it('treats everything as files when the transfer has no item list', () => {
    const shot = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    expect(droppedFileItems({ files: [shot] } as unknown as DataTransfer)).toEqual([{ file: shot, directory: false }]);
  });
});

describe('droppedDirectoryMention', () => {
  // node 环境没有 preload 注入 —— 直接往桥上放一个只实现 getPathForFile 的假桥。
  function stubHostBridge(pathForFile: (file: File) => string) {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { getPathForFile: pathForFile },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function fakeFolderFile(name: string): File {
    return { name, size: 0, type: '' } as unknown as File;
  }

  it('带本地路径的文件夹 → 一枚 file 提及,显示名是末级目录名', () => {
    stubHostBridge(() => '/Users/owner/Assets/截图存档');
    const mention = droppedDirectoryMention(fakeFolderFile('截图存档'));
    expect(mention).toEqual({
      id: '/Users/owner/Assets/截图存档',
      label: '/Users/owner/Assets/截图存档',
      kind: 'file',
      name: '截图存档',
    });
  });

  it('Windows 路径同样取末级目录名', () => {
    stubHostBridge(() => 'C:\\Users\\owner\\Assets');
    const mention = droppedDirectoryMention(fakeFolderFile('Assets'));
    expect(mention?.name).toBe('Assets');
    expect(mention?.label).toBe('C:\\Users\\owner\\Assets');
  });

  it('取不出路径(空串)→ null,❌ 造一枚指向空的提及', () => {
    stubHostBridge(() => '  ');
    expect(droppedDirectoryMention(fakeFolderFile('dir'))).toBeNull();
  });
});
