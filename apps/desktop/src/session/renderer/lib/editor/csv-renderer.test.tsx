// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { CsvTable } from './csv-renderer';
import { MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS } from './csv-parser';

it('renders only the bounded CSV table and reports omitted multiline rows and columns', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const header = Array.from({ length: MAX_PREVIEW_COLUMNS }, (_, index) => `column-${index}`).join(',');
  const body = Array.from({ length: MAX_PREVIEW_ROWS - 1 }, (_, index) => `row-${index}`).join('\n');
  try {
    await act(async () => root.render(<CsvTable content={header + ',"hidden\nheader"\n' + body + '\n"hidden\nrow"'} />));
    expect(host.querySelectorAll('thead th')).toHaveLength(MAX_PREVIEW_COLUMNS);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(MAX_PREVIEW_ROWS - 1);
    expect(host.textContent).not.toContain('hidden');
    expect(host.textContent).toContain('Preview capped at');
    expect(host.textContent).toContain('100 columns');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
