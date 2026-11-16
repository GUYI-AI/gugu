// #2927 Product paths: HTML clicks, CSV preview, and terminal input/context menus.
import { expect, it } from 'vitest';
import { resolveWorkspaceResourcePath, isOutsideWorkspace } from '../../../../apps/desktop/src/session/renderer/lib/editor/workspace-resource-path';
import { parseCsv } from '../../../../apps/desktop/src/session/renderer/lib/editor/csv-parser';
import { getTerminalLinkAtBufferCell } from '../../../../apps/desktop/src/session/renderer/lib/pty/terminal-context-link';
import { SubmittedInputBuffer, isRealTaskInput } from '../../../../apps/desktop/src/session/renderer/lib/pty/pty-input-buffer';
const resolve = (resourcePath: string) => resolveWorkspaceResourcePath({workspacePath:'/repo', containingFilePath:'/repo/docs/page.html', resourcePath});
const buffer = (lines: string[]) => ({getLine:(index:number)=>lines[index] === undefined ? undefined : {isWrapped:index>0,translateToString:()=>lines[index]!}});

it('decodes local HTML link filenames once',()=>{expect(resolve('notes/a%20b%23c%3F.md?view=1#part')).toBe('/repo/docs/notes/a b#c?.md');expect(resolve('a%2520b.md')).toBe('/repo/docs/a%20b.md');expect(resolve('../%2e%2e/private.md')).toBeNull();expect(resolve('https://example.test/a%20b.md')).toBeNull();expect(resolve('100%.md')).toBe('/repo/docs/100%.md');});

it('recognizes Windows workspace path casing',()=>{const args={workspacePath:'C:/Work',containingFilePath:'c:/work/docs/page.html'};expect(isOutsideWorkspace(args.workspacePath,args.containingFilePath)).toBe(false);expect(resolveWorkspaceResourcePath({...args,resourcePath:'c:/WORK/image.png'})).toBe('c:/WORK/image.png');expect(resolveWorkspaceResourcePath({...args,resourcePath:'../image.png'})).toBe('C:/work/image.png');expect(resolveWorkspaceResourcePath({...args,resourcePath:'../../private.png'})).toBeNull();expect(isOutsideWorkspace('/Work','/work/page.html')).toBe(true);});
