// Frozen source files may not grow. Size is counted on the syntax tree (statements and declarations, plus JSX
// elements), not on physical lines: squeezing statements onto one line does not hide growth, and splitting a long
// line for readability is not growth. The files and their counts live in the baseline next to this script.
//
//   node scripts/checks/frozen-file-statements.mts            fail when a file counts more than its baseline
//   node scripts/checks/frozen-file-statements.mts --write    record the current counts as the baseline
//   --root <dir>                                              read files and baseline under <dir> (tests)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const BASELINE = 'scripts/checks/frozen-file-statements-baseline.json'

const DECLARATIONS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxSelfClosingElement,
])

function counted(node: ts.Node): boolean {
  if (DECLARATIONS.has(node.kind)) return true
  // VariableStatement … DebuggerStatement; a bare `;` and braces (Block) are layout, not size.
  return node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement && node.kind !== ts.SyntaxKind.EmptyStatement
}

export function countStatements(file: string, text: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  let count = 0
  const visit = (node: ts.Node) => {
    if (counted(node)) count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

type Output = { log: (line: string) => void; error: (line: string) => void }

export function run(argv: string[], output: Output = console): number {
  const rootIndex = argv.indexOf('--root')
  const root = rootIndex >= 0 ? resolve(argv[rootIndex + 1]) : resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const baselinePath = resolve(root, BASELINE)
  if (!existsSync(baselinePath)) {
    output.error(`::error file=${BASELINE}::baseline not found`)
    return 1
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>
  const current: Record<string, number> = {}
  let failed = 0
  for (const [file, limit] of Object.entries(baseline)) {
    const absolute = resolve(root, file)
    if (!existsSync(absolute)) {
      output.error(`::error file=${file}::Frozen source is listed in ${BASELINE} but does not exist; remove it from the baseline`)
      failed = 1
      continue
    }
    const count = countStatements(file, readFileSync(absolute, 'utf8'))
    current[file] = count
    if (argv.includes('--write')) continue
    if (count > limit) {
      output.error(`::error file=${file}::Frozen source grew: ${limit} -> ${count} statements`)
      failed = 1
    } else if (count < limit) {
      output.log(`${file}: ${count} statements, below its baseline ${limit} (tighten with --write)`)
    }
  }
  if (argv.includes('--write') && !failed) writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
  return failed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2))
}
