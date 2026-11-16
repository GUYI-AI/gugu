import type {
  LiveWindowAction, LiveWindowContext, LiveWindowPresentation, LiveWindowSnapshot, LiveWindowSource,
} from './types';

type Entry = { context: LiveWindowContext; sources: readonly LiveWindowSource[]; presentation: LiveWindowPresentation; opened: boolean };
const EMPTY: LiveWindowSnapshot = Object.freeze({ context: null, presentation: null, sources: [], source: null, headerSource: null, visible: false, operating: false, connected: true });
const ratio = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const key = (context: LiveWindowContext) => JSON.stringify([context.conversationId, context.deviceId, context.sessionId, context.agentId]);
const initial = (): LiveWindowPresentation => ({
  mode: 'closed', selectedSourceId: null, selectedTab: 'chat', controlsRevealed: false, orientation: 'portrait',
  small: { corner: 'bottom-right' }, dock: { edge: 'right', ratio: .34 }, dismissedSourceIds: [],
});
const sameSource = (a: LiveWindowSource, b: LiveWindowSource) => a.id === b.id && a.kind === b.kind
  && a.deviceId === b.deviceId && a.sessionId === b.sessionId && a.agentId === b.agentId && a.title === b.title
  && a.status === b.status && a.activity === b.activity && a.size?.width === b.size?.width && a.size?.height === b.size?.height;
const sameSources = (a: readonly LiveWindowSource[], b: readonly LiveWindowSource[]) =>
  a.length === b.length && a.every((source, index) => sameSource(source, b[index]!));
const bound = (context: LiveWindowContext, source: LiveWindowSource) => source.deviceId === context.deviceId
  && source.sessionId === context.sessionId && source.agentId === context.agentId;

/** One instance belongs to one signed-in account and is cleared with that account's renderer lifetime. */
export class LiveWindowModel {
  private entries = new Map<string, Entry>();
  private active: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: LiveWindowSnapshot = EMPTY;

  readonly platform: 'desktop' | 'phone';
  constructor(platform: 'desktop' | 'phone') { this.platform = platform; }
  getSnapshot = (): LiveWindowSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  activate(context: LiveWindowContext | null): void {
    if (!context) { this.active = null; this.publish(); return; }
    const id = key(context), entry = this.entries.get(id);
    if (entry) entry.context = { ...context };
    else this.entries.set(id, { context: { ...context }, sources: [], presentation: initial(), opened: false });
    this.active = id;
    this.publish();
  }

