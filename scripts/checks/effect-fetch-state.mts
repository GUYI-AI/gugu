// @@@client-state-model — why this shape is debt and what replaces it: docs/design/client-state-model.md.
// @@@replica ratchet (open-flicker, owner 2026-11-14): data a surface shows lives in a replica (lib/replica.ts),
// not in component state filled by an effect. The shape this finds is the old one: a `useEffect` whose callback reads
// something asynchronously (a `.then` / `.catch` / `.finally` callback or a setter handed to one, an async function, or
// a call to one of the component's own functions that does either) and puts the answer into a `useState` setter of the
// same component. Until it answers, the component draws the state's initial value as if
// it were the stored one — that is what flickers when a surface opens.
//
// An effect that is not a read of what a surface shows says which kind it is on the line above:
// `@@@effect-flow(<category>) - <reason>`; a reading defaulted on purpose likewise: `@@@reading-default(<category>) -
// <reason>`. The categories are the fixed lists below (EXEMPTIONS); a marker without one, with one not listed, or without
// a reason is itself a finding, and the finding prints what the category takes and what it does not. A read put into
// component state fits no category: it goes through a replica.
//
// A hard rule (there is no baseline): no source file has the shape, no reading is collapsed to a
// literal default (`--defaults`), and nothing outside lib/replica.ts reaches react-query directly — its read hooks, the
// fetch-state hooks, or the client's own methods (`queryClient.…`); writes may still use `useMutation` with the client;
// and no surface hands a reading's failure a retry it wrote itself (`onRetry={() => model.refresh(…)}`,
// `onClick={() => model.refresh(args)}`): a reading carries its own (`retryOf(reading)`, `<RefreshFailed reading={r} />`,
// `<ReadingSlot>`).
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

/** `{ relative path: lines }` for every non-test source file where `linesOf` finds something, sorted by path. */
function scanSource(linesOf: (path: string, text: string) => number[], root: string): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const path of sourceFiles(join(root, SOURCE_ROOT)).sort()) {
    const rel = relative(root, path).split('\\').join('/')
    if (isTest(rel)) continue
    const lines = linesOf(rel, readFileSync(path, 'utf8'))
    if (lines.length > 0) out[rel] = lines
  }
  return out
}

/**
 * The exemption categories, a closed list so an exemption is a reason a reviewer can check. Each: what it takes, and what it
 * does not (printed with a finding). Nothing outside these lists is exempt.
 */
export const EXEMPTIONS = {
  'effect-flow': {
    render: ['renders content already in hand (docx/pptx/xlsx/pdf/mermaid/markdown, an image decode)', 'not a read from a server, host or disk'],
    dom: ['DOM measuring and observing (IntersectionObserver, ResizeObserver, scroll anchoring, viewport)', 'not data the surface shows'],
    input: ['listens to user input (keyboard, pointer, clipboard)', 'not a read of what the input refers to'],
    command: ['one execution this effect starts itself; state holds only that execution\'s result', 'not polling state or progress someone else produces (a read: `refreshEvery`), not "open, read, show"'],
    lifecycle: ['holds and releases a resource for the component\'s life (session page mount, App activation handle, workspace lease, preview URL registration, live projection attach); state holds only its handle or connection state', 'not the data that resource serves'],
    outbox: ['the outbox sending (queued input released)', 'not a read'],
    event: ['a one-off event or a listener registration that puts no data in component state (system share, a revision listener); state at most a local UI flag', 'not "subscribe to a store\'s value, then setState" (`useSelect`), not pushed data the surface draws'],
    'view-state': ['restores what this surface itself saved (a draft, a scroll position)', 'not server or host data'],
    code: ['lazy-loads a code module (emoji picker, image viewer, chat UI module)', 'not data'],
  },
  'reading-default': {
    moment: ['a decision at one moment outside rendering (a click, after a write, before a send); the value is not drawn', 'not anything a render path draws'],
    route: ['a routing or dispatch decision (which machine, which line)', 'not anything drawn'],
    paired: ['the same return value carries a "not known yet" flag every reader branches on, so the default is never drawn; the reason names the flag in backticks', 'not a default a reader can draw'],
  },
} as const

type MarkerKind = keyof typeof EXEMPTIONS
/** A marker as written: its kind, category and reason, and what is wrong with it (null = a valid exemption). */
export type Marker = { kind: MarkerKind; category: string | null; reason: string; problem: string | null }

const MARKER = /@@@(effect-flow|reading-default)(?:\(([^)]*)\))?(?:\s*-\s*(.*))?/

