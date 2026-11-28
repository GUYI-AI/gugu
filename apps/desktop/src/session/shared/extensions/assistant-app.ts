/** A host-owned App identity. A page cannot choose its sender or widen its recipient scope. */
// Outside the installable manifest ID grammar: a third-party bundle cannot impersonate this sender.
export const ASSISTANT_PANEL_APP = { extensionId: 'gugu.assistant', extensionName: '个人助理面板' } as const;
export const ASSISTANT_PANEL_SERVER = 'resources';
