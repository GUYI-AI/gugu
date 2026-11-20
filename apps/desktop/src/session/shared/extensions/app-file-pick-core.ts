import { placeOf, type AppFileEntry } from './app-runtime-protocol';

/**
 * `gugu.files.pick(place, { suffixes, multiple, title, action, upload })` (API 62): the person picks files of the page's chat
 * in the host's own sheet (FilePickSheet). Main (the phone's host there) lists the chat's files as the person and hands them
 * to the sheet; the sheet only draws them and says which were picked. The picked files are the page's to open from then
 * on, with no capability: the person's pick is the consent, as a file the host handed the page (`ctx.file`) is.
 */
export interface FilePickCall {
  chat: string;
  suffixes: string[] | null;
  multiple: boolean;
  /** The App's words for the sheet's title and its button; absent: the host's. */
  title?: string;
  action?: string;
  /** 「从电脑添加…」 under the files: only for an App that holds `files:write` (the host decides, not the call). */
  upload: boolean;
}

/** What the sheet is asked: the files to offer, newest first, and whether a new one may be added from this device. */
export interface FilePickAsk {
  files: AppFileEntry[];
  multiple: boolean;
  title?: string;
  action?: string;
  upload: boolean;
}

/** The person's answer: the ids of the files picked, that they want to add one from this device, or null (cancelled). */
export type FilePicked = { ids: string[] } | { upload: true } | null;

const invalid = (message: string): never => {
  throw Object.assign(new Error(`files.pick: ${message}`), { code: 'invalid' as const });
};

/** The call as the host reads it; anything else is `invalid`. A working copy has no pick: only a chat's folder. */
export function filePickCallOf(args: Record<string, unknown>): FilePickCall {
  const place = placeOf(args.place);
  if (!('chat' in place)) invalid('place is a chat ({ chat: ctx.chat.id }): a working copy has no pick');
  const { suffixes, multiple, title, action, upload } = args;
  if (suffixes !== undefined && !(Array.isArray(suffixes) && suffixes.every((one) => typeof one === 'string' && /^\.[^./\\\s]+$/.test(one)))) {
    invalid("suffixes are like ['.csv', '.xlsx']");
  }
  for (const [key, value] of Object.entries({ title, action })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200)) invalid(`${key} is text of 1 to 200 characters`);
  }
  if (multiple !== undefined && typeof multiple !== 'boolean') invalid('multiple is true or false');
  if (upload !== undefined && typeof upload !== 'boolean') invalid('upload is true or false');
  return {
    chat: (place as { chat: string }).chat,
    suffixes: suffixes === undefined ? null : (suffixes as string[]).map((one) => one.toLowerCase()),
    multiple: multiple === true,
    ...(title === undefined ? {} : { title: title as string }),
    ...(action === undefined ? {} : { action: action as string }),
    upload: upload === true,
  };
}

/**
 * What the sheet offers of a chat's files: files only (no folder, no App's own state), of the kinds asked, newest first —
 * the order `files.search` answers in.
 */
export function pickableFiles(entries: readonly AppFileEntry[], suffixes: readonly string[] | null): AppFileEntry[] {
  return entries
    .filter((entry) => entry.type !== 'folder' && !entry.appState)
    .filter((entry) => !suffixes || suffixes.some((suffix) => entry.suffix.toLowerCase() === suffix || entry.name.toLowerCase().endsWith(suffix)))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id));
}

/** The host's file match (`files.search`): a piece of the path, any case. */
export function fileMatches(entry: Pick<AppFileEntry, 'path'>, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || entry.path.toLocaleLowerCase().includes(needle);
}

/** The picked entries, in the order offered; an id the ask did not offer is not the person's pick, and is dropped. */
export function pickedEntries(ask: Pick<FilePickAsk, 'files'>, ids: readonly string[]): AppFileEntry[] {
  const wanted = new Set(ids);
  return ask.files.filter((entry) => wanted.has(entry.id));
}
