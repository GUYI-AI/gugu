// #2930 Product paths: structured logger preparation and the schedule editor.
import { expect, it } from 'vitest'
import {
  prepareFields,
  normalizePaths
} from '../../../../packages/session-shared/src/logger/prepare'
import { secret } from '../../../../packages/session-shared/src/secret'

it('preserves repeated log objects without losing cycle protection', () => {
  const shared = { status: 'failed', token: secret('test-value') }
  const error = new Error('failed')
  const data = { request: shared, retry: shared, errors: [error, error] }
  const prepared = prepareFields(data) as typeof data
  expect(prepared.retry).toEqual({ status: 'failed', token: '[REDACTED]' })
  expect(prepared.errors[1]).toMatchObject({ message: 'failed' })
  const cycle: unknown[] = []
  cycle.push(cycle)
  expect(prepareFields(cycle)).toEqual(['[Circular]'])
  error.cause = error
  expect(prepareFields(error)).toMatchObject({ cause: '[Circular]' })
})

it('preserves own proto named diagnostic fields', () => {
  const input = JSON.parse('{"__proto__":{"detail":"failure"},"ok":true}')
  const out = prepareFields(input)
  expect(JSON.stringify(out)).toBe('{"__proto__":{"detail":"failure"},"ok":true}')
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
})

it('normalizes forward slash Windows stack paths', () => {
  expect(normalizePaths('at C:/Users/Ada/project/main.ts')).toBe('at C:/Users/~/project/main.ts')
  expect(normalizePaths('at c:/users/Ada/project/main.ts')).toBe('at c:/users/~/project/main.ts')
  expect(normalizePaths(String.raw`at C:\Users\Ada\project\main.ts`)).toBe(
    String.raw`at C:\Users\~\project\main.ts`
  )
})
