import type { Replica } from './replica'

type Patch<V> = (value: V | undefined) => V | undefined

/** A write drawn on the click (I4), in the account it began in; a refusal reads again, else goes back to what was read (❌ the unwritten value left). */
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
