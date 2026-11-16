import type { ILink, Terminal } from '@xterm/xterm';
import { findFileLinks, type BufferLike } from './file-link-detection';
import { getCellMetrics } from './xterm-cell-metrics';

const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gi;

type CellLike = {
  getChars(): string;
  getWidth(): number;
};

type BufferLineWithCells = {
  length: number;
  getCell(index: number): CellLike | undefined;
};

type BufferLineWithOptionalCells = NonNullable<ReturnType<BufferLike['getLine']>> &
  BufferLineWithCells;

type LineTextWithColumns = {
  text: string;
  columnForOffset(offset: number): number;
};

export function getTerminalContextLink(terminal: Terminal, event: MouseEvent): string | null {
  const cell = getCellMetrics(terminal);
  const element = (terminal as unknown as { element?: HTMLElement }).element;
  if (!cell || !element) return null;

  const rect = element.getBoundingClientRect();
  const row = Math.floor((event.clientY - rect.top) / cell.height);
  const column = Math.floor((event.clientX - rect.left) / cell.width) + 1;
  if (row < 0 || row >= terminal.rows || column < 1 || column > terminal.cols) return null;

  return getTerminalLinkAtBufferCell(
    terminal.buffer.active,
    terminal.buffer.active.viewportY + row + 1,
    column
  );
}

export function getTerminalLinkAtBufferCell(
  buffer: BufferLike,
  bufferLineNumber: number,
  column: number
): string | null {
  const fileLink = findFileLinks(buffer, bufferLineNumber).find((link) =>
    rangeContainsColumn(link.range, bufferLineNumber, column)
  );
  if (fileLink) return fileLink.text;

  let startIndex = bufferLineNumber - 1;
  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) startIndex -= 1;
  const lines: LineTextWithColumns[] = [];
  let text = '';
  let clickedOffset = 0;
  for (let index = startIndex; ; index += 1) {
    const line = buffer.getLine(index);
    if (!line) break;
    const mapped = getLineTextWithColumns(line);
    if (index === bufferLineNumber - 1) clickedOffset = text.length;
    lines.push(mapped);
    text += mapped.text;
    if (text.length > 4096) return null;
    if (!buffer.getLine(index + 1)?.isWrapped) break;
  }
  const clicked = lines[bufferLineNumber - 1 - startIndex];
  if (!clicked) return null;
  for (const match of text.matchAll(URL_PATTERN)) {
    const link = trimLinkText(match[0]);
    const startOffset = Math.max(0, match.index! - clickedOffset);
    const endOffset = Math.min(clicked.text.length, match.index! + link.length - clickedOffset) - 1;
    if (startOffset <= endOffset && column >= clicked.columnForOffset(startOffset) && column <= clicked.columnForOffset(endOffset)) return link;
  }
  return null;
}

function getLineTextWithColumns(line: ReturnType<BufferLike['getLine']>): LineTextWithColumns {
  const fallbackText = line?.translateToString(true) ?? '';
  if (!line || !hasCellAccess(line)) {
    return {
      text: fallbackText,
      columnForOffset: (offset) => offset + 1,
    };
  }

  let text = '';
  const offsetColumns: number[] = [];
  for (let cellIndex = 0; cellIndex < line.length; cellIndex += 1) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth() === 0) continue;

    const chars = cell.getChars() || ' ';
    const column = cellIndex + 1;
    for (let offset = 0; offset < chars.length; offset += 1) {
      offsetColumns.push(column);
    }
    text += chars;
  }

  const trimLength = text.length - text.trimEnd().length;
  if (trimLength > 0) {
    text = text.slice(0, -trimLength);
    offsetColumns.splice(-trimLength);
  }

  return {
    text,
    columnForOffset: (offset) => offsetColumns[offset] ?? offset + 1,
  };
}

function hasCellAccess(
  line: ReturnType<BufferLike['getLine']>
): line is BufferLineWithOptionalCells {
  return (
    !!line &&
    'length' in line &&
    'getCell' in line &&
    typeof line.length === 'number' &&
    typeof line.getCell === 'function'
  );
}

function rangeContainsColumn(
  range: ILink['range'],
  bufferLineNumber: number,
  column: number
): boolean {
  if (bufferLineNumber < range.start.y || bufferLineNumber > range.end.y) return false;
  const startColumn = bufferLineNumber === range.start.y ? range.start.x : 1;
  const endColumn = bufferLineNumber === range.end.y ? range.end.x : Number.POSITIVE_INFINITY;
  return column >= startColumn && column <= endColumn;
}

function trimLinkText(text: string): string {
  let result = text;
  for (;;) {
    const trimmed = result.replace(/[,. ;:!?]+$/, '');
    if (trimmed !== result) { result = trimmed; continue; }
    const opening = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[result.at(-1) ?? ''];
    if (opening && result.split(result.at(-1)!).length > result.split(opening).length) {
      result = result.slice(0, -1);
      continue;
    }
    return result;
  }
}
