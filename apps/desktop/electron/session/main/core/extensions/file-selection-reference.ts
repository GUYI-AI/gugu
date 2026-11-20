import type { AppFileRef } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionChatFolder } from '@shared/extensions/bridge-protocol';
import type { FileReference } from '@shared/extensions/file-selection';

/**
 * A file a page has a selection in, named the way the conversation's readers can open it — by where the file lives, not
 * by the conversation (file-selection.ts); each place's pill is made from it (`placeTarget`):
 * - a chat folder's file → its `gugu-file://` link, read as the person (the chat's pill, `chatSelectionPills`);
 * - a file on a computer (a session's working copy, a project folder, a group's folder) → its absolute path on that machine,
 *   with the machine's name when it is not this one.
 * Null when its place cannot be named from here (another machine's session, whose folder this computer does not know).
 */
export async function fileReferenceOf(ref: AppFileRef, version: number | undefined, here: {
  chat: string | null;
  /** The page's chat's folders (`ctx.chat.folders`), where another machine's folder is said. */
  folders: readonly ExtensionChatFolder[];
}): Promise<FileReference | null> {
  if (!('id' in ref)) return null;
  if (!('workspace' in ref)) {
    const chat = ref.chat ?? here.chat;
    if (!chat) return null;
    const { chatSelectionPillsForApp } = await import('./extension-send');
    // The version the place was picked on, when the page said it; else the file as it is now.
    const [pill] = await chatSelectionPillsForApp(chat, [{ file: ref, ...(version === undefined ? {} : { version }) }]);
    return pill ? { name: pill.label, target: pill.target } : null;
  }
  const name = ref.id.replace(/\\/g, '/').split('/').pop() || ref.id;
  const { localRootOf } = await import('./app-files');
  const local = await localRootOf({ workspace: ref.workspace }).catch(() => null);
  if (local) return { name, target: joined(local.workspaceRoot, ref.id) };
  const folder = here.folders.find((one) => one.workspace === ref.workspace);
  return folder ? { name: `${name} · ${folder.machine}`, target: joined(folder.path, ref.id) } : null;
}

/** A path inside a folder, written with that folder's own separator (another machine may be Windows). */
function joined(root: string, inside: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${inside.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep)}`;
}