  /** A view adapter may update a hidden conversation without making it the active conversation. */
  observe(context: LiveWindowContext, incoming: readonly LiveWindowSource[]): void {
    const id = key(context);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { context: { ...context }, sources: [], presentation: initial(), opened: false };
      this.entries.set(id, entry);
    } else entry.context = { ...context };
    const accepted = context.privateAgentChat ? incoming.filter(source => bound(context, source) && !!source.id) : [];
    const next = accepted.map(source => ({ ...source, size: source.size && { ...source.size } }))
      .sort((a, b) => Number(a.kind === 'computer') - Number(b.kind === 'computer'));
    // A completed turn still has its resource. A successful empty host list means it was actually closed.
    const newcomers = next.filter(source => source.status === 'operating' && !entry!.presentation.dismissedSourceIds.includes(source.id)
      && !entry!.sources.some(old => old.id === source.id && old.status === 'operating'));
    const previousActivity = Math.max(0, ...entry.sources.map(source => source.activity ?? 0));
    const current = [...next].sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))[0];
    if (!sameSources(entry.sources, next)) entry.sources = next;
    if (current && (current.activity ?? 0) > previousActivity) {
      entry.presentation = { ...entry.presentation, selectedSourceId: current.id };
    }
    if (context.privateAgentChat && newcomers.length && !entry.opened) {
      const selected = current ?? newcomers[0]!;
      entry.opened = true;
      entry.presentation = { ...entry.presentation, mode: 'floating', selectedSourceId: selected.id, controlsRevealed: false,
        dismissedSourceIds: entry.presentation.dismissedSourceIds.filter(sourceId => !newcomers.some(source => source.id === sourceId)) };
    }
    if (!next.some(source => source.id === entry!.presentation.selectedSourceId) && next.length) {
      entry.presentation = { ...entry.presentation, selectedSourceId: next[0]!.id };
    }
    if (!next.length && entry.presentation.mode !== 'closed') {
      entry.presentation = { ...entry.presentation, mode: 'closed', selectedSourceId: null, selectedTab: 'chat', controlsRevealed: false };
    }
    if (id === this.active) this.publish();
  }

  dispatch(action: LiveWindowAction): void {
    const entry = this.active && this.entries.get(this.active);
    if (!entry || !entry.context.privateAgentChat) return;
    const before = entry.presentation, state = { ...before };
    const available = () => entry.sources.filter(source => !state.dismissedSourceIds.includes(source.id));
    const select = (id: string | undefined) => id && available().some(source => source.id === id);
    switch (action.type) {
      case 'toggle-window': {
        const open = state.mode !== 'closed' && !(state.mode === 'tabbed' && state.selectedTab === 'chat');
        state.mode = open ? 'closed' : 'floating'; state.selectedTab = 'chat'; state.controlsRevealed = false;
        if (!open) {
          state.dismissedSourceIds = [];
          state.selectedSourceId = [...entry.sources].sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))[0]?.id ?? null;
        }
        entry.opened = true;
        break;
      }
      case 'reveal': state.controlsRevealed = action.shown; break;
      case 'set-orientation': if (this.platform === 'phone') state.orientation = action.orientation; break;
      case 'enlarge': if (state.mode !== 'closed') { state.mode = 'enlarged'; state.controlsRevealed = false; } break;
      case 'minimize': if (state.mode !== 'closed') { state.mode = 'floating'; state.controlsRevealed = false; } break;
      case 'composer-focus': if (state.mode === 'enlarged') { state.mode = 'floating'; state.controlsRevealed = false; } break;
      case 'show-tab':
        if (this.platform === 'desktop' && state.mode !== 'closed') { state.mode = 'tabbed'; state.selectedTab = 'screen'; }
        break;
      case 'select-tab':
        if (this.platform !== 'desktop' || state.mode !== 'tabbed') break;
        if (action.tab === 'screen' && action.sourceId && !select(action.sourceId)) break;
        state.selectedTab = action.tab;
        if (action.sourceId) state.selectedSourceId = action.sourceId;
        break;
      case 'close-small':
        if (this.platform === 'desktop') { state.mode = 'tabbed'; state.selectedTab = 'chat'; state.controlsRevealed = false; }
        else { state.mode = 'closed'; state.dismissedSourceIds = entry.sources.map(source => source.id); }
        break;
      case 'close-tab': {
        if (this.platform !== 'desktop' || state.mode !== 'tabbed' || state.selectedTab === 'chat'
          || !select(action.sourceId)) break;
        state.dismissedSourceIds = [...state.dismissedSourceIds, action.sourceId];
        const next = available()[0];
        if (state.selectedSourceId === action.sourceId) state.selectedSourceId = next?.id ?? null;
        if (!next) { state.mode = 'closed'; state.selectedTab = 'chat'; }
        break;
      }
      case 'close': state.mode = 'closed'; state.dismissedSourceIds = entry.sources.map(source => source.id); break;
      case 'show-from-tool': {
        const source = entry.sources.find(source => !action.kind || source.kind === action.kind);
        if (!source) break;
        state.dismissedSourceIds = state.dismissedSourceIds.filter(id => id !== source.id);
        state.selectedSourceId = source.id; state.mode = 'floating'; state.controlsRevealed = false; entry.opened = true; break;
      }
      case 'select-source': if (select(action.sourceId)) state.selectedSourceId = action.sourceId; break;
      case 'position': state.small = { ...action.small,
        ...(action.small.x === undefined ? {} : { x: ratio(action.small.x) }),
        ...(action.small.y === undefined ? {} : { y: ratio(action.small.y) }) }; break;
      case 'dock': case 'move-dock':
        if (this.platform === 'phone') {
          state.dock = { edge: action.edge, ratio: ratio(action.ratio) };
          if (action.type === 'dock') state.mode = 'docked';
        }
        break;
      case 'undock': if (this.platform === 'phone' && state.mode === 'docked') state.mode = 'floating'; break;
    }
    if (JSON.stringify(before) === JSON.stringify(state)) return;
    entry.presentation = state;
    this.publish();
  }

  clear(): void { this.entries.clear(); this.active = null; this.publish(); }

  private publish(): void {
    const entry = this.active && this.entries.get(this.active);
    if (!entry) {
      if (this.snapshot === EMPTY) return;
      this.snapshot = EMPTY;
    } else {
      const { context, presentation } = entry;
      const headerSource = context.shown && context.privateAgentChat
        ? [...entry.sources].sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))[0] ?? null : null;
      const sources = entry.sources.filter(source => !presentation.dismissedSourceIds.includes(source.id));
      const source = sources.find(candidate => candidate.id === presentation.selectedSourceId) ?? sources[0] ?? null;
      const visible = context.shown && context.privateAgentChat && !!source && presentation.mode !== 'closed'
        && !(presentation.mode === 'tabbed' && presentation.selectedTab === 'chat');
      const next: LiveWindowSnapshot = { context, presentation, sources, source, visible, headerSource,
        connected: context.connected !== false, operating: context.connected !== false && headerSource?.status === 'operating' };
      if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
      this.snapshot = next;
    }
    for (const listener of this.listeners) listener();
  }
}
