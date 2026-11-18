import { beforeEach, describe, expect, it } from 'vitest';
import { readInterface, writeInterface } from '@/lib/viewStateTable';
import { createWorkspacePanelChromeStoreForTests } from './workspace-panel-chrome-store';

const STORAGE_KEY = 'gugu.workspace-panel-chrome.v1';

describe('workspacePanelChromeStore', () => {
  beforeEach(() => writeInterface(STORAGE_KEY, undefined));

  it('第一次默认收起;之后记得用户上一次的开合,重启也记得(视图状态表)', () => {
    const first = createWorkspacePanelChromeStoreForTests();
    expect(first.collapsed).toBe(true);

    first.setCollapsed(false);
    expect(readInterface(STORAGE_KEY)).toBe(false);
    expect(createWorkspacePanelChromeStoreForTests().collapsed).toBe(false);
  });
});
