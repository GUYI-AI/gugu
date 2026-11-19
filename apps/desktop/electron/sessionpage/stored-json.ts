import { isDeepStrictEqual } from 'node:util'

/**
 * Whether a local row's data equals what the backend holds, compared as the backend stores it. Rows are jsonb there:
 * undefined is dropped, and every object's keys come back in jsonb's own order at every depth (a directory row's
 * `catalog: { categoryId, aliases }` reads back as `{ aliases, categoryId }`). So objects compare as key sets at every
 * depth and arrays keep their order. Anything looser republishes an unchanged row on every round — and each commit's
 * revision event starts the next round (#1922: about 60 commits a second).
 */
export function sameStoredJson(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(asStored(a), asStored(b))
}

function asStored(value: unknown): unknown {
  const text = JSON.stringify(value)
  return text === undefined ? undefined : JSON.parse(text)
}
