import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')
type Node = import('typescript').Node

/**
 * Every user-visible string must exist in both zh-CN and en-US. This check fails on two shapes:
 * - `user-visible`: a CJK literal in renderer source that is not routed through a catalog;
 * - `english-catalog`: a CJK value inside an English catalog (it renders Chinese in the English UI).
 * Chinese that legitimately stays in source (a bilingual catalog keyed by locale, text an agent reads,
 * data such as sample content or matching tables) is listed file by file, with a reason, in
 * `hardcoded-cjk-exceptions.json`. An exception that no longer matches anything fails as stale.
 *
 * @@@roots - the renderer and the session UI packages. Core is also checked at direct Error message
 * and string-throw sites, where diagnostics can cross IPC into a UI. Its existing exceptions are pinned
 * by file and complete expression in coreErrorDebt, counted separately, and fail when changed or removed.
 * Prompts and ordinary data in core are outside this error-only scan. The main process (`apps/desktop/electron`) is
 * not a root: most CJK there is agent-facing tool text or diagnostics, and its user-visible strings
 * (dialogs, tray, menus, notifications) go through `apps/desktop/shared/host-localization.ts`, whose
 * en-US block is checked here as an English catalog.
 */
export type HardcodedCjkCategory = 'user-visible' | 'english-catalog' | 'excepted' | 'developer' | 'false-positive' | 'legacy-core-error'
export type HardcodedCjkExceptionClass = 'C' | 'D' | 'E'

export interface HardcodedCjkRow {
  file: string
  line: number
  column: number
  kind: string
  text: string
  category: HardcodedCjkCategory
  reason: string
}

export interface HardcodedCjkException {
  file: string
  text?: string
  class: HardcodedCjkExceptionClass
  reason: string
}

export interface HardcodedCjkExceptions {
  englishCatalogAllowed: { text: string; reason: string }[]
  exceptions: HardcodedCjkException[]
  coreErrorDebt: { file: string; text: string; reason: string }[]
}

export interface HardcodedCjkAudit {
  total: number
  categories: Record<HardcodedCjkCategory, number>
  fileDistribution: Record<HardcodedCjkCategory, Record<string, number>>
  rows: HardcodedCjkRow[]
  failures: HardcodedCjkRow[]
  staleExceptions: string[]
}

export interface HardcodedCjkOptions {
  roots?: readonly string[]
  errorRoots?: readonly string[]
  exceptionsFile?: string
}

const CJK = /[㐀-鿿]/u
const CJK_GLOBAL = /[㐀-鿿]/gu
const CATEGORIES: readonly HardcodedCjkCategory[] = ['user-visible', 'english-catalog', 'excepted', 'developer', 'false-positive', 'legacy-core-error']
const FAILING: ReadonlySet<HardcodedCjkCategory> = new Set(['user-visible', 'english-catalog'])

export const DEFAULT_ROOTS = [
  'apps/desktop/src',
  'packages/session-ui/src',
  'packages/session-chat-ui/src',
  'apps/desktop/shared/host-localization.ts',
] as const
export const DEFAULT_EXCEPTIONS_FILE = 'scripts/checks/hardcoded-cjk-exceptions.json'
export const DEFAULT_ERROR_ROOTS = ['packages/core/src'] as const

/**
 * Catalog files. Inside an `english` block every CJK value fails unless `englishCatalogAllowed` covers it;
 * a `translation` block is the Chinese side and is not scanned. A block is the nearest enclosing variable
 * or property whose name matches; `'file'` means the whole file.
 */
interface CatalogFile {
  file: RegExp
  english?: RegExp | 'file'
  translation?: RegExp | 'file'
}

