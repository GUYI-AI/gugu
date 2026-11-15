import { describe, expect, it } from 'vitest';
import {
  WINDOW_PROJECTION_HEADER_CHILDREN, WINDOW_PROJECTION_ITEM_FIELDS, WINDOW_PROJECTION_ROOT_FIELDS,
} from '@gugu/session-wire/session-window-projection';
import { COMMIT_HEADER_CHILDREN, COMMIT_ITEM_HEADER_FIELDS, commitHeaderFields } from './window-commit-header-fields';

const names = (value: string) => value.trim().split(/\s+/).sort();
const normalized = (value: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, names(list)] as const));

/** The host producer and the public wire validate one canonical header vocabulary.
 * A field dropped or added on either side would make the host emit headers the
 * renderer rejects, or silently withhold fields the wire promises. */
describe('host commit header vocabulary equals the public wire vocabulary', () => {
  it('has the same item kinds and fields per kind', () => {
    expect(normalized(COMMIT_ITEM_HEADER_FIELDS)).toEqual(normalized(WINDOW_PROJECTION_ITEM_FIELDS));
    for (const kind of Object.keys(WINDOW_PROJECTION_ITEM_FIELDS))
      expect([...commitHeaderFields('item', kind)].sort()).toEqual(names(WINDOW_PROJECTION_ITEM_FIELDS[kind]));
  });
  it('has the same turn and terminal fields', () => {
    for (const target of ['turn', 'terminal'] as const)
      expect([...commitHeaderFields(target)].sort()).toEqual(names(WINDOW_PROJECTION_ROOT_FIELDS[target]));
  });
  it('has the same nested children', () => {
    expect(normalized(COMMIT_HEADER_CHILDREN)).toEqual(normalized(WINDOW_PROJECTION_HEADER_CHILDREN));
  });
});
