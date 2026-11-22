import { expect, it } from 'vitest';
import { contentMenuLayout, type ContentMenuItem } from './content-context-menu';

const labels = (items: readonly ContentMenuItem[]) => items.map((item) => item.type === 'separator' ? '—' : item.items ? `${item.label} ›` : item.label);
const row = (label: string, more: Record<string, unknown> = {}) => ({ id: label, label, ...more }) as ContentMenuItem;

it('draws a menu with no fold row as given, separators only between rows', () => {
  const { top, more } = contentMenuLayout([{ type: 'separator' }, row('Copy'), { type: 'separator' }, { type: 'separator' }, row('Paste'), { type: 'separator' }]);
  expect(labels(top)).toEqual(['Copy', '—', 'Paste']);
  expect(more).toEqual([]);
});

it('lays fold rows under 更多 by the menu rule: frequent first, the destructive last of 更多', () => {
  const { top, more } = contentMenuLayout([
    row('Side by side', { checked: false }), { type: 'separator' },
    row('Open'), row('Forward'), row('Download'), row('Copy link'),
    row('Rename', { fold: true }), row('Delete', { fold: true, danger: true }), row('Details', { fold: true }),
  ]);
  expect(labels(top)).toEqual(['Side by side', '—', 'Open', 'Forward', 'Download', 'Copy link']);
  expect(labels(more)).toEqual(['Rename', 'Details', 'Delete']);
});

it('keeps a short menu flat, the destructive last', () => {
  const { top, more } = contentMenuLayout([row('Open'), row('Delete', { fold: true, danger: true }), row('Rename', { fold: true })]);
  expect(labels(top)).toEqual(['Open', 'Rename', 'Delete']);
  expect(more).toEqual([]);
});

it('shows a submenu holding one row in its place, by the name it takes alone', () => {
  const { top } = contentMenuLayout([
    row('Open in', { items: [{ type: 'separator' }, row('Another App…', { alone: 'Open with another App' })] }),
    row('Copy', { items: [row('Path'), row('Relative path')] }),
  ]);
  expect(labels(top)).toEqual(['Open with another App', 'Copy ›']);
});
