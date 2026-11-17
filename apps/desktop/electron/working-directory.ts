import fs from 'node:fs'

/**
 * @@@app-cwd - The desktop process works in its own data directory, never in the directory it was launched from.
 *
 * On Windows a packaged app starts with its install directory as the working directory, and every child that is
 * started without an explicit `cwd` (agent CLIs, the updater's installer, an editor the person opens, a tunnel, an
 * ssh link) inherits it. A directory that is some process's working directory cannot be renamed, so any child still
 * alive at update time made the installer's commit fail. Nothing here may rely on the launch directory: product
 * paths come from `app.getAppPath()`, `process.resourcesPath` or `__dirname`.
 *
 * Runs right after userData is final (`--user-data-dir` / `GUGU_USER_DATA_DIR`) and before anything is started.
 * The server keeps its working directory: it runs only on POSIX, where a working directory pins nothing.
 */
export function enterUserDataDirectory(
  userData: string,
  deps: { mkdir: (dir: string) => void; chdir: (dir: string) => void } = {
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    chdir: (dir) => process.chdir(dir),
  },
): void {
  deps.mkdir(userData)
  deps.chdir(userData)
}
