import { createContext } from 'react';
import type { PaneLayoutStore } from './pane-layout-store';

export const ChatWorkspaceTabContext = createContext<{ role: 'title' | 'conversation' | 'tool'; layout: PaneLayoutStore } | null>(null);
