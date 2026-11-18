/** @jsxImportSource solid-js */
import { changedFilePath, type SessionPatch } from '@gugu/session-core/acp';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For } from 'solid-js';
import { render } from 'solid-js/web';
import type { ChatContext } from '../../../../chat-context';
import type { RecordedFileChange } from '../../../../commands';
import { vars } from '../../../../styles/theme.css';
import { DiffLines } from './Diff';
import { hasTextPatch } from './diff-lines';
import { langFromPath } from './lang';

function headerPath(header: string): string {
  const raw = header.slice(4).split('\t', 1)[0].replace(/\r$/, '');
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

function patchForFile(patch: SessionPatch, path: string): SessionPatch | undefined {
  if (patch.changes.length === 1) return patch;
  if (patch.patch?.format !== 'git_patch') return;
  const normalize = (value: string) => value.replaceAll('\\', '/');
  const candidates = patch.changes.filter(change => changedFilePath(change) === path);
  if (candidates.length !== 1) return;

  // Match the recorded file identity against file headers, before any hunk text.
  // Ambiguous or headerless sections cannot be attributed to a file.
  const matches = patch.patch.text.split(/(?=^diff --git )/m).filter(section => {
    const headers = section.split(/^@@ /m, 1)[0];
    const newHeader = headers.match(/^\+\+\+ .+$/m)?.[0];
    const oldHeader = headers.match(/^--- .+$/m)?.[0];
    const header = newHeader && headerPath(newHeader) !== '/dev/null' ? newHeader : oldHeader;
    if (!header) return false;
    const named = normalize(headerPath(header)).replace(/^[ab]\//, '');
    const exact = patch.changes.filter(change => normalize(changedFilePath(change) ?? '') === named);
    if (exact.length) return exact.length === 1 && exact[0] === candidates[0];
    const suffix = patch.changes.filter(change => normalize(changedFilePath(change) ?? '').endsWith('/' + named));
    return suffix.length === 1 && suffix[0] === candidates[0];
  });
  if (matches.length !== 1) return;
  return { ...patch, changes: candidates, patch: { ...patch.patch, text: matches[0] } };
}

/** Mount the same line renderer used in chat, with every hunk of each recorded edit. */
export function mountRecordedFileDiff(parent: HTMLElement, context: ChatContext, change: RecordedFileChange) {
  const theme = context.theme;
  const lang = langFromPath(change.path);
  const sections = change.patches.map(patch => {
    const scoped = patchForFile(patch, change.path);
    if (!scoped || !hasTextPatch(scoped)) return [];
    const rows = context.sharedCaches.computeDiff(scoped);
    const firstHunk = rows.findIndex(row => row.type === 'hunk');
    return firstHunk < 0 ? rows : rows.slice(firstHunk);
  });
  return {
    available: sections.some(rows => rows.length > 0),
    partial: sections.some(rows => rows.length === 0),
    dispose: render(() => (
      <div style={assignInlineVars({
        [vars.fontMono]: theme.themeVars.fontMono,
        [vars.typeCodeFontFamily]: theme.themeVars.typeCodeFontFamily,
        [vars.typeCodeFontSize]: theme.themeVars.typeCodeFontSize,
        [vars.typeCodeFontWeight]: theme.themeVars.typeCodeFontWeight,
      })}>
        <For each={sections.filter(rows => rows.length > 0)}>{rows =>
          <DiffLines layout={{ previewRows: rows, lang, truncated: false }} caches={context.sharedCaches}
            codeLineHeight={() => theme.fonts.code.lineHeight} showMarkers />
        }</For>
      </div>
    ), parent),
  };
}
