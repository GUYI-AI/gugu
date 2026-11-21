// The root vitest config with only the node unit projects that `pnpm test:unit` runs. Stryker loads this
// instead of the root config, so a mutation run never starts the browser projects or the DB/integration ones.
// Forks, not threads: a native addon (@parcel/watcher, better-sqlite3) cannot be loaded twice in one process.
import { defineConfig } from 'vitest/config'
import root from '../../../vitest.config.ts'

const unitProjects = new Set(['gugu', 'tooling', 'session-packages', 'session-main', 'session-chat-ui'])
type Project = { test?: { name?: string; pool?: string } }

export default defineConfig({
  ...root,
  // A mutation run never needs a file watcher; watching the checkout (coverage HTML, reports) exhausts inotify.
  server: { ...root.server, watch: null },
  test: {
    ...root.test,
    projects: (root.test?.projects as Project[])
      .filter((project) => unitProjects.has(project.test?.name ?? ''))
      .map((project) => ({ ...project, test: { ...project.test, pool: 'forks' } })),
  },
})
