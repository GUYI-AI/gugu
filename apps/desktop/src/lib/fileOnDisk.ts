const paths = new WeakMap<File, string>()

/**
 * A File read from a file on this computer, with the path it was read from. A send then treats it as a file dropped from
 * the system: a task references it in place and a project chat publishes it where it is, so the bytes stay on this disk and
 * only the index goes up. Without it the same bytes would be copied (task) or handed over as data (project chat).
 */
export function fileOnDisk(file: File, path: string): File {
  paths.set(file, path)
  return file
}

/** Where this File is on this computer's disk: the path it was read from, or the one Electron knows for a dropped file. */
export function pathOfFile(file: File): string {
  return paths.get(file) ?? globalThis.window?.electronAPI?.getPathForFile(file) ?? ''
}
