import { expect, it } from 'vitest';
import { promptEditorShortcuts } from './keyboard-shortcuts';

it('describes newline-only editors without advertising send or history', () => {
  expect(promptEditorShortcuts('newline', false)).toEqual([{ action: 'newline', keys: ['Enter', 'Shift+Enter'] }]);
});

it('shows send and recall only for editors configured to handle them', () => {
  expect(promptEditorShortcuts('submit', true)).toEqual([
    { action: 'send', keys: ['Enter'] }, { action: 'newline', keys: ['Shift+Enter'] }, { action: 'recall', keys: ['ArrowUp'] },
  ]);
});