const CATALOGS: readonly CatalogFile[] = [
  { file: /^apps\/desktop\/src\/i18n\/locales\/en-US\//, english: 'file' },
  { file: /^apps\/desktop\/src\/i18n\/locales\/(?!en-US\/)[^/]+\//, translation: 'file' },
  {
    file: /^apps\/desktop\/src\/session\/renderer\/localization\/messages[^/]*\.ts$/,
    english: /^enUS/,
    translation: /^zhCN/,
  },
  { file: /^packages\/session-chat-ui\/src\/localization\.tsx$/, english: /^fallbackMessages$/ },
  { file: /^apps\/desktop\/src\/features\/team\/catalog\.ts$/, english: /^en$/, translation: /^zh$/ },
]

function toPosix(file: string): string {
  return file.split(path.sep).join('/')
}

function isScannedSource(relative: string): boolean {
  return /\.tsx?$/.test(relative)
    && !/\.(?:test|spec|stories)\.[^.]+$/.test(relative)
    && !/(?:^|\/)(?:tests|__tests__|fixtures|__fixtures__)\//.test(relative)
}

function sourceFilesBelow(root: string, target: string): string[] {
  const absolute = path.resolve(root, target)
  if (!existsSync(absolute)) throw new Error(`hardcoded-cjk-audit: root does not exist: ${target}`)
  if (statSync(absolute).isFile()) return [toPosix(path.relative(root, absolute))]
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? sourceFilesBelow(root, path.join(target, entry.name))
      : [toPosix(path.join(target, entry.name))])
    .filter(isScannedSource)
    .sort()
}

function isTextNode(node: Node): node is import('typescript').LiteralLikeNode | import('typescript').JsxText {
  return ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateHead(node)
    || ts.isTemplateMiddle(node)
    || ts.isTemplateTail(node)
    || ts.isJsxText(node)
    || ts.isRegularExpressionLiteral(node)
}

function textValue(node: import('typescript').LiteralLikeNode | import('typescript').JsxText, sourceFile: import('typescript').SourceFile): string {
  return ts.isJsxText(node) ? node.getText(sourceFile) : node.text ?? node.getText(sourceFile)
}

function enclosingCall(node: Node): import('typescript').CallExpression | import('typescript').NewExpression | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) return current
    if (ts.isStatement(current) || ts.isJsxElement(current) || ts.isJsxAttribute(current)) return null
  }
  return null
}

function stylesheetPayload(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current) && current.openingElement.tagName.getText() === 'style') return true
    if (ts.isVariableDeclaration(current) && /(?:CSS|STYLES?)$/i.test(current.name.getText())) return true
    if (ts.isTaggedTemplateExpression(current) && /(?:css|style|styled)$/i.test(current.tag.getText())) return true
    if (ts.isStatement(current)) return false
  }
  return false
}

function diagnosticLoggerCall(call: Node): boolean {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false
  const receiver = call.expression.expression.getText()
  const method = call.expression.name.text
  return /^(?:debug|info|log|warn|error)$/.test(method)
    && (receiver === 'console' || /(?:log|logger)$/i.test(receiver))
}

function isStructuralPropertyName(node: Node): boolean {
  const parent = node.parent
  return (ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isMethodSignature(parent))
    && parent.name === node
}

function blockName(node: Node): string | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text
  return null
}

const ENGLISH_LOCALE_KEYS: ReadonlySet<string> = new Set(['en-US', 'en'])
const CHINESE_LOCALE_KEYS: ReadonlySet<string> = new Set(['zh-CN', 'zh'])

/**
 * @@@locale-keyed - an object literal keyed by locale (`{ 'zh-CN': …, 'en-US': … }`, the shape every
 * `registerLocaleNamespace` call and the local bilingual tables use) is a catalog wherever it appears:
 * the Chinese side is skipped only when the same object also has an English side, and the English side
 * is checked like any English catalog.
 */
function localeKeyedRole(node: Node): 'english' | 'translation' | null {
  if (!ts.isPropertyAssignment(node) || !ts.isObjectLiteralExpression(node.parent)) return null
  const name = blockName(node)
  if (name === null) return null
  if (ENGLISH_LOCALE_KEYS.has(name)) return 'english'
  if (!CHINESE_LOCALE_KEYS.has(name)) return null
  const hasEnglish = node.parent.properties.some((property) => {
    const sibling = blockName(property)
    return sibling !== null && ENGLISH_LOCALE_KEYS.has(sibling)
  })
  return hasEnglish ? 'translation' : null
}

function catalogRole(node: Node, catalog: CatalogFile | undefined): 'english' | 'translation' | null {
  if (catalog?.english === 'file') return 'english'
  if (catalog?.translation === 'file') return 'translation'
  for (let current = node.parent; current; current = current.parent) {
    const keyed = localeKeyedRole(current)
    if (keyed) return keyed
    const name = blockName(current)
    if (name === null || !catalog) continue
    if (catalog.english instanceof RegExp && catalog.english.test(name)) return 'english'
    if (catalog.translation instanceof RegExp && catalog.translation.test(name)) return 'translation'
  }
  return null
}

