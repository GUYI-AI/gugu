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

it('preserves unquoted CSV literal quotes',()=>{expect(parseCsv('name,note\na,a"b\nc,next').rows).toEqual([['name','note'],['a','a"b'],['c','next']]);expect(parseCsv('a""b,c').rows).toEqual([['a""b','c']]);expect(parseCsv('"a,b","c""d"').rows).toEqual([['a,b','c"d']]);});

it('keeps balanced terminal URL parentheses',()=>{const url='https://example.test/wiki/Function_(math)';expect(getTerminalLinkAtBufferCell(buffer(['see ('+url+').']),1,10)).toBe(url);expect(getTerminalLinkAtBufferCell(buffer([url]),1,url.length)).toBe(url);});

it('excludes unmatched terminal URL brackets',()=>{const url='https://example.test/docs';expect(getTerminalLinkAtBufferCell(buffer(['['+url+']']),1,4)).toBe(url);expect(getTerminalLinkAtBufferCell(buffer(['['+url+']']),1,url.length+2)).toBeNull();const ipv6='https://[::1]';expect(getTerminalLinkAtBufferCell(buffer([ipv6]),1,10)).toBe(ipv6);});

it('resolves terminal URLs across wrapped rows',()=>{const url='https://example.test/long/path';const b=buffer([url.slice(0,20),url.slice(20)]);expect(getTerminalLinkAtBufferCell(b,1,2)).toBe(url);expect(getTerminalLinkAtBufferCell(b,2,2)).toBe(url);expect(getTerminalLinkAtBufferCell(b,2,20)).toBeNull();});

it('backspaces supplementary terminal input',()=>{const input=new SubmittedInputBuffer();expect(input.feed('fix 😀\u007fnow\r')).toEqual(['fix now']);});
