import { useCallback } from 'react';
import type { MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components';
import { stringifyMention } from '@gugu/session-shared/markdown';
import { getDraggedScreenContent, SCREEN_CONTENT_DRAG_TYPE } from '@renderer/lib/drag-screen-content';
import { MAX_ATTACHMENT_BYTES } from '@gugu/session-core/session-record/contract';
import { basenameFromAnyPath } from '@shared/path-name';
import { fileOnDisk } from '@/lib/fileOnDisk';
import { getDraggedWorkspaceFile, WORKSPACE_FILE_DRAG_TYPE, type DraggedWorkspaceFile } from '@renderer/lib/drag-files';
import { readWorkspaceBytes } from '@renderer/features/sessions/workspace-backend/read-workspace-bytes';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { LocalSessionMentionProvider } from './local-session-mention-provider';

const SESSION_DROP_TYPES = [SCREEN_CONTENT_DRAG_TYPE, WORKSPACE_FILE_DRAG_TYPE] as const;

/**
 * 把会话拖到**终端**上时写进去的那段字(编程形态的会话没有 composer,终端就是输入框)。
 *
 * 与聊天框写的是**同一种写法**:`@[Claude 1](aid:<Agent ID>)` —— 人读得出是谁,agent 拿得到
 * 可直接 `session_message` 的地址,不必先去通讯录查一次。两个落点写法不同曾是这个功能的
 * 一处不一致(owner 2026-09-16 拍板统一成这个形状)。
 *
 * 名册里没有它(还没身份)返回 null —— 终端上没有地方挂提示,所以这一步宁可什么都不写:
 * ❌ 退而写一个发不出去的名字,比不写更坏。
 */
export function terminalSessionMentionInput(
  mention: Pick<MentionItem, 'name' | 'label'> | null
): string | null {
  const name = mention?.name?.trim();
  const address = mention?.label?.trim();
  if (!name || !address) return null;
  return `${stringifyMention({ label: name, target: address, kind: 'custom' })} `;
}

/**
 * A computer file is read where it is (`readChunk`) and keeps its path, so the attachment it becomes references it in place.
 * Over the attachment limit: said before anything is held.
 */
async function readWorkspaceFile({ projectId, workspaceId, targetPath }: DraggedWorkspaceFile & { projectId: string }): Promise<File> {
  const parts = await readWorkspaceBytes(projectId, workspaceId, targetPath, MAX_ATTACHMENT_BYTES);
  return fileOnDisk(new File(parts, basenameFromAnyPath(targetPath)), targetPath);
}

/**
 * 把侧栏的一条会话行拖进 composer = 在这里插一枚 @ 提及。
 *
 * behavior session-page「把会话拖成 @」: 拖拽只是 @ 弹层的第二个入口,两条路给出**同一枚** pill ——
 * 所以身份解析走的是弹层那个 provider,而不是另拼一份。
 *
 * 文件夹 App 里电脑文件的一行拖进来 = 附件,任何输入框都一样(owner 11-08):读出来交给这个输入框自己的附件路
 * (`attachFiles`,和回形针、拖系统文件同一条)。❌ 插路径:那条路径只在这台电脑上,任务可能在别的机器。
 * 文件夹行交给 `dropFolder`(这个输入框对文件夹的现成处理);没有就说「文件夹不能作为附件」。
 */
export function useSessionMentionDrop({
  provider,
  editorApiRef,
  selfSessionId,
  onMentionResolved,
  attachFiles,
  dropFolder,
}: {
  provider: LocalSessionMentionProvider | null;
  editorApiRef: { current: PromptEditorRef | null };
  /** 把一条会话拖到它自己的 composer 上不产生任何东西 —— @ 自己没有意义,也不值得报错。 */
  selfSessionId?: string;
  /** 解析成功、插入之前的记账口;返回 false 时由落点处理(如邀请群外的 Agent),不插入提及。 */
  onMentionResolved?: (item: MentionItem) => boolean | void;
  /** This composer's attachment path; without it a computer file dropped here is said to be refused. */
  attachFiles?: (files: File[]) => void;
  /** A folder row, by its path on this computer. */
  dropFolder?: (path: string) => void;
}): {
  dataDropTypes: readonly string[];
  onDataDropped: (dataTransfer: DataTransfer) => void;
} {
  const { translate } = useSessionMessages();

  const onDataDropped = useCallback(
    (dataTransfer: DataTransfer) => {
      const workspaceFile = getDraggedWorkspaceFile(dataTransfer);
      if (workspaceFile) {
        if (workspaceFile.directory) {
          if (dropFolder) dropFolder(workspaceFile.targetPath);
          else toast({ title: translate('chat.folderDropUnsupportedTitle'), variant: 'destructive' });
          return;
        }
        const { projectId } = workspaceFile;
        const failed = (error: { code?: string }) => toast({ variant: 'destructive',
          title: translate(error.code === 'too-large' ? 'composer.attachmentTooLarge' : 'composer.attachmentUploadFailed') });
        if (!attachFiles || !projectId) return failed({});
        void readWorkspaceFile({ ...workspaceFile, projectId }).then((file) => attachFiles([file]), failed);
        return;
      }
      const dragged = getDraggedScreenContent(dataTransfer);
      if (dragged?.kind !== 'session' || !provider) return;
      if (dragged.sessionId === selfSessionId) return;
      const editor = editorApiRef.current;

      void (async () => {
        const item = await provider.resolveSession(dragged.sessionId);
        if (editorApiRef.current !== editor) return;
        if (item?.disabled) {
          toast({ title: item.description });
          return;
        }
        if (!item) {
          // fail loud:名册里没有它就没有可投递的地址,❌ 不插一枚发不出去的 pill 让人以为成了。
          toast({
            title: translate('chat.mentionDropNoIdentity', { title: dragged.title }),
          });
          return;
        }
        if (onMentionResolved?.(item) === false) return;
        editor?.insertMention(item);
      })();
    },
    [attachFiles, dropFolder, editorApiRef, onMentionResolved, provider, selfSessionId, translate],
  );

  return { dataDropTypes: SESSION_DROP_TYPES, onDataDropped };
}
