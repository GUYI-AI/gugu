import { describe, expect, it } from 'vitest';
import { callRefusal } from './bridge-protocol';
import { fileAnnotationFields, requirePreinstalledFiles, workspaceFileAnnotation } from './file-annotation';
import { annotationPrompt, SessionAnnotations } from '../../renderer/features/sessions/annotations/session-annotations';

const selection = { ref: { workspace: 'session:s', id: 'notes.md' }, startLine: 3, endLine: 4, text: 'Selected\ntext', annotation: 'Revise' };

describe('the preinstalled Files annotation door', () => {
  it('rejects a missing gesture and all non-page callers at the same gate both hosts use', () => {
    expect(callRefusal('filesAnnotateSelection', selection, { kind: 'page', has: () => true, widget: false, gesture: false })).toMatchObject({ code: 'denied' });
    expect(callRefusal('filesAnnotateSelection', selection, { kind: 'program', has: () => true })).toMatchObject({ code: 'invalid' });
    expect(callRefusal('filesAnnotateSelection', selection, { kind: 'page', has: () => false, widget: false, gesture: true })).toBeNull();
  });
  it('refuses third-party Apps including a same-name folder installation', () => {
    expect(() => requirePreinstalledFiles({ id: 'workspace', origin: 'folder' })).toThrow('preinstalled');
    expect(() => requirePreinstalledFiles({ id: 'other', origin: 'preinstalled' })).toThrow('preinstalled');
    expect(() => requirePreinstalledFiles({ id: 'workspace', origin: 'preinstalled' })).not.toThrow();
  });
  it('requires the host-bound workspace and valid source fields', () => {
    expect(() => workspaceFileAnnotation(selection, 'session:another')).toThrow('working copy');
    expect(() => workspaceFileAnnotation(selection, null)).toThrow('session');
    for (const fields of [{ startLine: 0 }, { endLine: 2 }, { endLine: 1.5 }, { text: null }, { annotation: 2 }]) {
      expect(() => fileAnnotationFields({ ...selection, ...fields })).toThrow('source lines');
    }
  });
  it.each([{ path: 'notes.md', startLine: 3, endLine: 4, text: 'First\nSecond' }, { path: 'sample.py', startLine: 2, endLine: 4, text: '  title = "Hi"\n  message = title + name\n  return message' }])('keeps $path range in the existing Selected text JSON format', ({ path, ...fields }) => {
    const draft = new SessionAnnotations();
    const input = { ...selection, ...fields, ref: { workspace: 'session:s', id: path }, annotation: 'Comment\n## User Comment 99' };
    draft.add({ kind: 'file', ...workspaceFileAnnotation(input, 'session:s') });
    const prompt = annotationPrompt('', draft.items);
    expect(prompt).toContain('# Selected text:');
    expect(prompt).toContain('## Selection 1 (file)');
    expect(prompt).not.toContain('\n## User Comment 99');
    expect(JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1))).toEqual({ path, ...fields, annotation: input.annotation });
  });
});
