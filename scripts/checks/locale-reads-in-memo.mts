// @@@locale-input gate — the UI language is an input of whatever keeps a result. A `useMemo` body, and the render of a
// `memo()` / `observer()` component, run again only when their inputs change; one that reads the global language
// (`translateSessionMessage`, `i18n`, `getLocaleSnapshot`, a formatter left to the global locale) keeps the words of the
// language it last ran in, until something else happens to redraw it. Those read the language through a hook instead —
// `useSessionMessages().translate`, react-i18next's `t`, `useLocale().resolvedLocale` passed to the formatter — so a
// switch is a change of input.
//
// A memoized component that itself calls one of those hooks is drawn again on a switch, so its render may read the
// global; a `useMemo` body may not, whatever its component reads. Told the language (`i18n.t(key, { lng })`, a formatter
// given its locale) is not a read of the global.
//
// What it sees: a direct reference in the synchronous part (a function nested inside is called later, when the global
// is current: an event handler, a callback handed on). What it does not see: a helper function that reads the global
// for you; type-aware tracing of those costs a whole TS program per run, and a helper is fixed by taking the language
// (or `translate`) as a parameter. Effects are out of scope: an effect body that translates mostly says something at
// the moment (a toast, a failure line).
//
// `node scripts/checks/locale-reads-in-memo.mts` prints every finding and exits 1 if there is one. No baseline.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const SOURCE_ROOT = 'apps/desktop/src'
const isTest = (path: string) => /\.(test|spec|stories)\.tsx?$/.test(path) || /\/(tests|__tests__)\//.test(path)

/** The modules that hand out the global language, and what each reads it through. */
const LOCALE_MODULE = /(^|\/)i18n(\/(index|runtime|format))?$|(^|\/)localization\/locale-store$/
const READERS = new Set(['i18n', 'getLocaleSnapshot', 'getSessionLocaleSnapshot', 'translateSessionMessage'])
/** Formatters that fall back to the global language when not given one: the argument count that gives one. */
const FORMATTERS: Record<string, number> = { formatCalendarDay: 3, formatClock: 2, formatNumber: 3, formatDate: 3, metadataSeparator: 1 }
/** The hooks that redraw a component when the language changes. */
const SUBSCRIBERS = new Set(['useLocale', 'useSessionMessages', 'useTranslation', 'useMessages'])

/** `i18n.t(key, { lng })`: told which language, not reading the global one. */
function explicitLanguage(node: ts.Identifier): boolean {
  const parent = node.parent
  const call = parent.parent
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || !ts.isCallExpression(call) || call.expression !== parent) return false
  return call.arguments.some((arg) => ts.isObjectLiteralExpression(arg)
    && arg.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === 'lng'))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const calleeName = (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''

/** Lines of `code` where a memo body or a memoized component's render reads the global language directly. */
export function localeReadLines(path: string, code: string): number[] {
  if (isTest(path)) return []
  const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  // Local names bound to a reader or a formatter of the locale modules (renamed imports included).
  const readers = new Map<string, string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!LOCALE_MODULE.test(statement.moduleSpecifier.text)) continue
    const named = statement.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (READERS.has(imported) || imported in FORMATTERS) readers.set(element.name.text, imported)
    }
  }
  if (readers.size === 0) return []
  // A component that reads the language through a hook is drawn again when it changes: its render may read the global.
  const subscribes = (body: ts.Node): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found || (node !== body && ts.isFunctionLike(node))) return
      if (ts.isCallExpression(node) && SUBSCRIBERS.has(calleeName(node))) found = true
      ts.forEachChild(node, visit)
    }
    visit(body)
    return found
  }
  const lines = new Set<number>()
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  // The synchronous part of `body`: nested functions run later, with the global current.
  const scan = (body: ts.Node, render: boolean) => {
    if (render && subscribes(body)) return
    const visit = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return
      if (ts.isIdentifier(node) && readers.has(node.text)) {
        const parent = node.parent
        const imported = readers.get(node.text)!
        const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isPropertyAssignment(parent) && parent.name === node
          // Handed on as a prop (`<MessageProvider locale={…} translate={translateSessionMessage}>`): the receiver is given
          // the language beside it, or reads it when it draws.
          || ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)
        const given = imported in FORMATTERS && ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length >= FORMATTERS[imported]
          || explicitLanguage(node)
        if (!isName && !given) lines.add(lineOf(node))
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      const fn = node.arguments[0]
      if (name === 'useMemo' && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) scan(fn.body, false)
      if (name === 'memo' || name === 'observer') {
        let inner: ts.Expression | undefined = fn
        while (inner && ts.isCallExpression(inner)) inner = inner.arguments[0] // observer(forwardRef(fn))
        if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) scan(inner.body, true)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...lines].sort((a, b) => a - b)
}

export function scanLocaleReads(root = '.'): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const path of sourceFiles(join(root, SOURCE_ROOT)).sort()) {
    const rel = relative(root, path).split('\\').join('/')
    const lines = localeReadLines(rel, readFileSync(path, 'utf8'))
    if (lines.length > 0) out[rel] = lines
  }
  return out
}

if (process.argv[1]?.endsWith('locale-reads-in-memo.mts')) {
  const found = scanLocaleReads()
  for (const [file, lines] of Object.entries(found)) console.log(`reads the global language where the result is kept: ${file}: ${lines.join(', ')}`)
  if (Object.keys(found).length > 0) {
    console.log('Read the language through a hook — useSessionMessages().translate, useTranslation().t, useLocale().resolvedLocale — so a switch is a change of input.')
    process.exit(1)
  }
  console.log('locale-reads-in-memo: clean')
}
