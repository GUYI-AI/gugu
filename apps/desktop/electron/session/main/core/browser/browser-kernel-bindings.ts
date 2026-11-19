import type { BrowserKernelKind } from '@shared/browser-kernel';

export type BrowserKernelBinding = { browserId: string; partition: string; sessionId?: string; kernel: BrowserKernelKind };

/** A tab snapshots its engine once. Preferences never migrate a live page or its cookies. */
export class BrowserKernelBindings {
  private readonly tabs = new Map<string, BrowserKernelBinding>();
  private readonly pending = new Map<string, Promise<unknown>>();
  /** Closing waits for registration, including a tab closed before its installation read has returned. */
  run<T>(browserId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(browserId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(browserId, next);
    void next.finally(() => { if (this.pending.get(browserId) === next) this.pending.delete(browserId); }).catch(() => {});
    return next;
  }
  get(browserId: string) { return this.tabs.get(browserId); }
  forSession(sessionId: string) { return [...this.tabs.values()].filter(tab => tab.sessionId === sessionId); }
  delete(browserId: string) { this.tabs.delete(browserId); }
  bind(input: Omit<BrowserKernelBinding, 'kernel'>, kernel: BrowserKernelKind): BrowserKernelBinding {
    const existing = this.tabs.get(input.browserId);
    if (existing && existing.sessionId !== input.sessionId) throw new Error('This browser tab belongs to another conversation');
    const binding = Object.freeze({ ...input, kernel: existing?.kernel ?? kernel });
    this.tabs.set(input.browserId, binding);
    return binding;
  }
}
