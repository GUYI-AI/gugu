// @@@client-state-model — why this shape is debt and what replaces it: docs/design/client-state-model.md.
// @@@replica ratchet (open-flicker, owner 2026-11-14): data a surface shows lives in a replica (lib/replica.ts),
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
// A hard rule (open-flicker PR 3 cleared the last of them): no source file has the shape, no reading is collapsed to a
// literal default (`--defaults`), and nothing outside lib/replica.ts reaches react-query directly — its read hooks, the
// fetch-state hooks, or the client's own methods (`queryClient.…`); writes may still use `useMutation` with the client.
// `node scripts/checks/effect-fetch-state.mts` prints every finding and exits 1 if there is one. Real AST, not regex
// (the same reason as subject-scoped-hooks.mts).
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

/** `const [value, setValue] = useState(...)` setters (and `useReducer`'s `dispatch`) declared directly in this function body. */
function stateSetters(fn: ts.FunctionLikeDeclaration): Set<string> {
  const setters = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (node !== fn && isFunction(node)) return
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && ['useState', 'useReducer'].includes(calleeName(node.initializer) ?? '')) {
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
      // A setter handed to any call (`load(setValue)`, `subscribe(setValue)`): whatever it reads lands in this state.
      if (node.arguments.some((arg) => ts.isIdentifier(arg) && setters.has(arg.text)) && !(name && setters.has(name))) { found = true; return }
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

/**
 * A reading collapsed to a literal default (@@@client-state-model): the unknown reading then draws like a stored empty
 * value. Branch on the reading's three states instead. Literal = `[]`, `{}`, a number, a string, `false`, an `EMPTY_*`
 * constant; `null` is not a default (null is "unknown" in the consumer's type) — until it is folded into one downstream.
 * Syntactic: a reading is a name bound to `useReplica(…)` / `….peek(…)`, or any `x` whose `x.state` is compared with
 * `'value'` in the file. Counted:
 * - a value check whose not-value side is a literal: `r.state === 'value' ? r.value : []`, `r.state !== 'value' ? [] : …`,
 *   `!(r.state === 'value') ? 0 : …`, `'value' === r.state ? … : ''`;
 * - `?? literal` / `|| literal` on what a reading holds: `r.value ?? []`, `(r.state === 'value' && r.value) || []`, and
 *   the two-step fold — a name bound to a value check (`const xs = r.state === 'value' ? r.value : null`) or to `r.value`,
 *   then `xs ?? []` (also `xs?.length ?? 0`).
 */
export function literalDefaultLines(path: string, text: string): number[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines = new Set<number>()
  const bare = (node: ts.Expression): ts.Expression => {
    let n = node
    while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression
    return n
  }
  const isLiteralDefault = (node: ts.Expression): boolean => {
    const n = bare(node)
    if (ts.isArrayLiteralExpression(n) && n.elements.length === 0) return true
    if (ts.isObjectLiteralExpression(n) && n.properties.length === 0) return true
    if (ts.isNumericLiteral(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true
    if (n.kind === ts.SyntaxKind.FalseKeyword) return true
    return ts.isIdentifier(n) && /^EMPTY_[A-Z0-9_]+$/.test(n.text)
  }
  const EQ = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]
  const NE = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]
  const isState = (n: ts.Expression) => ts.isPropertyAccessExpression(bare(n)) && (bare(n) as ts.PropertyAccessExpression).name.text === 'state'
  const isValueText = (n: ts.Expression) => ts.isStringLiteral(bare(n)) && (bare(n) as ts.StringLiteral).text === 'value'
  /** `true`: the check holds when the reading has a value; `false`: when it has not; `undefined`: not a value check. */
  const valueCheck = (node: ts.Expression): boolean | undefined => {
    const n = bare(node)
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = valueCheck(n.operand)
      return inner === undefined ? undefined : !inner
    }
    if (!ts.isBinaryExpression(n)) return undefined
    const op = n.operatorToken.kind
    if (!EQ.includes(op) && !NE.includes(op)) return undefined
    if (!((isState(n.left) && isValueText(n.right)) || (isValueText(n.left) && isState(n.right)))) return undefined
    return EQ.includes(op)
  }
  const hasValueCheck = (node: ts.Node): boolean => {
    let found = false
    const walk = (n: ts.Node): void => { if (found) return; if (ts.isExpression(n) && valueCheck(n) !== undefined) found = true; else ts.forEachChild(n, walk) }
    walk(node)
    return found
  }
  // Readings: names whose `.state` is compared with 'value'; derived: names bound to a value check or to `reading.value`.
  const readings = new Set<string>()
  const derived = new Set<string>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(bare(node.initializer))) {
      const callee = (bare(node.initializer) as ts.CallExpression).expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (name === 'useReplica' || name === 'peek') readings.add(node.name.text)
    }
    if (ts.isExpression(node) && valueCheck(node) !== undefined) {
      const b = bare(node)
      const target = ts.isPrefixUnaryExpression(b) ? b.operand : b
      if (ts.isBinaryExpression(bare(target))) {
        const bin = bare(target) as ts.BinaryExpression
        const state = bare(isState(bin.left) ? bin.left : bin.right) as ts.PropertyAccessExpression
        if (ts.isIdentifier(state.expression)) readings.add(state.expression.text)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  const holdsReading = (node: ts.Expression): boolean => {
    let n = bare(node)
    if (hasValueCheck(n)) return true
    let first: string | undefined
    while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) || ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n)) {
      if (ts.isPropertyAccessExpression(n)) first = n.name.text
      n = ts.isCallExpression(n) ? n.expression : (n as ts.PropertyAccessExpression).expression
    }
    if (!ts.isIdentifier(n)) return false
    return derived.has(n.text) || (readings.has(n.text) && first === 'value')
  }
  const isNothing = (node: ts.Expression) => {
    const n = bare(node)
    return n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined')
  }
  // Derived: unknown kept as null (`check ? r.value… : null`, also inside useMemo) or bound straight to `r.value…`.
  const bind = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init = bare(node.initializer)
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useMemo' && init.arguments[0]
        && ts.isArrowFunction(init.arguments[0]) && !ts.isBlock(init.arguments[0].body)) init = bare(init.arguments[0].body as ts.Expression)
      const check = ts.isConditionalExpression(init) ? valueCheck(init.condition) : undefined
      const foldsToNothing = ts.isConditionalExpression(init) && check !== undefined && isNothing(check ? init.whenFalse : init.whenTrue)
      if (foldsToNothing || (!hasValueCheck(init) && holdsReading(init))) derived.add(node.name.text)
    }
    ts.forEachChild(node, bind)
  }
  bind(source)
  // A justified exception says why on the line above: `@@@reading-default - <reason>` (a bare marker still counts).
  const marked = (node: ts.Node) => {
    let statement: ts.Node = node
    while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) statement = statement.parent
    return (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).some((range) => /@@@reading-default\s*-\s*\S/.test(text.slice(range.pos, range.end)))
  }
  const hit = (node: ts.Node) => { if (!marked(node)) lines.add(source.getLineAndCharacterOfPosition(node.getStart()).line + 1) }
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node)) {
      const check = valueCheck(node.condition)
      if (check !== undefined && isLiteralDefault(check ? node.whenFalse : node.whenTrue)) hit(node)
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
      && isLiteralDefault(node.right) && holdsReading(node.left)) hit(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...lines].sort((a, b) => a - b)
}

