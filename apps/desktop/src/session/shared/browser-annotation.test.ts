import { expect, it } from 'vitest';
import { annotationConversationKey, isAnnotationConversation, browserAnnotationScript, isBrowserAnnotationQuery } from './browser-annotation';
import { readTaskPageControl } from './browser-task-page';

it('requires a real typed conversation and namespaces chats independently of tasks', () => {
  for (const value of [null, {}, { kind: 'chat', chatId: '' }, { kind: 'session', sessionId: ' ' }, { kind: 'chat', sessionId: 'task' }]) {
    expect(isAnnotationConversation(value)).toBe(false);
  }
  expect(annotationConversationKey({ kind: 'chat', chatId: 'same' })).not.toBe(annotationConversationKey({ kind: 'session', sessionId: 'same' }));
});

it('rejects non-finite, out-of-frame and executable page selection payloads at the device boundary', () => {
  for (const query of [null, { x: NaN, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: Infinity, height: 0 },
    { x: -1, y: 0, width: 0, height: 0 }, { x: 0.8, y: 0, width: 0.5, height: 0.5 }, { x: 'alert(1)', y: 0, width: 0, height: 0 }]) {
    expect(isBrowserAnnotationQuery(query)).toBe(false);
    expect(readTaskPageControl({ action: 'annotate', query, capture: true })).toBeNull();
  }
  const query = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };
  expect(readTaskPageControl({ action: 'annotate', query, capture: true })).toEqual({ action: 'annotate', query, capture: true });
  expect(browserAnnotationScript(query)).toContain(JSON.stringify(query));
});
