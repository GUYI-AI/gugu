import { describe, expect, it } from 'vitest';
import { isEditableElement } from './acp-chat-view-commands';

const element = (editable: boolean) => ({ closest: () => (editable ? {} : null) }) as unknown as Element;

describe('acp chat view commands', () => {
  it('a text field keeps its arrows; the transcript and nothing focused do not', () => {
    expect(isEditableElement(element(true))).toBe(true);
    expect(isEditableElement(element(false))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});