/** `{ relative path: lines }` for every non-test source file with a reading collapsed to a literal default. */
export function scanLiteralDefaults(root = '.'): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const path of sourceFiles(join(root, SOURCE_ROOT)).sort()) {
    const rel = relative(root, path).split('\\').join('/')
    if (isTest(rel)) continue
    const lines = literalDefaultLines(rel, readFileSync(path, 'utf8'))
    if (lines.length > 0) out[rel] = lines
  }
  return out
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

const REPLICA_MODULE = 'apps/desktop/src/lib/replica.ts'
/** React-query's read and fetch-state hooks: only the replica reads through them (lib/replica.ts). */
const REACT_QUERY_READS = new Set(['useQuery', 'useQueries', 'useInfiniteQuery', 'useSuspenseQuery', 'useSuspenseQueries', 'useIsFetching', 'useQueryClient', 'usePrefetchQuery'])

/** Lines in this file that reach react-query past the replica: a read / fetch-state hook, or a method of the client. */
export function reactQueryLines(path: string, text: string): number[] {
  if (path === REPLICA_MODULE || isTest(path)) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines = new Set<number>()
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && REACT_QUERY_READS.has(node.text)) lines.add(line(node))
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'queryClient') lines.add(line(node))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...lines].sort((a, b) => a - b)
}

/** `{ relative path: lines }` for every non-test source file that reaches react-query past the replica. */
export function scanReactQuery(root = '.'): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const path of sourceFiles(join(root, SOURCE_ROOT)).sort()) {
    const rel = relative(root, path).split('\\').join('/')
    const lines = reactQueryLines(rel, readFileSync(path, 'utf8'))
    if (lines.length > 0) out[rel] = lines
  }
  return out
}

if (process.argv[1]?.endsWith('effect-fetch-state.mts')) {
  const report = (title: string, hits: Record<string, number[]>) => {
    for (const [file, lines] of Object.entries(hits)) console.log(`${title}: ${file}: ${lines.join(', ')}`)
    return Object.keys(hits).length
  }
  const effects = Object.fromEntries(Object.keys(scanEffectFetchState()).map((file) => [file, effectLines(file, readFileSync(file, 'utf8'))]))
  const found = report('effect fills component state with a read', effects)
    + report('reading collapsed to a literal default', scanLiteralDefaults())
    + report('react-query reached past the replica', scanReactQuery())
  if (found > 0) {
    console.log('Read what a surface shows through a replica (lib/replica.ts); branch on unknown / value / error — docs/design/client-state-model.md')
    process.exit(1)
  }
  console.log('effect-fetch-state: clean')
}
