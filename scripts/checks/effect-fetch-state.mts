// @@@read-model ratchet (open-flicker, owner 2026-11-14): data a surface shows lives in a read model (lib/readModel.ts),
// not in component state filled by an effect. The shape this finds is the old one: a `useEffect` whose callback reads
// something asynchronously (a `.then` / `.catch` / `.finally` callback or a setter handed to one, an async function, or
// a call to one of the component's own functions that does either) and puts the answer into a `useState` setter of the
// same component. Until it answers, the component draws the state's initial value as if
// it were the stored one — that is what flickers when a surface opens.
//
// An effect that runs a *flow* rather than reading what a surface shows (a sign-in that waits for its window, a rename
// that settles, a dialog step) is not this shape; it says so on the line above with `@@@effect-flow - <what flow>`,
// and the marker needs the reason (a bare marker is still counted).
//
// It is a ratchet: `effect-fetch-state-baseline.json` lists the files that still have the shape and how many effects;
// a file may only go down. Real AST, not regex (the same reason as subject-scoped-hooks.mts).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

export const SOURCE_ROOT: string = 'apps/desktop/src'

const isTest = (path: string) => /\.(test|spec)\.tsx?$/.test(path) || /\/(tests|__tests__)\//.test(path)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return null
}

/** `const [value, setValue] = useState(...)` setters declared directly in this function body. */
function stateSetters(fn: ts.FunctionLikeDeclaration): Set<string> {
  const setters = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (node !== fn && isFunction(node)) return
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && calleeName(node.initializer) === 'useState') {
      const setter = node.name.elements[1]
      if (setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name)) setters.add(setter.name.text)
    }
    ts.forEachChild(node, walk)
  }
  if (fn.body) walk(fn.body)
  return setters
}

const ASYNC_CONTINUATIONS = new Set(['then', 'catch', 'finally'])

/**
 * The component's own functions that put a read's answer into its state (`const load = async () => setV(await read())`,
 * the same inside `useCallback`, or `function load() { read().then(setV) }`): an effect that calls one has the shape too.
 */
function stateReaders(fn: ts.FunctionLikeDeclaration, setters: Set<string>): Set<string> {
  const readers = new Set<string>()
  const local = new Map<string, ts.Node>()
  const walk = (node: ts.Node): void => {
    if (node !== fn && isFunction(node) && !ts.isFunctionDeclaration(node)) return
    if (ts.isFunctionDeclaration(node) && node !== fn && node.name) { local.set(node.name.text, node); return }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      const body = isFunction(init) ? init
        : ts.isCallExpression(init) && calleeName(init) === 'useCallback' && init.arguments[0] && isFunction(init.arguments[0]) ? init.arguments[0]
        : null
      if (body) { local.set(node.name.text, body); return }
    }
    ts.forEachChild(node, walk)
  }
  if (fn.body) walk(fn.body)
  // A reader may call another reader: grow the set until it stops changing.
  for (let grew = true; grew;) {
    grew = false
    for (const [name, body] of local) {
      if (!readers.has(name) && setsStateAfterRead(body, setters, readers)) { readers.add(name); grew = true }
    }
  }
  return readers
}

/**
 * Whether a setter is called from an asynchronous continuation anywhere inside this node: inside a `.then` / `.catch` /
 * `.finally` callback, a setter handed to one of them by reference (`.then(setValue)`), after an `await` in an async
 * function, or through a call to one of the component's own functions that does so (`readers`).
 */
function setsStateAfterRead(callback: ts.Node, setters: Set<string>, readers: ReadonlySet<string> = new Set()): boolean {
  let found = false
  const walk = (node: ts.Node, deferred: boolean): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (deferred && name && setters.has(name) && ts.isIdentifier(node.expression)) { found = true; return }
      if (name && readers.has(name) && ts.isIdentifier(node.expression)) { found = true; return }
      if (name && ASYNC_CONTINUATIONS.has(name) && ts.isPropertyAccessExpression(node.expression)) {
        walk(node.expression, deferred)
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && setters.has(arg.text)) { found = true; return }
          walk(arg, true)
        }
        return
      }
    }
    if (isFunction(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      ts.forEachChild(node, (child) => walk(child, true))
      return
    }
    ts.forEachChild(node, (child) => walk(child, deferred))
  }
  walk(callback, false)
  return found
}

/** The 1-based lines of the effects of that shape in a file. */
export function effectLines(path: string, text: string): number[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines: number[] = []
  const visitFunction = (fn: ts.FunctionLikeDeclaration): void => {
    const setters = stateSetters(fn)
    if (setters.size === 0) return
    const readers = stateReaders(fn, setters)
    const walk = (node: ts.Node): void => {
      if (node !== fn && isFunction(node) && !isEffectCallback(node)) return
      if (ts.isCallExpression(node) && (calleeName(node) === 'useEffect' || calleeName(node) === 'useLayoutEffect')) {
        const callback = node.arguments[0]
        if (callback && setsStateAfterRead(callback, setters, readers) && !markedFlow(node)) lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
        return
      }
      ts.forEachChild(node, walk)
    }
    if (fn.body) walk(fn.body)
  }
  const markedFlow = (call: ts.Node) => {
    let statement: ts.Node = call
    while (statement.parent && !ts.isExpressionStatement(statement) && !ts.isBlock(statement.parent)) statement = statement.parent
    const comments = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []
    return comments.some((range) => /@@@effect-flow\s*-\s*\S/.test(text.slice(range.pos, range.end)))
  }
  const isEffectCallback = (node: ts.Node) => ts.isCallExpression(node.parent) && node.parent.arguments[0] === node
    && ['useEffect', 'useLayoutEffect'].includes(calleeName(node.parent) ?? '')
  const visit = (node: ts.Node): void => {
    if (isFunction(node)) visitFunction(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...new Set(lines)]
}

/** Count the effects of that shape in a file. */
export function scanFile(path: string, text: string): number {
  return effectLines(path, text).length
}

/** `{ relative path: count }` for every non-test source file that still has the shape, sorted by path. */
export function scanEffectFetchState(root = '.'): Record<string, number> {
  const out: Record<string, number> = {}
  for (const path of sourceFiles(join(root, SOURCE_ROOT)).sort()) {
    const rel = relative(root, path).split('\\').join('/')
    if (isTest(rel)) continue
    const count = scanFile(rel, readFileSync(path, 'utf8'))
    if (count > 0) out[rel] = count
  }
  return out
}

if (process.argv[1]?.endsWith('effect-fetch-state.mts')) {
  const hits = scanEffectFetchState()
  if (process.argv.includes('--lines')) {
    for (const file of Object.keys(hits)) console.log(`${file}: ${effectLines(file, readFileSync(file, 'utf8')).join(', ')}`)
  }
  if (process.argv.includes('--write')) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('scripts/checks/effect-fetch-state-baseline.json', `${JSON.stringify(hits, null, 2)}\n`)
  }
  console.log(JSON.stringify(hits, null, 2))
  console.log('files =', Object.keys(hits).length, 'effects =', Object.values(hits).reduce((a, b) => a + b, 0))
}
