// @@@client-state-model — why this shape is debt and what replaces it: docs/design/client-state-model.md.
// @@@replica ratchet (open-flicker, owner 2026-11-14): data a surface shows lives in a replica (lib/replica.ts),
// not in component state filled by an effect. The shape this finds is the old one: a `useEffect` whose callback reads
// something asynchronously (a `.then` / `.catch` / `.finally` callback or a setter handed to one, an async function, or
// a call to one of the component's own functions that does either) and puts the answer into a `useState` setter of the
// same component. Until it answers, the component draws the state's initial value as if
// it were the stored one — that is what flickers when a surface opens.
//
// An effect of that shape that is not a read of what a surface shows, and a reading defaulted on purpose, are listed in
// effect-fetch-state-exemptions.txt beside this file, one line each: `<path>: effect-flow(<category>) - <reason>` or
// `<path>: reading-default(<category>) - <reason>`. Per file and kind there are as many entries as findings: one more
// finding is not exempt, one fewer is a stale entry. The categories are the fixed lists below (EXEMPTIONS); an entry
// without one, with one not listed, or without a reason is itself a finding, printed with what each category takes and
// what it does not. A read put into component state fits no category: it goes through a replica.
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

export type ExemptionKind = keyof typeof EXEMPTIONS
const EXEMPTIONS_FILE = 'scripts/checks/effect-fetch-state-exemptions.txt'
const FINDING = { 'effect-flow': 'an effect fills component state with a read', 'reading-default': 'a reading collapsed to a literal default' }
const ENTRY = /^(.+?): (effect-flow|reading-default)\(([^)]*)\) - ?(.*)$/

/** What each category takes and does not, for a finding. */
export const categoryHelp = (): string => Object.entries(EXEMPTIONS).flatMap(([kind, categories]) => Object.entries(categories)
  .map(([name, [takes, not]]) => `  ${kind}(${name}): takes ${takes}; ${not}.`)).join('\n')

/** The entries of the exemption list (a line starting with `#` is a comment). */
export const readExemptions = (root = '.'): string[] =>
  readFileSync(join(root, EXEMPTIONS_FILE), 'utf8').split('\n').filter((line) => line.trim() && !line.startsWith('#'))

/**
 * What is wrong between the findings (`{ kind: { repo path: lines } }`) and the list: an entry that is not in a listed
 * category with a reason, and per file and kind a count that differs from the findings'.
 */
export function exemptionProblems(found: Record<ExemptionKind, Record<string, number[]>>, entries: string[]): string[] {
  const problems: string[] = []
  const listed = new Map<string, number>()
  for (const entry of entries) {
    const match = ENTRY.exec(entry)
    if (!match) { problems.push(`not \`<path>: <kind>(<category>) - <reason>\`: ${entry}`); continue }
    const [, path, kind, category, reason] = match as unknown as [string, string, ExemptionKind, string, string]
    const categories = EXEMPTIONS[kind] as Record<string, readonly [string, string]>
    if (!(category in categories)) problems.push(`${path}: ${kind} category "${category}" is not one of ${Object.keys(categories).join(', ')}`)
    else if (!reason.trim()) problems.push(`${path}: ${kind}(${category}) has no reason`)
    else if (category === 'paired' && !/`[^`]+`/.test(reason)) problems.push(`${path}: a paired exemption names its flag in backticks`)
    listed.set(`${path}: ${kind}`, (listed.get(`${path}: ${kind}`) ?? 0) + 1)
  }
  const keys = new Set(listed.keys())
  for (const [kind, hits] of Object.entries(found)) for (const path of Object.keys(hits)) keys.add(`${path.slice(SOURCE_ROOT.length + 1)}: ${kind}`)
  for (const key of [...keys].sort()) {
    const [path, kind] = key.split(': ') as [string, ExemptionKind]
    const lines = found[kind][`${SOURCE_ROOT}/${path}`] ?? [], count = listed.get(key) ?? 0
    if (lines.length > count) problems.push(`${key} at line ${lines.join(', ')}: ${lines.length} found, ${count} listed (${FINDING[kind]})`)
    if (lines.length < count) problems.push(`${key}: ${count} listed, ${lines.length} found: remove the stale entry`)
  }
  return problems
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
        if (callback && setsStateAfterRead(callback, setters, readers)) lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
        return
      }
      ts.forEachChild(node, walk)
    }
    if (fn.body) walk(fn.body)
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
  const hit = (node: ts.Node) => { lines.add(source.getLineAndCharacterOfPosition(node.getStart()).line + 1) }
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

/** `{ relative path: lines }` for every non-test source file with a reading collapsed to a literal default (listed or not). */
export const scanLiteralDefaults = (root = '.') => scanSource(literalDefaultLines, root)

/** `{ relative path: lines }` for every non-test source file that has the shape (listed or not). */
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
  const problems = exemptionProblems({ 'effect-flow': scanEffectFetchState(), 'reading-default': scanLiteralDefaults() }, readExemptions())
  for (const problem of problems) console.log(`exemption: ${problem}`)
  if (problems.length > 0) console.log(categoryHelp())
  const found = problems.length + report('react-query reached past the replica', scanReactQuery())
    + report('a reading\'s retry is its own: `<RefreshFailed reading={r} />`, `<ReadingSlot>`, or `r.retry`', scanHandRetries())
  if (found > 0) {
    console.log('Read what a surface shows through a replica (lib/replica.ts); branch on unknown / value / error — docs/design/client-state-model.md')
    process.exit(1)
  }
  console.log('effect-fetch-state: clean')
}
