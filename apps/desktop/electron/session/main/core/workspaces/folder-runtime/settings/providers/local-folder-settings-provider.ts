import path from 'node:path';
import type { IFileSystem } from '@gugu/session-core/files';
import {
  DbFolderSettingsProvider,
  type DbFolderSettingsProviderOptions,
} from './db-folder-settings-provider';

export class LocalFolderSettingsProvider extends DbFolderSettingsProvider {
  constructor(
    folderId: string,
    folderPath: string,
    defaultBranchFallback: string = 'main',
    configReader: Pick<IFileSystem, 'exists' | 'readText'>,
    options: DbFolderSettingsProviderOptions = {}
  ) {
    super(folderId, folderPath, defaultBranchFallback, configReader, path.join, options);
  }
}
