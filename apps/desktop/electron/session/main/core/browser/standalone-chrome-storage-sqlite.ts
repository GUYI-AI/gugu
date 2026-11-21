import Database from 'better-sqlite3';
import type { OpenSqlite } from './standalone-chrome-storage';

/** Opens the private copy `readChromeStorageKeys` makes, never Chrome's own file. */
export const openChromeStorageCopy: OpenSqlite = file => new Database(file, { fileMustExist: true });
