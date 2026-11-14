import { fileRefOf } from './app-runtime-protocol';

export interface FileAnnotationFields { startLine: number; endLine: number; text: string; annotation: string }

function refuse(code: 'denied' | 'invalid', message: string): never { throw Object.assign(new Error(message), { code }); }

/** The installed identity comes from the host, never the page's arguments. */
export function requirePreinstalledFiles(identity: { id: string; origin?: string }): void {
  if (identity.id !== 'workspace' || identity.origin !== 'preinstalled') refuse('denied', 'File annotations are only available to the preinstalled Files App');
}

/** Shared by bridge and queue; text stays literal and annotationPrompt JSON-encodes it. */
export function fileAnnotationFields(input: unknown): FileAnnotationFields {
  const value = input as Partial<FileAnnotationFields> | null;
  if (!value || !Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine)
    || value.startLine! < 1 || value.endLine! < value.startLine!
    || typeof value.text !== 'string' || typeof value.annotation !== 'string') refuse('invalid', 'A file annotation requires source lines, selected text and a comment');
  return { startLine: value.startLine!, endLine: value.endLine!, text: value.text, annotation: value.annotation };
}

export function workspaceFileAnnotation(input: Record<string, unknown>, workspace: string | null) {
  if (!workspace) refuse('denied', 'File annotations require this page to belong to a session');
  const ref = fileRefOf(input.ref);
  if (!('workspace' in ref) || ref.workspace !== workspace || !('id' in ref) || typeof ref.id !== 'string' || !ref.id) refuse('denied', 'The annotation must name a file of this page\'s working copy');
  return { path: ref.id, ...fileAnnotationFields(input) };
}
