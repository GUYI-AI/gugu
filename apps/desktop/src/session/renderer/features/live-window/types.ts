/** Presentation identity supplied by the host adapter. This is not an input authorization grant. */
export interface LiveWindowContext {
  conversationId: string;
  deviceId: string;
  sessionId: string;
  agentId: string;
  privateAgentChat: boolean;
  shown: boolean;
}

export interface LiveWindowSize { width: number; height: number }
export type LiveWindowKind = 'browser' | 'computer';
export type LiveWindowMode = 'floating' | 'enlarged' | 'tabbed' | 'docked' | 'closed';
export type LiveWindowCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** IDs, binding and lifecycle come from the existing host resource, never tool-name text. */
export interface LiveWindowSource {
  id: string;
  kind: LiveWindowKind;
  deviceId: string;
  sessionId: string;
  agentId: string;
  title: string;
  size: LiveWindowSize | null;
  status: 'operating' | 'finished';
}

export interface LiveWindowPresentation {
  mode: LiveWindowMode;
  selectedSourceId: string | null;
  selectedTab: 'chat' | 'screen';
  controlsRevealed: boolean;
  orientation?: 'portrait' | 'landscape';
  small: { corner: LiveWindowCorner; x?: number; y?: number };
  dock: { edge: 'left' | 'right'; ratio: number };
  dismissedSourceIds: readonly string[];
}

export interface LiveWindowSnapshot {
  context: LiveWindowContext | null;
  presentation: LiveWindowPresentation | null;
  sources: readonly LiveWindowSource[];
  source: LiveWindowSource | null;
  visible: boolean;
  operating: boolean;
}

export type LiveWindowAction =
  | { type: 'reveal'; shown: boolean }
  | { type: 'set-orientation'; orientation: 'portrait' | 'landscape' }
  | { type: 'enlarge' }
  | { type: 'minimize' }
  | { type: 'composer-focus' }
  | { type: 'show-tab' }
  | { type: 'select-tab'; tab: 'chat' | 'screen'; sourceId?: string }
  | { type: 'close-small' }
  | { type: 'close-tab'; sourceId: string }
  | { type: 'close' }
  | { type: 'show-from-tool'; kind?: LiveWindowKind }
  | { type: 'select-source'; sourceId: string }
  | { type: 'position'; small: LiveWindowPresentation['small'] }
  | { type: 'dock'; edge: 'left' | 'right'; ratio: number }
  | { type: 'move-dock'; edge: 'left' | 'right'; ratio: number }
  | { type: 'undock' };
