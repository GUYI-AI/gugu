import { describe, expect, it } from 'vitest';
import { conversationQuoteText } from './conversation-quote-text';

describe('conversationQuoteText', () => {
  it('a mention of a path on this computer reads as its label where it stands; others stay as written', () => {
    expect(conversationQuoteText('see @[notes.md · Line 8](/home/me/notes.md) and @[a.ts](src/a.ts)'))
      .toBe('see notes.md · Line 8 and @[a.ts](src/a.ts)');
    expect(conversationQuoteText('@[报告.pdf](<C:\\Users\\me\\My Files\\报告.pdf>) 看看')).toBe('报告.pdf 看看');
  });
});