function classifySource(node: Node, value: string): { category: HardcodedCjkCategory; reason: string } {
  if (ts.isRegularExpressionLiteral(node)) return { category: 'false-positive', reason: 'regular-expression' }
  if (isStructuralPropertyName(node) || ts.isLiteralTypeNode(node.parent)) {
    return { category: 'false-positive', reason: 'structural-literal' }
  }
  if (stylesheetPayload(node) && !CJK.test(value.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    return { category: 'false-positive', reason: 'stylesheet-comment' }
  }
  const cjkOnly = [...value.matchAll(CJK_GLOBAL)].map((match) => match[0]).join('')
  if (cjkOnly && /^咕+$/.test(cjkOnly)) return { category: 'false-positive', reason: 'brand-only' }

  const call = enclosingCall(node)
  if (call && diagnosticLoggerCall(call)) return { category: 'developer', reason: 'diagnostic-call' }
  return { category: 'user-visible', reason: 'product-value' }
}

export function loadExceptions(root: string, exceptionsFile: string = DEFAULT_EXCEPTIONS_FILE): HardcodedCjkExceptions {
  const parsed = JSON.parse(readFileSync(path.resolve(root, exceptionsFile), 'utf8')) as Partial<HardcodedCjkExceptions>
  const englishCatalogAllowed = parsed.englishCatalogAllowed ?? []
  const exceptions = parsed.exceptions ?? []
  const coreErrorDebt = parsed.coreErrorDebt ?? []
  for (const entry of englishCatalogAllowed) {
    if (!entry.text || !entry.reason) throw new Error(`hardcoded-cjk-audit: englishCatalogAllowed entry needs text and reason: ${JSON.stringify(entry)}`)
  }
  for (const entry of exceptions) {
    if (!entry.file || !entry.reason || !['C', 'D', 'E'].includes(entry.class)) {
      throw new Error(`hardcoded-cjk-audit: exception needs file, class C/D/E and reason: ${JSON.stringify(entry)}`)
    }
  }
  for (const entry of coreErrorDebt) {
    if (!entry.file || !entry.text || !entry.reason) throw new Error('hardcoded-cjk-audit: coreErrorDebt needs file, text and reason')
  }
  return { englishCatalogAllowed, exceptions, coreErrorDebt }
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Direct Error constructors/calls, including custom *Error classes, plus thrown strings/templates. */
function errorMessageArgument(node: Node): Node | undefined {
  if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
    const expression = node.expression
    const name = ts.isIdentifier(expression) ? expression.text
      : ts.isPropertyAccessExpression(expression) ? expression.name.text : ''
    if (/Error$/.test(name)) return node.arguments?.[name === 'AggregateError' ? 1 : 0]
  }
  if (ts.isThrowStatement(node) && node.expression
    && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression) || ts.isTemplateExpression(node.expression))) {
    return node.expression
  }
}

function hasCjkLiteral(node: Node, sourceFile: import('typescript').SourceFile): boolean {
  if (isTextNode(node) && !ts.isRegularExpressionLiteral(node) && CJK.test(textValue(node, sourceFile))) return true
  return ts.forEachChild(node, child => hasCjkLiteral(child, sourceFile) || undefined) === true
}

