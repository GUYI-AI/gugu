import { useEffect, useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { useAssistantPanelAccountId } from '@/lib/assistantPanelBridge';
import type { PromptLibrary, PromptLibraryPrompt, PromptOverride } from '@shared/prompt-library';

/**
 * 提示词是**账号的**(owner 11-07):一行 `user_settings`,主进程拿账号令牌读写(prompt-library/service.ts),
 * 每台电脑读同一份;断网时是这台电脑上一次读到的那份。
 * 一份模块级的读数给所有入口共用 —— 资源库页、会话和聊天输入框的 `/`、「添加上下文」、空态建议 —— 聊天输入框不在
 * 会话页的 QueryClientProvider 里,所以 ❌ react-query。窗口回到前台时过期(60 秒)就重读,别的设备的改动这样到。
 */
const STALE_MS = 60_000;
const NONE: PromptLibrary = { items: [], overrides: {} };

type State = { account: string | null; all: PromptLibrary | undefined; error: unknown; saving: number; readAt: number };
let state: State = { account: null, all: undefined, error: null, saving: 0, readAt: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};

/** Only the latest request's answer is kept: a focus re-read that returns after a delete or undo must not undo it. */
let latest = 0;
const isLatest = (request: number, account: string | null) => request === latest && state.account === account;

async function load(account: string): Promise<void> {
  const request = ++latest;
  try {
    const all = await rpc.promptLibrary.get();
    if (isLatest(request, account)) set({ all, error: null, readAt: Date.now() });
  } catch (error) {
    if (isLatest(request, account)) set({ error, readAt: Date.now() });
  }
}

function follow(account: string | null): void {
  if (state.account === account) return;
  set({ account, all: undefined, error: null, readAt: 0 });
  if (account) void load(account);
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    if (state.account && Date.now() - state.readAt > STALE_MS) void load(state.account);
  });
}

/** Re-read now (another device or an App changed the list). */
export function reloadPrompts(): void {
  if (state.account) void load(state.account);
}

/** Saved by main, which answers the saved list; the entries are greyed while it is out (`isSaving`). */
async function change(save: () => Promise<PromptLibrary>): Promise<void> {
  const { account } = state;
  const request = ++latest;
  set({ saving: state.saving + 1 });
  try {
    const all = await save();
    if (isLatest(request, account)) set({ all, readAt: Date.now() });
  } finally {
    set({ saving: state.saving - 1 });
  }
}

/** Create, or replace the one with this id. */
export const savePrompt = (prompt: PromptLibraryPrompt) => change(() => rpc.promptLibrary.save(prompt));

/** Delete outright; the undo saves it back (`showPromptDeleted`). */
export const deletePrompt = (id: string) => change(() => rpc.promptLibrary.delete(id));

/** Edit or hide an App's prompt (`<App id>/<name>`) for this person; null restores the App's own. */
export const overridePrompt = (key: string, override: PromptOverride | null) => change(() => rpc.promptLibrary.override(key, override));

export function usePromptLibrary() {
  const account = useAssistantPanelAccountId();
  useEffect(() => follow(account), [account]);
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state
  );
  const current = snapshot.account === account ? snapshot : null;
  return {
    value: (current?.all ?? NONE).items,
    overrides: (current?.all ?? NONE).overrides,
    isLoading: !!account && !current?.all && !current?.error,
    isSaving: (current?.saving ?? 0) > 0,
    error: current?.error ?? null,
    hasData: current?.all !== undefined,
    reload: reloadPrompts,
  };
}
