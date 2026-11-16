import base from '../../vitest.config'

// Explicit capture entry: reuse the repository's browser/provider/aliases and dummy backend.
// This file does not change the default CI collector or install any dependencies.
const projects = base.test?.projects
if (!Array.isArray(projects)) throw new Error('Repository Vitest projects are unavailable')
const browser = projects.find(project => typeof project === 'object' && 'test' in project && project.test?.name === 'session-browser')
if (!browser || typeof browser !== 'object' || !('test' in browser)) throw new Error('session-browser project is unavailable')

export default {
  ...base,
  test: {
    ...base.test,
    maxWorkers: 1,
    projects: [{
      ...browser,
      test: {
        ...browser.test,
        maxWorkers: 1,
        fileParallelism: false,
        include: ['capture-tools/native-skills/phone-native-skills.capture.tsx'],
        globalSetup: ['capture-tools/native-skills/native-files-server.ts'],
      },
    }],
  },
}
