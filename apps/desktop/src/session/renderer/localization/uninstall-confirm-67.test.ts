import { describe, expect, it } from 'vitest';
import { enUSMessages, zhCNMessages } from './messages';

/**
 * 摩擦单 F67 (S17): the uninstall sheet said "… along with anything it stored", and the person took it to mean the
 * group's vote would go too — it does not. What uninstall does (extensions controller `uninstall` on the desktop, the
 * phone's App store `uninstall`, L9): the bundle, the page's storage (cookies, localStorage) and its data folder on this
 * device go, with its permission and on/off records; the group's files it opened, its cards in chats and everyone
 * else's installs are not touched. The sheet says both, in the host's language — and says "this device", which is true
 * on the desktop and on the phone alike (one sentence for both, L9).
 */
describe('the uninstall sheet says what goes and what stays (F67)', () => {
  it('English: removed from this device with what it keeps here; group files and others\' copies stay', () => {
    const text = enUSMessages['extensions.uninstallConfirmDescription'];
    expect(text).toContain('{name} and its settings and saved data on this device will be removed');
    expect(text).toContain('Files it opened in chats are not changed');
    expect(text).toContain("other people's copies");
    expect(text, 'no longer the sentence that read as "the group\'s data too"').not.toContain('anything it stored');
    expect(text, 'true on a phone too').not.toContain('computer');
  });

  it('中文:同样两半 —— 这台设备上它存的会删,对话里的文件和别人装的不动', () => {
    const text = zhCNMessages['extensions.uninstallConfirmDescription'];
    expect(text).toContain('将从此设备移除 {name} 及其在此设备上的设置和保存的数据');
    expect(text).toContain('它在对话中打开过的文件保持不变');
    expect(text).toContain('其他人安装的副本也不受影响');
    expect(text, '手机上也属实').not.toContain('电脑');
  });
});
