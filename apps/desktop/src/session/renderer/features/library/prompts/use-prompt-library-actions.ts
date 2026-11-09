// 提示词的新建 / 编辑 / 删除:一份实现,两处入口共用。
//
// 为什么要抽出来:增删改本来只长在「资源库 → 提示词」那一页上,而那一页在会话页没有任何可见入口
// (只有命令面板进得去)。于是用户在「添加上下文」弹层里看得见提示词、却找不到地方增删改
// (owner 2026-09-10 实机反馈:「找不到地方增删改,按理说如果在这里直接增删改也行啊」)。
// ⇒ 弹层里直接就地增删改,复用的就是这一份;❌ 别在弹层里再写一套写库逻辑,那是同一份数据两个写者。
import { toast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { withOverrides, type PromptLibraryPrompt, type PromptOverride, type PromptState } from '@shared/prompt-library';
import type { PromptFormResult } from './prompt-modal';
import { deletePrompt, overridePrompt, savePrompt, usePromptLibrary } from './use-prompt-library';

function createPromptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `prompt-${Date.now()}`;
}

/**
 * 删了就是删了,不先问(owner 11-07「删除只保留撤销条」):提示里那一下「撤销」把它原样存回去。
 * App 的程序删的(`gugu.prompts.delete`)也是这一条提示,在 prompt-changes.ts。
 */
export function showPromptDeleted(prompt: PromptLibraryPrompt, title: string, undoLabel: string): void {
  toast({ key: `prompt-deleted:${prompt.id}`, title, action: { label: undoLabel, onClick: () => void savePrompt(prompt) }, duration: 8000 });
}

export type AppPromptRow = (typeof installedExtensionsStore.appPrompts)[number] & { state: PromptState };

export interface PromptLibraryActions {
  prompts: PromptLibraryPrompt[];
  /** Enabled Apps' prompts as the person sees them (`withOverrides`), hidden ones included so they can be restored. */
  appPrompts: AppPromptRow[];
  /** 第一次读、还没读到。 */
  isLoading: boolean;
  /** 读写任一在途 → 入口置灰。 */
  isBusy: boolean;
  /** 读这一份的错误。 */
  error: unknown;
  hasData: boolean;
  reload(): void;
  createPrompt(): void;
  /**
   * 不走弹窗、当场建一条并把它交回来 ——「添加上下文」那个框里敲 `标题: 正文` 回车就是这条路。
   * 返回建出来的那条,好让调用方拿它的正文接着往输入框里塞(写库是乐观更新,不必等落库)。
   */
  createPromptFromDraft(draft: PromptFormResult): PromptLibraryPrompt;
  editPrompt(prompt: PromptLibraryPrompt): void;
  deletePrompt(prompt: PromptLibraryPrompt): void;
  /** An App's prompt: edit the person's own version, hide it (with an undo), or go back to the App's. */
  editAppPrompt(prompt: AppPromptRow): void;
  hideAppPrompt(prompt: AppPromptRow): void;
  restoreAppPrompt(prompt: AppPromptRow): void;
}

export function usePromptLibraryActions(store: Pick<typeof installedExtensionsStore, 'appPrompts'> = installedExtensionsStore): PromptLibraryActions {
  const { value: prompts, overrides, isLoading, isSaving, error, hasData, reload } = usePromptLibrary();
  const showPromptModal = useShowModal('promptModal');
  const { translate } = useSessionMessages();

  const save = (prompt: PromptLibraryPrompt, successTitle: string) => {
    savePrompt(prompt)
      .then(() => toast({ title: successTitle }))
      .catch((failure: unknown) => toast({ title: String(failure), variant: 'destructive' }));
  };

  const override = (key: string, next: PromptOverride | null, done?: () => void) => {
    overridePrompt(key, next)
      .then(done)
      .catch((failure: unknown) => toast({ title: String(failure), variant: 'destructive' }));
  };

  return {
    prompts,
    appPrompts: withOverrides(store.appPrompts, overrides),
    isLoading,
    isBusy: isLoading || isSaving,
    error,
    hasData,
    reload,
    createPromptFromDraft: (draft) => {
      const created: PromptLibraryPrompt = { id: createPromptId(), ...draft };
      save(created, translate('prompts.added'));
      return created;
    },
    createPrompt: () => {
      showPromptModal({
        onSuccess: (result: PromptFormResult) => save({ id: createPromptId(), ...result }, translate('prompts.added')),
      });
    },
    editPrompt: (prompt) => {
      showPromptModal({
        initialPrompt: prompt,
        onSuccess: (result: PromptFormResult) => save({ ...prompt, ...result }, translate('prompts.updated')),
      });
    },
    deletePrompt: (prompt) => {
      deletePrompt(prompt.id)
        .then(() => showPromptDeleted(prompt, translate('prompts.deleted'), translate('prompts.undo')))
        .catch((failure: unknown) => toast({ title: String(failure), variant: 'destructive' }));
    },
    editAppPrompt: (prompt) => {
      showPromptModal({
        initialPrompt: prompt,
        onSuccess: (result: PromptFormResult) => override(prompt.key, result, () => toast({ title: translate('prompts.updated') })),
      });
    },
    hideAppPrompt: (prompt) => {
      const before = overrides[prompt.key] ?? null;
      override(prompt.key, { hidden: true }, () => toast({
        key: `prompt-hidden:${prompt.key}`, title: translate('prompts.hiddenToast', { title: prompt.title }),
        action: { label: translate('prompts.undo'), onClick: () => void overridePrompt(prompt.key, before) }, duration: 8000,
      }));
    },
    restoreAppPrompt: (prompt) => override(prompt.key, null),
  };
}
