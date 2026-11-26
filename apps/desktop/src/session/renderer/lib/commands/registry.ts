import { makeAutoObservable, observable } from 'mobx';
import { COMMANDS, type CommandId } from '@shared/commands';
import { SCOPE_LEVELS, type AppCommand, type CommandProvider, type ScopeId } from './types';

const isHostCommand = (id: string): id is CommandId => Object.hasOwn(COMMANDS, id);

export class CommandRegistry {
  private providers = new Set<CommandProvider>();
  contextElement: HTMLElement | null = null;
  /** Holders that own the keyboard outright for now (image viewer, the shortcut recorder). Shortcuts resume when the last lets go. */
  private pauses = 0;
  /**
   * Whether the task page is on screen. The gugu shell keeps it mounted but display-hidden on its other tabs; while hidden
   * only shell-surface providers answer, plus the commands whose definition says what to do then (`whenSessionPageHidden`).
   */
  sessionPageVisible = true;

  constructor() {
    makeAutoObservable<this, 'providers' | 'pauses'>(this, { providers: observable.shallow, contextElement: observable.ref, pauses: true });
  }

  register(provider: CommandProvider): () => void {
    this.providers.add(provider);
    return () => { this.providers.delete(provider); };
  }

  get shortcutsPaused(): boolean {
    return this.pauses > 0;
  }

  /** Stop answering shortcuts until the returned release is called; holders nest. */
  pauseShortcuts(): () => void {
    this.pauses += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauses -= 1;
    };
  }

  setSessionPageVisible(visible: boolean): void {
    this.sessionPageVisible = visible;
  }

  unregister(scopeId: ScopeId): void {
    for (const provider of this.providers) {
      if (provider.scopeId === scopeId) this.providers.delete(provider);
    }
  }

  setContext(element: HTMLElement): void {
    if (!element.closest('[role="menu"], [cmdk-root]')) {
      this.contextElement = element;
    }
  }

  dispatch(id: CommandId, task?: { projectId: string; sessionId: string }): boolean {
    const command = this.activeCommands.find((item) => item.id === id && item.enabled !== false);
    if (!command) return false;
    return command.execute(task) !== false;
  }

  get activeCommands(): AppCommand[] {
    const providers = [...this.providers].sort((a, b) => SCOPE_LEVELS[b.scopeId] - SCOPE_LEVELS[a.scopeId]);
    return providers.filter((provider) => !provider.isActive || provider.isActive(this.contextElement))
      .flatMap((provider) => {
        const commands = provider.getCommands();
        if (this.sessionPageVisible || provider.surface === 'shell') return commands;
        return commands.filter((command) => isHostCommand(command.id) && COMMANDS[command.id].whenSessionPageHidden !== undefined);
      });
  }
}

export const commandRegistry = new CommandRegistry();
