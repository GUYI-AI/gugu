#!/usr/bin/env node
// #2062: syntax guard plus exact legacy-function debt; runtime budgets police indirect reads.
const { createHash } = require('node:crypto')
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')
const ts = require('typescript')

const ROOTS = [
  'packages/session-core/src/session-record',
  'apps/desktop/electron/session/main/core/session-timeline',
  'packages/core/src/local/agent/transcriptInventory.ts',
  'apps/desktop/electron/sessionpage/local-session-source.ts',
  'apps/desktop/electron/sessionpage/local-session-preview.ts',
]
const FORBIDDEN = new Set(['readFile', 'readFileSync', 'createReadStream', 'readFromStart', 'readSnapshot', 'readLines'])
const debt = require('./native-history-reads-debt.json')
// Immutable ceiling for the initial legacy sites; the editable ledger may only shrink.
const DEBT_CEILING = new Map([
  ["packages/session-core/src/session-record/sources/claude-jsonl.ts:readFromStart:87b30b7359b8972763d0b0ab836319d91a0791487f61eff53f52aed9592788a8", 1],
  ["packages/session-core/src/session-record/sources/claude-jsonl.ts:readFile:0508bf99ee347eff93d0591c48855c29d9f3fa7e9ee15d3244828589a3558deb", 1],
  ["packages/session-core/src/session-record/sources/claude-jsonl.ts:createReadStream:c538869da00aa6e2ad66865ccbea9dc378587f5d8c088037740a7fe055cb734a", 1],
  ["packages/session-core/src/session-record/sources/jsonl-tail-source.ts:readSnapshot:9f15eb22cce359c72936783b10d8f5adbf95c7e96a820117f152eff47c5f960a", 1],
  ["packages/session-core/src/session-record/sources/jsonl-tail-source.ts:readFromStart:9f15eb22cce359c72936783b10d8f5adbf95c7e96a820117f152eff47c5f960a", 1],
  ["packages/session-core/src/session-record/sources/tail-reader.ts:readFromStart:b2f20a3d559de5a192716f28efc31681d6812a01949932dbd204d4e3a653c20f", 1],
  ["packages/session-core/src/session-record/sources/tail-reader.ts:createReadStream:b2f20a3d559de5a192716f28efc31681d6812a01949932dbd204d4e3a653c20f", 1],
  ["packages/session-core/src/session-record/sources/tail-reader.ts:read-loop-to-eof:8cb1c033269d529adee9e3d3a852efccfa9c86534484b35bcd4de4cb1a424acf", 1],
  ["packages/session-core/src/session-record/sources/tree-jsonl.ts:readFromStart:31fd01fc0c3124d0849525e3c60d48e236b279a20f9c6566a845def9eb9f7bc5", 1],
  ["packages/session-core/src/session-record/sources/zstd-frames.ts:read-loop-to-eof:3d84b8d49e034d33fb782084efd743d40888460dc820c473d59dcc2c376918f6", 1],
  ["apps/desktop/electron/session/main/core/session-timeline/archive-store.ts:readFile:19015d28c7e6858957b9f2e190dcc553f91ce723940e7d8f8669557f3523aa2a", 1],
  ["packages/core/src/local/agent/transcriptInventory.ts:readFile:e00466b5a73cb8072cd82cfa764c419189cd094302f10e35c5c402a6feb6b32d", 1],
])
function validateDebt(entries) {
  const seen = new Set()
  for (const [key, count] of entries) {
    if (seen.has(key) || !Number.isSafeInteger(count) || count < 0 || count > (DEBT_CEILING.get(key) || 0) || !DEBT_CEILING.has(key)) {
      throw new Error(`Legacy history-read debt may only shrink: ${key}`)
    }
    seen.add(key)
  }
}
validateDebt(debt)


function name(node) {
  if (!node) return ''
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return name(node.name)
  if (ts.isElementAccessExpression(node)) return name(node.argumentExpression)
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return name(node.expression)
  return ''
}
function owner(node, source) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at) && at.body) return at.getText(source)
  }
  return node.getText(source)
}
function analyze(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const options = { noLib: true, noResolve: true, allowJs: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = path => path === file ? source : undefined
  const checker = ts.createProgram([file], options, host).getTypeChecker()
  const findings = []
  function resolveName(node, seen = new Set()) {
    if (seen.has(node)) return ''
    seen.add(node)
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0]
      if (declaration && ts.isImportSpecifier(declaration)) return name(declaration.propertyName || declaration.name)
      if (declaration && ts.isBindingElement(declaration)) return name(declaration.propertyName || declaration.name)
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return resolveName(declaration.initializer, seen)
    }
    return name(node)
  }
  function callName(node) { return resolveName(node.expression) }
  function hasRead(node) {
    if (ts.isCallExpression(node) && /^(read|readSync)$/.test(callName(node))) return true
    return !!ts.forEachChild(node, child => hasRead(child) || undefined)
  }
  function visits(node) {
    let rule
    if (ts.isCallExpression(node) && FORBIDDEN.has(callName(node))) rule = callName(node)
    if ((ts.isWhileStatement(node) || ts.isForStatement(node)) && hasRead(node.statement)) {
      const condition = ts.isWhileStatement(node) ? node.expression : node.condition
      if (condition && /\b(size|fileSize|sourceSize|eof)\b|^true$/.test(condition.getText(source))) rule = 'read-loop-to-eof'
    }
    if (rule) {
      const fingerprint = createHash('sha256').update(owner(node, source)).digest('hex')
      const key = `${file}:${rule}:${fingerprint}`
      findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, key })
    }
    ts.forEachChild(node, visits)
  }
  visits(source)
  return findings
}
function scan(root) {
  const findings = []
  function walk(path) {
    if (!existsSync(path)) return
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isFile()) walk(join(path, entry.name))
      }
    } else if (/\.[cm]?[jt]sx?$/.test(path) && !/\.(test|spec|node-test)\./.test(path)) {
      findings.push(...analyze(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')))
    }
  }
  for (const path of ROOTS) walk(join(root, path))
  return findings
}
function violations(root) {
  // Multiplicity matters: copying an unchanged legacy function must not create another exemption.
  const remaining = new Map(debt.map(([key, count]) => [key, count]))
  return scan(root).filter(finding => {
    const left = remaining.get(finding.key) || 0
    if (!left) return true
    remaining.set(finding.key, left - 1)
    return false
  })
}
module.exports = { ROOTS, analyze, scan, violations, validateDebt }
if (require.main === module) {
  const found = violations(resolve(__dirname, '../..'))
  for (const { file, line, rule } of found) process.stderr.write(`${file}:${line}: forbidden history read (${rule}); use a bounded positional reader\n`)
  process.exitCode = found.length ? 1 : 0
}