export function auditHardcodedCjk(root: string = process.cwd(), options: HardcodedCjkOptions = {}): HardcodedCjkAudit {
  const roots = options.roots ?? DEFAULT_ROOTS
  const errorRoots = options.errorRoots ?? (options.roots ? [] : DEFAULT_ERROR_ROOTS)
  const { englishCatalogAllowed, exceptions, coreErrorDebt } = loadExceptions(root, options.exceptionsFile)
  const usedAllowed = new Set<number>()
  const usedExceptions = new Set<number>()
  const usedCoreDebt = new Set<number>()
  const rows: HardcodedCjkRow[] = []

  const englishAllowed = (value: string): boolean => {
    let rest = value
    englishCatalogAllowed.forEach((entry, index) => {
      if (rest.includes(entry.text)) {
        usedAllowed.add(index)
        rest = rest.split(entry.text).join('')
      }
    })
    return !CJK.test(rest)
  }

  const excepted = (file: string, text: string): HardcodedCjkException | null => {
    const index = exceptions.findIndex((entry) => entry.file === file && (entry.text === undefined || normalized(entry.text) === text))
    if (index < 0) return null
    usedExceptions.add(index)
    return exceptions[index]!
  }

  for (const file of [...new Set(roots.flatMap((target) => sourceFilesBelow(root, target)))]) {
    const catalog = CATALOGS.find((candidate) => candidate.file.test(file))
    if (catalog?.translation === 'file') continue
    const sourceText = readFileSync(path.resolve(root, file), 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: Node): void => {
      if (isTextNode(node)) {
        const value = textValue(node, sourceFile)
        const role = CJK.test(value) ? catalogRole(node, catalog) : null
        if (CJK.test(value) && role !== 'translation') {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          const text = normalized(value)
          let verdict: { category: HardcodedCjkCategory; reason: string }
          if (role === 'english' && !isStructuralPropertyName(node)) {
            verdict = englishAllowed(value)
              ? { category: 'false-positive', reason: 'english-catalog-allowed' }
              : { category: 'english-catalog', reason: 'cjk-in-english-catalog' }
          } else {
            verdict = classifySource(node, value)
            if (verdict.category === 'user-visible') {
              const exception = excepted(file, text)
              if (exception) verdict = { category: 'excepted', reason: `${exception.class}: ${exception.reason}` }
            }
          }
          rows.push({
            file,
            line: position.line + 1,
            column: position.character + 1,
            kind: ts.SyntaxKind[node.kind],
            text,
            ...verdict,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  for (const file of [...new Set(errorRoots.flatMap(target => sourceFilesBelow(root, target)))]) {
    const sourceFile = ts.createSourceFile(file, readFileSync(path.resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: Node): void => {
      const message = errorMessageArgument(node)
      if (message && hasCjkLiteral(message, sourceFile)) {
        const text = normalized(message.getText(sourceFile))
        // Each debt entry admits one existing occurrence, not all future copies of that sentence.
        const index = coreErrorDebt.findIndex((entry, index) => !usedCoreDebt.has(index) && entry.file === file && entry.text === text)
        if (index >= 0) usedCoreDebt.add(index)
        const position = sourceFile.getLineAndCharacterOfPosition(message.getStart(sourceFile))
        rows.push({ file, line: position.line + 1, column: position.character + 1, kind: 'error-message', text,
          category: index >= 0 ? 'legacy-core-error' : 'user-visible',
          reason: index >= 0 ? coreErrorDebt[index]!.reason : 'core-error-message' })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  const staleExceptions = [
    ...coreErrorDebt.filter((_entry, index) => !usedCoreDebt.has(index))
      .map(entry => `coreErrorDebt ${entry.file} ${entry.text} matches no error message`),
    ...exceptions
      .filter((_entry, index) => !usedExceptions.has(index))
      .map((entry) => `exception ${entry.file}${entry.text === undefined ? '' : ` "${entry.text}"`} matches no CJK literal`),
    ...englishCatalogAllowed
      .filter((_entry, index) => !usedAllowed.has(index))
      .map((entry) => `englishCatalogAllowed "${entry.text}" matches no English catalog value`),
  ]

  const categories = Object.fromEntries(
    CATEGORIES.map((category) => [category, rows.filter((row) => row.category === category).length]),
  ) as Record<HardcodedCjkCategory, number>
  const fileDistribution = Object.fromEntries(
    CATEGORIES.map((category) => {
      const counts = new Map<string, number>()
      for (const row of rows.filter((candidate) => candidate.category === category)) {
        counts.set(row.file, (counts.get(row.file) ?? 0) + 1)
      }
      return [category, Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))]
    }),
  ) as Record<HardcodedCjkCategory, Record<string, number>>
  return {
    total: rows.length,
    categories,
    fileDistribution,
    rows,
    failures: rows.filter((row) => FAILING.has(row.category)),
    staleExceptions,
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const result = auditHardcodedCjk()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const row of result.failures) {
      console.error(`${row.file}:${row.line}:${row.column} [${row.category}] ${row.text}`)
    }
    for (const stale of result.staleExceptions) console.error(`stale: ${stale}`)
    console.log(`hardcoded-cjk-audit: ${JSON.stringify(result.categories)}, stale exceptions ${result.staleExceptions.length}`)
    if (result.failures.length > 0) {
      console.error('Move user-visible Chinese into the zh-CN and en-US catalogs, or list the file in scripts/checks/hardcoded-cjk-exceptions.json with its class and reason.')
    }
  }
  if (result.failures.length > 0 || result.staleExceptions.length > 0) process.exitCode = 1
}
