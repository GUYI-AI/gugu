import { createContext } from 'react';

export const ChatWorkspaceTabContext = createContext<'title' | 'tool' | null>(null);
