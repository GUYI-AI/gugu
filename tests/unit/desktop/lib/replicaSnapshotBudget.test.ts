import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * @@@client-state-model, persistence: every replica that persists declares literal limits, and the limits of each snapshot
 * block (an account's, the device's) sum to at most the budget — read from the definitions in the source, so a model that
 * grows its limit, or a new persisting model, has to fit.
 */
const ROOT = 'apps/desktop/src'
const BUDGET = 64 * 1024

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'tests' || name === '__tests__' ? [] : files(path)
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

type Persisting = { file: string; name: string; scope: string; maxBytes: number; maxEntries: number }

function persistingModels(): Persisting[] {
  const out: Persisting[] = []
  for (const file of files(ROOT)) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('persist:')) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'replica') {
        const definition = node.arguments[0]
        if (definition && ts.isObjectLiteralExpression(definition)) {
          const prop = (key: string) => definition.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key)?.initializer
          const persist = prop('persist')
          if (persist) {
            const literal = (n: ts.Expression | undefined) => (n && ts.isStringLiteral(n) ? n.text : '?')
            const number = (key: string) => {
              const value = ts.isObjectLiteralExpression(persist)
                ? persist.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key)?.initializer
                : undefined
              return value && ts.isNumericLiteral(value) ? Number(value.text) : NaN
            }
            out.push({ file, name: literal(prop('name')), scope: literal(prop('scope')), maxBytes: number('maxBytes'), maxEntries: number('maxEntries') })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return out
}

describe('replica snapshot budget', () => {
  const models = persistingModels()

  it('finds the persisting models, each with literal limits', () => {
    expect(models.length).toBeGreaterThan(20)
    const unbounded = models.filter((m) => !(m.maxBytes > 0) || !(m.maxEntries >= 1) || !['account', 'device'].includes(m.scope))
    expect(unbounded).toEqual([])
  })

  it('each block fits the budget', () => {
    for (const scope of ['account', 'device']) {
      const sum = models.filter((m) => m.scope === scope).reduce((total, m) => total + m.maxBytes * m.maxEntries, 0)
      expect(sum, `${scope} block: ${sum} B of ${BUDGET} B`).toBeLessThanOrEqual(BUDGET)
    }
  })
})