/** Parse the marker in a comment, if any. */
export function parseMarker(comment: string): Marker | null {
  const match = MARKER.exec(comment)
  if (!match) return null
  const kind = match[1] as MarkerKind
  const category = match[2]?.trim() || null
  const reason = (match[3] ?? '').replace(/\*\/\s*$/, '').trim()
  const categories = EXEMPTIONS[kind] as Record<string, readonly [string, string]>
  let problem: string | null = null
  if (!category) problem = 'no category'
  else if (!(category in categories)) problem = `category "${category}" is not one of ${Object.keys(categories).join(', ')}`
  else if (!reason) problem = 'no reason'
  else if (kind === 'reading-default' && category === 'paired' && !/`[^`]+`/.test(reason)) problem = 'a paired exemption names its flag in backticks'
  return { kind, category, reason, problem }
}

/** What each category takes and does not, for a finding. */
export function categoryHelp(kind: MarkerKind): string {
  return Object.entries(EXEMPTIONS[kind] as Record<string, readonly [string, string]>)
    .map(([name, [takes, not]]) => `  ${kind}(${name}): takes ${takes}; ${not}.`).join('\n')
}

/** The markers of a file with their 1-based lines (every one, flagged by the scans or not). */
export function markerLines(path: string, text: string): Array<Marker & { line: number }> {
  const out: Array<Marker & { line: number }> = []
  text.split('\n').forEach((line, index) => {
    if (!line.includes('@@@effect-flow') && !line.includes('@@@reading-default')) return
    const marker = parseMarker(line)
    if (marker) out.push({ ...marker, line: index + 1 })
  })
  return out
}

/** Markers that are not valid exemptions, `{ path: lines }`. */
export const scanMarkers = (root = '.') =>
  scanSource((path, text) => markerLines(path, text).filter((marker) => marker.problem).map((marker) => marker.line), root)


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

/** In an `event` effect: a setter handed over as a callback, or a listener's argument put into a setter. */
function eventSetsData(callback: ts.Node, setters: Set<string>): boolean {
  let found = false
  const mentions = (node: ts.Node, names: Set<string>): boolean => {
    if (ts.isIdentifier(node) && names.has(node.text)) return true
    return ts.forEachChild(node, (child) => mentions(child, names) || undefined) ?? false
  }
  const visit = (node: ts.Node, payloads: Set<string>): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      if (node.arguments.some((argument) => ts.isIdentifier(argument) && setters.has(argument.text))) { found = true; return }
      const name = calleeName(node)
      if (name && setters.has(name) && payloads.size > 0 && node.arguments.some((argument) => mentions(argument, payloads))) { found = true; return }
      for (const argument of node.arguments) {
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
          const params = new Set(payloads)
          for (const param of argument.parameters) if (ts.isIdentifier(param.name)) params.add(param.name.text)
          visit(argument.body, params)
        } else visit(argument, payloads)
      }
      visit(node.expression, payloads)
      return
    }
    ts.forEachChild(node, (child) => visit(child, payloads))
  }
  visit(callback, new Set())
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
        const marker = markedFlow(node)
        const shaped = callback && setsStateAfterRead(callback, setters, readers)
        // An `event` exemption puts no pushed data in state: a setter handed to a listener, or a listener's payload put
        // into a setter, is the shape again whatever the marker says.
        if (callback && (shaped || marker?.category === 'event') && (!marker || (marker.category === 'event' && eventSetsData(callback, setters)))) {
          lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
        }
        return
      }
      ts.forEachChild(node, walk)
    }
    if (fn.body) walk(fn.body)
  }
  /** The valid `@@@effect-flow(<category>)` exemption on the line above the effect, if any. */
  const markedFlow = (call: ts.Node): Marker | null => {
    let statement: ts.Node = call
    while (statement.parent && !ts.isExpressionStatement(statement) && !ts.isBlock(statement.parent)) statement = statement.parent
    for (const range of ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []) {
      const marker = parseMarker(text.slice(range.pos, range.end))
      if (marker?.kind === 'effect-flow' && !marker.problem) return marker
    }
    return null
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
 * value. Branch on the reading's three states instead. Literal = `[]`, `{}`, a number, a string, `false`, an `EMPTY_*` / `NO_*`
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
    // This codebase names its empty constants `EMPTY_*` or `NO_*` (`NO_PLATFORM_CATALOG`, `NO_SCHEDULES`).
    return ts.isIdentifier(n) && /^(EMPTY|NO)_[A-Z0-9_]+$/.test(n.text)
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
  // A justified exception says why on the line above: `@@@reading-default(<category>) - <reason>` (EXEMPTIONS).
  const marked = (node: ts.Node) => {
    let statement: ts.Node = node
    while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) statement = statement.parent
    return (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).some((range) => { const marker = parseMarker(text.slice(range.pos, range.end)); return marker?.kind === 'reading-default' && !marker.problem })
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
export const scanLiteralDefaults = (root = '.') => scanSource(literalDefaultLines, root)

/** `{ relative path: lines }` for every non-test source file that still has the shape. */
export const scanEffectFetchState = (root = '.') => scanSource(effectLines, root)

const REPLICA_MODULE = 'apps/desktop/src/lib/replica.ts'
/**
 * What a module other than the replica may import from react-query: writes and their state, the provider, and the
 * structural-sharing helper. Anything else (a read or fetch-state hook, an observer, a client of its own, a namespace or
 * default import) reads past the replica, whatever it is renamed to.
 */
const REACT_QUERY_ALLOWED = new Set(['useMutation', 'useMutationState', 'QueryClientProvider', 'replaceEqualDeep'])
const REACT_QUERY_MODULE = /^@tanstack\/(react-)?query(-core)?$/

/** Lines in this file that reach react-query past the replica: a read / fetch-state hook, or a method of the client. */
export function reactQueryLines(path: string, text: string): number[] {
  if (path === REPLICA_MODULE || isTest(path)) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines = new Set<number>()
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    // Imports and re-exports from react-query: only the allowed names (types are not a read).
    const from = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text : null
    if (from && REACT_QUERY_MODULE.test(from) && !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
      const named = ts.isImportDeclaration(node) ? clause?.namedBindings : (node as ts.ExportDeclaration).exportClause
      const wholesale = (ts.isImportDeclaration(node) && (!clause || !!clause.name || (named && ts.isNamespaceImport(named))))
        || (ts.isExportDeclaration(node) && (!named || ts.isNamespaceExport(named)))
      const disallowed = named && (ts.isNamedImports(named) || ts.isNamedExports(named))
        ? named.elements.some((element) => !element.isTypeOnly && !REACT_QUERY_ALLOWED.has((element.propertyName ?? element.name).text))
        : false
      if (wholesale || disallowed) lines.add(line(node))
    }
    // A dynamic import of react-query, and a method of the replica's client.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && REACT_QUERY_MODULE.test(node.arguments[0].text)) lines.add(line(node))
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'queryClient') lines.add(line(node))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...lines].sort((a, b) => a - b)
}

/** `{ relative path: lines }` for every non-test source file that reaches react-query past the replica. */
export const scanReactQuery = (root = '.') => scanSource(reactQueryLines, root)

/** Props that hand a component its retry: whatever refresh they wrap, it is a retry. */
const RETRY_PROPS = new Set(['onRetry', 'onReadAgain'])

/** The one call an arrow / function body makes, when that is all it does (`void` and a block of one statement unwrapped). */
function soleCall(body: ts.Node): ts.CallExpression | null {
  let node: ts.Node = body
  if (ts.isBlock(node)) {
    if (node.statements.length !== 1 || !ts.isExpressionStatement(node.statements[0]!)) return null
    node = node.statements[0]!.expression
  }
  while (ts.isVoidExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression
  return ts.isCallExpression(node) ? node : null
}

const isRefresh = (node: ts.Expression) => ts.isPropertyAccessExpression(node) && node.name.text === 'refresh'

/**
 * The 1-based lines of a JSX handler written as a hand retry for one reading (it carries its own, `retryOf(reading)`):
 * - `onRetry` / `onReadAgain` given a function that only calls `model.refresh(…)`;
 * - any other handler (`onClick`, …) that only calls `model.refresh(…)` with the reading's arguments.
 * Not this shape: a handler that does several things (two readings, a write then a read), and a click that refreshes a
 * whole model (`model.refresh()`, no arguments: a page's refresh command over every entry it shows).
 */
export function handRetryLines(path: string, text: string): number[] {
  if (!path.endsWith('.tsx')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const name = node.name.getText(source), value = node.initializer.expression
      const retryProp = RETRY_PROPS.has(name)
      const call = ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? soleCall(value.body) : null
      const hand = call !== null && isRefresh(call.expression) && (retryProp || call.arguments.length > 0)
      if (hand) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return lines
}

/** `{ relative path: lines }` for every non-test source file with a hand-written retry for a reading. */
export const scanHandRetries = (root = '.') => scanSource(handRetryLines, root)

if (process.argv[1]?.endsWith('effect-fetch-state.mts')) {
  const report = (title: string, hits: Record<string, number[]>) => {
    for (const [file, lines] of Object.entries(hits)) console.log(`${title}: ${file}: ${lines.join(', ')}`)
    return Object.keys(hits).length
  }
  const found = report('effect fills component state with a read', scanEffectFetchState())
    + report('reading collapsed to a literal default', scanLiteralDefaults())
    + report('react-query reached past the replica', scanReactQuery())
    + report('a reading\'s retry is its own: `<RefreshFailed reading={r} />`, `<ReadingSlot>`, or `r.retry`', scanHandRetries())
  const markers = scanMarkers()
  for (const [file, lines] of Object.entries(markers)) {
    const text = readFileSync(file, 'utf8')
    for (const marker of markerLines(file, text).filter((item) => lines.includes(item.line))) {
      console.log(`exemption marker: ${file}:${marker.line}: ${marker.problem}\n${categoryHelp(marker.kind)}`)
    }
  }
  if (process.argv.includes('--table')) {
    for (const path of sourceFiles(SOURCE_ROOT).sort()) {
      if (isTest(path)) continue
      for (const marker of markerLines(path, readFileSync(path, 'utf8'))) console.log(`| ${path}:${marker.line} | ${marker.kind}(${marker.category ?? '—'}) | ${marker.reason.replace(/\|/g, '/')} |`)
    }
  }
  if (found + Object.keys(markers).length > 0) {
    console.log('Read what a surface shows through a replica (lib/replica.ts); branch on unknown / value / error — docs/design/client-state-model.md')
    process.exit(1)
  }
  console.log('effect-fetch-state: clean')
}
