import type { Replica } from './replica'

type Patch<V> = (value: V | undefined) => V | undefined

/**
 * A write drawn on the click (client-state-model I4, PR 3's form): `optimistic` is put at once, `write` asks the host, and
 * `settled` puts its answer, all in the entry of the account signed in when it began (`at`). A refusal reads the entry
 * again; if that fails too, the entry goes back to what was read before the click (❌ the unwritten value left standing as
 * if it were true). The refusal reaches the caller, which says it.
 */
export async function writeOver<A extends unknown[], V, R>(
  model: Replica<A, V>,
  args: A,
  optimistic: Patch<V> | null,
  write: () => Promise<R>,
  settled?: (answer: R) => Patch<V>,
): Promise<R> {
  const entry = model.at(...args)
  const before = model.peek(...args)
  if (optimistic) entry.set(optimistic)
  try {
    const answer = await write()
    if (settled) entry.set(settled(answer))
    return answer
  } catch (error) {
    if (optimistic) {
      // `refresh` reads where the entry is shown; `prefetch` reads it where it is not (an entry nobody shows is only marked).
      await model.refresh(...args)
      await model.prefetch(...args)
      const now = model.peek(...args)
      if ((now.state !== 'value' || now.error) && before.state === 'value') entry.set(before.value)
    }
    throw error
  }
}
