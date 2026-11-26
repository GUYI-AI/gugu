import { useCallback, useRef, useState, type RefObject } from 'react';
import { useAttachmentFileSelection } from '@/hooks/useAttachmentFileSelection';
import { getRendererSession } from '@/lib/sessionPublication';
import { registerPastedScreenshot } from '@/lib/pastedScreenshot';
import { pushTaskDirectory, taskAttachmentUsesSsh } from '@/lib/taskAttachmentTarget';
import { readAttachmentPreviewText } from '@gugu/session-ui/react/components';
import type { ComposerAttachment, PromptEditorRef } from '@gugu/session-ui/react/components';
import { asProvisioned, getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { droppedDirectoryMention } from '@renderer/lib/drag-files';
import { toast } from '@renderer/lib/hooks/use-toast';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { shellPort } from '@renderer/lib/shell-port';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { AcpChatStore } from './acp-chat-store';
import { useComposerFileUploads } from './use-composer-file-uploads';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

/** The composer's attachment ledger: the chips, the uploads behind them, and the hidden file input. */
export function useComposerAttachments(store: AcpChatStore, translate: Translate) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachmentState] = useState<ComposerAttachment[]>([]);
  const fileSelection = useAttachmentFileSelection(attachments, store.sessionId);
  const attachmentsRef = useRef(attachments);
  // 发送等待的是上传 promise;账本必须在它 resolve 前更新,不能等 React 的下一次渲染。
  const setAttachments = useCallback((update: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
    const next = typeof update === 'function' ? update(attachmentsRef.current) : update;
    if (next.length !== attachmentsRef.current.length || next.some((item, i) => item.id !== attachmentsRef.current[i]?.id)) store.renewDraftSubmission();
    attachmentsRef.current = next;
    setAttachmentState(next);
  }, [store]);
  // 图片与文件同一条:贴上来就放进这个 agent 私聊的文件夹,进度在 chip 上,这一轮带着引用发出去(P3)。
  const fileUploads = useComposerFileUploads({
    resumable: true,
    to: async () => {
      const owner = getRendererSession()?.user.id;
      if (!owner) throw new Error('attachments: not signed in');
      const address = await shellPort().ensureAgentAddress({ projectId: store.projectId, sessionId: store.sessionId });
      return { chatId: address.chatId, owner, sessionId: store.sessionId, deviceId: machineRegistry.machineOf(store.projectId),
        projectId: store.projectId, workspaceId: asProvisioned(getSessionPageStore(store.projectId, store.sessionId))?.workspaceId };
    },
    setAttachments,
    translate,
  });
  return { fileInputRef, attachments, attachmentsRef, setAttachments, fileSelection, fileUploads };
}

/** Putting files and folders into the composer: picked, pasted, dropped. */
export function useComposerAttachActions({ store, translate, acceptsImages, editorApiRef, fileInputRef, fileSelection, fileUploads, setAttachments }: {
  store: AcpChatStore;
  translate: Translate;
  acceptsImages: boolean;
  editorApiRef: RefObject<PromptEditorRef | null>;
} & Pick<ReturnType<typeof useComposerAttachments>, 'fileInputRef' | 'fileSelection' | 'fileUploads' | 'setAttachments'>) {
  const handleAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** 拖 / 粘 / 选进来的文件(图片也是):各上一枚 chip,当场开始放进私聊文件夹。 */
  const attachFiles = useCallback(async (files: File[], source?: 'paste' | 'drop') => {
    const accepted = acceptsImages ? files : files.filter((file) => !file.type.toLowerCase().startsWith('image/'));
    if (accepted.length < files.length) toast({ title: translate('customModels.imagesUnsupported'), variant: 'destructive' });
    const selected = fileSelection.choose(accepted);
    try {
      for (const { id, file } of selected) {
        // 用户读的名字是 `file.name`,❌ 不从盘上的路径反推 —— 从前正是这一步把 `gugu-drop-<uuid>-` 漏到了用户脸上。
        const isImage = file.type.toLowerCase().startsWith('image/');
        const chip: ComposerAttachment = {
          id,
          name: file.name || 'attachment',
          kind: isImage ? 'image' : 'file',
          mimeType: file.type,
        };
        if (source === 'paste') registerPastedScreenshot(file);
        void fileUploads.add(chip, file);
        if (!isImage) {
          // 文本类附件的内容在入列时读一份,chip 点开看的就是它(#5269)。
          const preview = await readAttachmentPreviewText(file);
          if (preview) {
            setAttachments(current => current.map(att => att.id === chip.id ? { ...att, previewText: preview.text, previewTruncated: preview.truncated } : att));
          }
        }
      }
    } catch (error) { fileSelection.release(selected); throw error; }
  }, [acceptsImages, fileSelection, fileUploads, setAttachments, translate]);

  /**
   * 拖进来的文件夹。本机会话:落成正文里一条路径 pill(文件夹就在这台电脑上,agent 就地读)。
   * 会话在别的机器上:这条路径那边没有,私聊文件夹也收不下一个文件夹 —— 说出来,❌ 静默丢。
   */
  const attachDirectories = useCallback(
    (files: File[], entries: FileSystemDirectoryEntry[]) => {
      const deviceId = machineRegistry.machineOf(store.projectId);
      if (deviceId) {
        if (!taskAttachmentUsesSsh(deviceId)) {
          toast({ title: translate('chat.folderDropUnsupportedTitle'), description: translate('chat.folderDropUnsupportedDescription'), variant: 'destructive' });
          return;
        }
        const workspaceId = asProvisioned(getSessionPageStore(store.projectId, store.sessionId))?.workspaceId;
        for (const entry of entries) {
          void pushTaskDirectory({ deviceId, projectId: store.projectId, workspaceId, chatId: '', owner: '' }, entry).then(path => {
            editorApiRef.current?.insertMention({ id: path, label: path, kind: 'file', name: entry.name });
          }).catch(error => {
            log.warn('Task folder placement failed', { error: String(error) });
            const code = (error as { code?: string })?.code;
            toast({ title: translate('composer.attachmentUploadFailed'), description: translate(code === 'folder_too_large'
              ? 'composer.attachmentFolderTooLarge' : code === 'host_update_required' ? 'composer.attachmentHostUpdateRequired'
                : 'composer.attachmentUploadFailed'), variant: 'destructive' });
          });
        }
        return;
      }
      for (const file of files) {
        const mention = droppedDirectoryMention(file);
        if (mention) editorApiRef.current?.insertMention(mention);
      }
    },
    [store, translate]
  );

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      await attachFiles(files);
    },
    [attachFiles]
  );

  return { handleAttach, attachFiles, attachDirectories, handleFileInputChange };
}
