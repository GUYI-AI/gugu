// The root vitest config with only the node unit projects that `pnpm test:unit` runs. Stryker loads this
// instead of the root config, so a mutation run never starts the browser projects or the DB/integration ones.
import { defineConfig } from 'vitest/config'
import root from '../../../vitest.config.ts'

const unitProjects = new Set(['gugu', 'tooling', 'session-packages', 'session-main', 'session-chat-ui'])
type Project = { test?: { name?: string } }

export default defineConfig({
  ...root,
  test: {
    ...root.test,
    projects: (root.test?.projects as Project[]).filter((project) => unitProjects.has(project.test?.name ?? '')),
  },
})
