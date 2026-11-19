import { expect, it, vi } from 'vitest'
import { loadTarget } from './vitest-concurrent-mock/loader'

vi.mock('./vitest-concurrent-mock/target', () => ({ origin: 'mock' }))

// patches/vitest@4.1.10.patch: vitest 4.1 took the second of two concurrent import()s of a
// manually mocked module for the factory importing itself and returned the real module.
it('hands a resolved manual mock to concurrent dynamic imports', async () => {
  expect((await loadTarget()).origin).toBe('mock')
  const both = await Promise.all([loadTarget(), loadTarget()])
  expect(both.map(module => module.origin)).toEqual(['mock', 'mock'])
})
