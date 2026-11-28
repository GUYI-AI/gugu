/** Key names used by the editor's keymaps and by its host's keyboard help. */
export const promptEditorKeys = { enter: 'Enter', lineBreak: 'Shift+Enter', previous: 'ArrowUp' } as const;

export function promptEditorShortcuts(enterBehavior: 'submit' | 'newline', hasHistory: boolean) {
  const { enter, lineBreak, previous } = promptEditorKeys;
  return [
    ...(enterBehavior === 'submit' ? [{ action: 'send' as const, keys: [enter] }] : []),
    { action: 'newline' as const, keys: enterBehavior === 'submit' ? [lineBreak] : [enter, lineBreak] },
    ...(hasHistory ? [{ action: 'recall' as const, keys: [previous] }] : []),
  ];
}
