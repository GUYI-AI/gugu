import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installNoAnimationIterationListeners } from '../../../../apps/desktop/src/lib/no-animation-iteration-listeners'

class Target extends EventTarget {}
installNoAnimationIterationListeners(Target.prototype)
installNoAnimationIterationListeners(Target.prototype) // idempotent: no double wrap

it('drops animationiteration only on a React container and keeps every other event', () => {
  const container = Object.assign(new Target(), { _reactListening7x3: true })
  const iteration = vi.fn()
  const start = vi.fn()
  container.addEventListener('animationiteration', iteration, true)
  container.addEventListener('animationiteration', iteration)
  container.addEventListener('animationstart', start)
  container.dispatchEvent(new Event('animationiteration'))
  container.dispatchEvent(new Event('animationstart'))
  expect(iteration).not.toHaveBeenCalled()
  expect(start).toHaveBeenCalledOnce()
})

it('leaves animationiteration to any other listener', () => {
  const plain = new Target()
  const iteration = vi.fn()
  plain.addEventListener('animationiteration', iteration)
  plain.dispatchEvent(new Event('animationiteration'))
  expect(iteration).toHaveBeenCalledOnce()
})

// React's onAnimationIteration rides the dropped root listener: make a new user fail here, not silently.
it('no renderer source uses onAnimationIteration', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (name === 'node_modules' || name === 'dist') continue
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!/\.(tsx?|jsx?)$/.test(name) || /\.test\.|no-animation-iteration-listeners\.ts$/.test(name)) continue
      if (/onAnimationIteration/.test(readFileSync(path, 'utf8'))) offenders.push(path)
    }
  }
  for (const root of ['apps/desktop/src', 'packages']) walk(join(__dirname, '../../../..', root))
  expect(offenders).toEqual([])
})
