import type { FileTreeError } from '@gugu/session-core/files';

export type FileTreeNotFoundError = { type: 'not_found' };
export type FileTreeOperationError = FileTreeNotFoundError | FileTreeError;
